-- 0009_push_notifications.sql
--
-- Prompt 2 (push notifications) of the feedback/notifications/security
-- prompt pack. Web Push subscription storage, per-category preferences +
-- quiet hours, and the in-app notification centre, the last of which is
-- the part that has to stay correct even if push never arrives at all
-- (see lib/notifications/dispatch.ts). Same idempotent style as every
-- migration before this one: create/if-not-exists + do $$ ... $$ guarded
-- constraints, safe to re-run.

-- ============================================================================
-- push_subscriptions, one row per (user, device). A user can have several
-- (phone + laptop, two browsers, etc.), never assume one.
-- ============================================================================
create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  -- Display-only, for a user managing their own devices in the
  -- preferences screen ("iPhone, Safari" vs "this device"), never used
  -- for anything security-relevant.
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'push_subscriptions_endpoint_key') then
    -- The push endpoint URL itself is what a browser considers a unique
    -- subscription identity, re-subscribing the same device replaces its
    -- row rather than accumulating duplicates (see the upsert in
    -- app/api/push/subscribe/route.ts).
    alter table push_subscriptions add constraint push_subscriptions_endpoint_key unique (endpoint);
  end if;
end $$;

create index if not exists idx_push_subscriptions_user_id on push_subscriptions (user_id);

-- ============================================================================
-- notification_preferences, one row per user. Independently toggleable
-- channels per the feedback-layer rule, EXCEPT security/account alerts,
-- which are not opt-out, there is deliberately no column for that
-- category here. lib/notifications/dispatch.ts never checks a preference
-- for 'security' at all, not "checks it and ignores a false value."
-- ============================================================================
create table if not exists notification_preferences (
  user_id bigint primary key references users(id) on delete cascade,
  job_availability boolean not null default true,
  escrow_payment boolean not null default true,
  audit_status boolean not null default true,
  disputes boolean not null default true,
  -- Defaults to Nigeria (CLAUDE.md: primary user base), overridable per
  -- user. Used only for computing local quiet hours below; never used for
  -- money/date-of-record purposes.
  timezone text not null default 'Africa/Lagos',
  quiet_hours_start_local smallint not null default 21 check (quiet_hours_start_local between 0 and 23),
  quiet_hours_end_local smallint not null default 7 check (quiet_hours_end_local between 0 and 23),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_notification_preferences_updated_at on notification_preferences;
create trigger trg_notification_preferences_updated_at
  before update on notification_preferences
  for each row execute function set_updated_at();

-- ============================================================================
-- notifications, the in-app notification centre. ALWAYS written for
-- every push-worthy event, independent of whether a push was ever
-- attempted or delivered, this table is the part of the system that
-- stays correct if push never arrives (feedback-layer rule).
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_category') then
    create type notification_category as enum (
      'job_availability', 'escrow_payment', 'audit_status', 'disputes', 'security'
    );
  end if;
end $$;

-- `notifications` already exists as a schema-only placeholder from
-- 0000/0002 ("nothing writes to this yet"), with a completely different
-- shape (type/related_request_id instead of category/event_type/
-- pushed_at). `create table if not exists` would silently keep that old
-- shape and every column below would be missing, drop and recreate
-- instead: the old table was confirmed never written to by any app code,
-- so there's no data to preserve.
drop table if exists notifications;

create table notifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id) on delete cascade,
  category notification_category not null,
  event_type text not null,
  resource_type text,
  resource_id bigint,
  -- title/body are the SAFE, lock-screen-safe display strings computed by
  -- the caller (lib/notifications/dispatch.ts's callers in
  -- lib/orderService.ts etc), never a raw amount, wallet address, or full
  -- name. Same payload this table's rows also become the push body for.
  title text not null,
  body text not null,
  deep_link text,
  -- Collapse key for push (a same-tag push replaces a prior one instead
  -- of stacking, feedback-layer rule), also handy here for finding "the
  -- latest notification about this exact thing."
  tag text,
  read_at timestamptz,
  -- Null until an actual push send is attempted for this row (skipped by
  -- an opted-out preference, quiet hours, or the rate limit all leave
  -- this null while the row itself still exists), see dispatch.ts.
  pushed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_unread on notifications (user_id, read_at);
create index if not exists idx_notifications_user_created on notifications (user_id, created_at desc);
-- Rate-limit and quiet-hours bookkeeping both count/inspect rows by
-- (user_id, pushed_at) within a trailing window, see dispatch.ts.
create index if not exists idx_notifications_user_pushed on notifications (user_id, pushed_at);

-- Same posture as every other table in this schema: RLS enabled with zero
-- policies (default-deny backstop), the service-role client this app
-- uses bypasses RLS by design, real per-user visibility is enforced in
-- the API route layer (requireRole + an explicit user_id match), not here.
alter table push_subscriptions enable row level security;
alter table notification_preferences enable row level security;
alter table notifications enable row level security;
