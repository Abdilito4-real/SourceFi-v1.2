-- fresh_0001_sourcer_applications.sql
--
-- Follow-up to 0000_fresh_project_full_schema.sql (the "fresh_" prefix is
-- deliberate: that file already ran against the live database, so this is
-- an additive migration on top of it, not an edit to it — and it avoids
-- colliding with the ORIGINAL project's own 0001_stage4_auth.sql /
-- 0002_stage5_data_layer.sql, a completely separate lineage that also
-- lives in this folder. Run this only against the project that already
-- has 0000_fresh_project_full_schema.sql applied.
--
-- What this adds: the sourcer role stops being unreachable-in-practice.
-- Before this, granting it required an admin manually crafting a
-- PATCH /api/admin/users/[id]/role call with no application behind it —
-- fine for a first vetting pass, not a real workflow. This table is where
-- "I want to become a sourcing partner" lands: a real request an admin
-- reviews and approves or rejects, never a self-service role change.
-- CLAUDE.md's rule is unchanged by this file — "a user cannot self-assign
-- [the sourcer role]" — submitting a row here grants nothing by itself.
create table if not exists sourcer_applications (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  location text,
  experience text,
  reason text,
  reviewed_by bigint references users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One pending application per user at a time — the API also checks this
-- before insert, but the constraint is what actually guarantees it under
-- concurrent submits.
create unique index if not exists idx_sourcer_applications_one_pending_per_user
  on sourcer_applications (user_id)
  where status = 'pending';

create index if not exists idx_sourcer_applications_status on sourcer_applications (status);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sourcer_applications_updated_at on sourcer_applications;
create trigger trg_sourcer_applications_updated_at
  before update on sourcer_applications
  for each row execute function set_updated_at();

alter table sourcer_applications enable row level security;
-- Same posture as every other table in this project: RLS is a default-deny
-- backstop, not the real gate — this app's Supabase client always
-- authenticates as service_role (see lib/supabaseServer.ts), which
-- bypasses RLS by design. The actual boundary is requireRole(["admin"])
-- server-side on the review endpoint.
