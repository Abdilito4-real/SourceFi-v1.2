-- 0017_orders_rls_pilot.sql
--
-- The first REAL RLS policies in this project. Every table already had
-- `enable row level security` with zero policies (a deliberate default-
-- deny backstop against key misuse, see 0000_fresh_project_full_schema.sql's
-- own comment on that block) — but that was never an active access-
-- control layer, because this app's Supabase client has always
-- authenticated as service_role, which bypasses RLS entirely regardless
-- of policy. lib/supabaseUserClient.ts is the new piece that makes these
-- policies actually reachable: a per-request client authenticated as
-- `authenticated` (via a minted JWT carrying the caller's real
-- users.id), used ONLY for the `orders` reads in app/api/orders/**'s GET
-- handlers, not the whole app. See docs/security.md's RLS section and
-- the plan this implements for the full reasoning.
--
-- IMPORTANT: do not use auth.uid() in these policies. It casts its
-- claim to uuid and ERRORS on anything else; this app's identity is
-- users.id, a bigint, not a UUID. current_app_user_id() below reads a
-- CUSTOM claim (user_row_id) instead, which lib/supabaseUserClient.ts
-- mints specifically for this.
create or replace function current_app_user_id() returns bigint as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'user_row_id', '')::bigint;
$$ language sql stable;

-- The hard dependency: the orders policy below subqueries
-- supplier_profiles to map a supplier's own users.id to their
-- supplier_profiles.id. Without this companion policy, that subquery
-- would run under the SAME `authenticated` role and hit
-- supplier_profiles's own (until now unreachable) RLS-enabled-zero-
-- policies, silently returning nothing — breaking every supplier's
-- order visibility, not protecting it. Self-only, matches what every
-- supplier-facing route already restricts this table to anyway (e.g.
-- GET /api/supplier-verification/me).
create policy supplier_profiles_select_own on supplier_profiles
  for select to authenticated
  using (user_id = current_app_user_id());

-- Mirrors GET /api/orders's existing in-application filter exactly
-- (buyer sees their own orders, supplier sees orders assigned to them)
-- — this is the second, independent layer behind that check, not a
-- replacement for it (the app-layer check stays, see the route files).
-- Admin's "no filter, full oversight" behavior deliberately has NO
-- policy here: admin reads stay on the service-role client, unchanged,
-- exactly as before this migration.
create policy orders_select_own on orders
  for select to authenticated
  using (
    buyer_id = current_app_user_id()
    or supplier_id in (select id from supplier_profiles where user_id = current_app_user_id())
  );

-- Unrelated to the identity bridge above, but a real gap in the same
-- "RLS hardening" category worth closing while touching this area:
-- migration 0016 added these two tables without an `enable row level
-- security` statement at all, unlike every other table in this schema.
-- No policies needed (they're only ever touched via the rl_* functions
-- under service-role, never queried directly by any route), this just
-- brings them in line with every other table's default-deny posture.
alter table rate_limit_buckets enable row level security;
alter table quota_buckets enable row level security;
