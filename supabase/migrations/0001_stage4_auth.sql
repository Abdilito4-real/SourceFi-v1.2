-- 0001_stage4_auth.sql
--
-- Stage 4 (auth and roles). Run this against your Supabase project's SQL
-- editor (or via `supabase db push` if you've adopted the CLI) before
-- deploying the Stage 4 code. There is no formal migrations runner wired
-- up yet, Stage 5 (data layer) is where a real schema/migration story
-- gets built; this file exists now because Stage 4 can't ship without it.
--
-- Idempotent: safe to re-run. Assumes the `users` and `requests` tables
-- already exist in the shape app/api/escrow/route.ts and
-- app/api/requests/**/route.ts have always read/written (id, email,
-- username, wallet_address, wallet_id, wallet_set_id, funding_password,
-- funding_password_reset_at), this migration only adds to that.

-- ---------------------------------------------------------------------------
-- users: add role + the verified Privy identity we now key sessions on
-- ---------------------------------------------------------------------------
alter table users
  add column if not exists role text not null default 'buyer';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_role_check'
  ) then
    alter table users
      add constraint users_role_check check (role in ('buyer', 'sourcer', 'admin'));
  end if;
end $$;

-- The authoritative link to a verified Privy session (their DID, e.g.
-- "did:privy:clxxxxxxx..."). Server-verified once per session via
-- @privy-io/node, see lib/privyServer.ts, never client-supplied.
-- Nullable: existing rows created before Stage 4 won't have one until
-- their next login re-establishes a session.
alter table users
  add column if not exists privy_user_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_privy_user_id_key'
  ) then
    alter table users
      add constraint users_privy_user_id_key unique (privy_user_id);
  end if;
end $$;

create index if not exists idx_users_privy_user_id on users (privy_user_id);
create index if not exists idx_users_role on users (role);

-- ---------------------------------------------------------------------------
-- audit_log: who did what, when, from where. Written by lib/authz.ts's
-- logAudit() on every role change and admin action.
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor_email text not null,
  action text not null,
  target text,
  details jsonb,
  ip text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_actor_email on audit_log (actor_email);
create index if not exists idx_audit_log_created_at on audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- Bootstrapping the first admin
--
-- There is deliberately no self-service or API path to become an admin
-- that's the whole point of removing the old hardcoded-password "Sourcer
-- Access" gate. The very first admin has to be set directly in the
-- database. Replace the email below and run once:
--
--   update users set role = 'admin' where email = 'you@example.com';
--
-- Every admin after that is granted via PATCH /api/admin/users/[id]/role
-- by an existing admin, and it's audit-logged.
-- ---------------------------------------------------------------------------
