-- 0016_rate_limiting.sql
--
-- Part 3 of the production-hardening pass: moves lib/rateLimit.ts off an
-- in-memory Map (documented in that file's own header comment as
-- resetting on every serverless cold start, and never shared across
-- instances) onto these two tables plus atomic RPC functions, following
-- the same shape as the existing is_supplier_currently_verified()
-- function (0004_marketplace_pivot.sql) — the one precedent in this
-- codebase for a callable Postgres function backing application logic.
--
-- Two independent bucket shapes, matching the two independent in-memory
-- algorithms this replaces (see lib/rateLimit.ts's own module comment
-- for why they're deliberately different):
--   rate_limit_buckets: failure-streak + exponential backoff (login/
--     session/admin-action lockouts, checkRateLimit/recordFailure/
--     recordSuccess).
--   quota_buckets: plain fixed-window request counter, every call
--     counts regardless of outcome (dispute-filing/termination routes,
--     checkDualQuota).
create table if not exists rate_limit_buckets (
  key text primary key,
  failure_count int not null default 0,
  first_failure_at timestamptz not null default now(),
  locked_until timestamptz
);

create table if not exists quota_buckets (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

-- Pure read, no side effect, mirrors checkRateLimit()'s "does not itself
-- count as an attempt" contract exactly.
create or replace function rl_check_rate_limit(p_key text)
returns table(allowed boolean, retry_after_seconds int) as $$
declare
  v_locked_until timestamptz;
begin
  select locked_until into v_locked_until from rate_limit_buckets where key = p_key;
  if v_locked_until is not null and v_locked_until > now() then
    return query select false, ceil(extract(epoch from (v_locked_until - now())))::int;
    return;
  end if;
  return query select true, null::int;
end;
$$ language plpgsql stable;

-- Atomic read-modify-write, same exponential-backoff math as the
-- in-memory recordFailure() it replaces. Ensures the row exists (a
-- no-op insert) BEFORE the `select ... for update`, so the row lock
-- below serializes concurrent failures for the same key from the very
-- first one, not just the second-and-later ones, closing the gap a bare
-- "select then insert-or-update" would leave open.
create or replace function rl_record_failure(
  p_key text,
  p_window_ms bigint,
  p_base_lockout_ms bigint,
  p_max_lockout_ms bigint,
  p_lockout_after int
) returns timestamptz as $$
declare
  v_now timestamptz := now();
  v_first_failure_at timestamptz;
  v_failure_count int;
  v_locked_until timestamptz;
  v_exponent int;
  v_lockout_ms bigint;
begin
  insert into rate_limit_buckets (key, failure_count, first_failure_at, locked_until)
  values (p_key, 0, v_now, null)
  on conflict (key) do nothing;

  select first_failure_at, failure_count into v_first_failure_at, v_failure_count
  from rate_limit_buckets where key = p_key for update;

  -- Window expired since the first failure: start counting fresh rather
  -- than let a stale streak compound into today's lockout, same rule
  -- the in-memory version applied.
  if (extract(epoch from (v_now - v_first_failure_at)) * 1000) >= p_window_ms then
    v_first_failure_at := v_now;
    v_failure_count := 0;
  end if;

  v_failure_count := v_failure_count + 1;

  if v_failure_count > p_lockout_after then
    v_exponent := v_failure_count - p_lockout_after - 1;
    v_lockout_ms := least(p_base_lockout_ms * power(2, v_exponent)::bigint, p_max_lockout_ms);
    v_locked_until := v_now + (v_lockout_ms || ' milliseconds')::interval;
  else
    v_locked_until := null;
  end if;

  update rate_limit_buckets
    set failure_count = v_failure_count, first_failure_at = v_first_failure_at, locked_until = v_locked_until
    where key = p_key;

  return v_locked_until;
end;
$$ language plpgsql;

create or replace function rl_record_success(p_key text) returns void as $$
  delete from rate_limit_buckets where key = p_key;
$$ language sql;

-- Atomic fixed-window increment, mirrors checkQuota()/checkDualQuota()'s
-- in-memory logic: every call counts (success or failure), a call past
-- the window resets the counter instead of blocking forever. Same
-- ensure-row-then-lock pattern as rl_record_failure above.
create or replace function rl_check_quota(p_key text, p_max_per_window int, p_window_ms bigint)
returns table(allowed boolean, retry_after_seconds int) as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count int;
begin
  insert into quota_buckets (key, window_start, count)
  values (p_key, v_now, 0)
  on conflict (key) do nothing;

  select window_start, count into v_window_start, v_count
  from quota_buckets where key = p_key for update;

  if (extract(epoch from (v_now - v_window_start)) * 1000) >= p_window_ms then
    v_window_start := v_now;
    v_count := 0;
  end if;

  if v_count >= p_max_per_window then
    update quota_buckets set window_start = v_window_start, count = v_count where key = p_key;
    return query select false, ceil(extract(epoch from (v_window_start + (p_window_ms || ' milliseconds')::interval - v_now)))::int;
    return;
  end if;

  v_count := v_count + 1;
  update quota_buckets set window_start = v_window_start, count = v_count where key = p_key;
  return query select true, null::int;
end;
$$ language plpgsql;
