-- 0003_align_sourcing_requests.sql
--
-- Follow-up to 0001_stage4_auth.sql + 0002_stage5_data_layer.sql for the
-- ORIGINAL project — the one .env.local actually points at. Rather than
-- keep juggling a second, separate empty Supabase project just to get the
-- clean schema, this brings THIS project's sourcing_requests table the
-- rest of the way to the same shape 0000_fresh_project_full_schema.sql
-- defines, in place.
--
-- 0002 deliberately left buyer_email/sourcer_email/sourcing_fee/budget/
-- evidence in place "until the wiring phase cuts over" — that phase is
-- done (see app/api/requests/route.ts, app/api/escrow/route.ts), nothing
-- reads or writes those columns anymore. buyer_email being NOT NULL on a
-- column the app never populates is exactly what's been throwing
-- "null value in column buyer_email... violates not-null constraint" on
-- every new request.
--
-- Idempotent — safe to re-run.

-- ============================================================================
-- 1. Re-run the buyer_id/sourcer_id backfill from 0002, in case any rows
--    were ever written since then through a path that only set the email
--    columns. Harmless no-op if there are none.
-- ============================================================================
update sourcing_requests sr
set buyer_id = u.id
from users u
where sr.buyer_email = u.email and sr.buyer_id is null;

update sourcing_requests sr
set sourcer_id = u.id
from users u
where sr.sourcer_email is not null and sr.sourcer_email = u.email and sr.sourcer_id is null;

-- ============================================================================
-- 2. Add the columns 0002 never added — the app has been writing to these
--    since the dashboard rewrite (invite-to-video-call, sourcer payout
--    clearance) and they don't exist here yet.
-- ============================================================================
alter table sourcing_requests add column if not exists invite_sent_at timestamptz;
alter table sourcing_requests add column if not exists cleared_by_sourcer boolean not null default false;
alter table sourcing_requests add column if not exists cleared_at timestamptz;

-- ============================================================================
-- 3. Drop the deprecated columns. Confirmed nothing in the app reads or
--    writes sourcing_requests.buyer_email/sourcer_email/sourcing_fee/
--    budget/evidence directly — buyer_email/sourcer_email in API
--    responses are computed via a join against `users`, not read from
--    these columns (see app/api/requests/route.ts).
--
--    buyer_id/budget_minor are deliberately left NULLABLE here rather than
--    forced NOT NULL like the fresh schema — some pre-wiring test rows may
--    still have no matching buyer_id (no user row to backfill from) or no
--    budget_minor (the old `budget` column was freeform text, never
--    reliably parseable — see 0002's own comment on why it was never
--    backfilled). Forcing NOT NULL would delete or block on that old data;
--    every write path in the app already always supplies both, so the
--    constraint isn't needed for correctness, only for enforcement.
-- ============================================================================
alter table sourcing_requests drop column if exists buyer_email;
alter table sourcing_requests drop column if exists sourcer_email;
alter table sourcing_requests drop column if exists sourcing_fee;
alter table sourcing_requests drop column if exists budget;
alter table sourcing_requests drop column if exists evidence;
