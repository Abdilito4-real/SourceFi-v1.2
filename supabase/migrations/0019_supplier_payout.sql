-- 0019_supplier_payout.sql
--
-- Real Yellow Card integration, part 2: their "Submit Send Request"
-- (the supplier-payout leg, /business/send — confirmed directly against
-- docs.yellowcard.engineering's reference and "Making a Send" guide, not
-- guessed, same rigor as buyer_kyc's Receive integration) needs a real
-- destination bank account on file. Mirrors buyer_kyc_profiles' shape and
-- posture exactly: one row per user, owner-only, collected once, no
-- admin review step (this isn't a role grant, just payout data).
--
-- IMPORTANT, this is a hard requirement, not an optional nice-to-have
-- like supplier_verification_applications.supporting_document_url: a
-- supplier with no payout profile on file shouldn't be payable at all
-- once a real Send integration exists. Enforced today at ONE point —
-- app/api/supplier-verification/route.ts refuses a new application
-- without it, this migration's whole reason for existing. The SECOND
-- layer (a MissingSupplierPayoutProfileError-style re-check inside the
-- actual payout call itself, same "clean domain error before the call
-- reaches the payment provider" pattern MissingBuyerKycError already
-- established) is NOT built yet — there is no real Send call at all
-- yet, see docs/payment-integration.md's settlement section for why
-- (pending confirming Yellow Card's crypto top-up supports Arc Testnet,
-- once sandbox credentials exist).
--
-- Not made a DB-level NOT NULL column on supplier_profiles: that would
-- break every already-verified supplier row from before this migration.
-- A separate table, enforced at the application-submission layer for
-- every NEW or re-verification application going forward, is the same
-- non-breaking pattern buyer_kyc_profiles already uses.
--
-- Field-name note: bank_name and account_name are supplier-facing free
-- text (a supplier knows their own bank's name and account holder name,
-- no live API needed to collect these). bank_network_id is Yellow
-- Card's OWN internal bank code (from GET /business/networks), which a
-- supplier has no way to know off the top of their head — deliberately
-- left nullable here and resolved server-side (by name-matching against
-- the live networks list, or via the Resolve Bank Account endpoint) once
-- real Yellow Card sandbox credentials exist to call that endpoint
-- against. Flagged in lib/yellowCardProvider.ts, not guessed.
create table if not exists supplier_payout_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  bank_name text not null,
  account_number text not null,
  account_name text not null,
  bank_network_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_supplier_payout_profiles_user_id on supplier_payout_profiles (user_id);

drop trigger if exists trg_supplier_payout_profiles_updated_at on supplier_payout_profiles;
create trigger trg_supplier_payout_profiles_updated_at
  before update on supplier_payout_profiles
  for each row execute function set_updated_at();

alter table supplier_payout_profiles enable row level security;

-- Same posture as buyer_kyc_profiles_select_own (migration 0018):
-- self-only, no admin-read policy, extends the real RLS pilot rather
-- than leaving a new PII/financial table on default-deny-only.
create policy supplier_payout_profiles_select_own on supplier_payout_profiles
  for select to authenticated
  using (user_id = current_app_user_id());

-- Mirrored onto supplier_profiles at verification-approval time (same
-- copy pattern app/api/admin/supplier-verification/[id]/route.ts already
-- uses for business_name/cac_registration_number/etc.), so the payout
-- call at release time reads from the SAME row it already queries for
-- everything else about a supplier, rather than an extra join every
-- time. Nullable here on purpose: existing pre-migration supplier_profiles
-- rows have none of this, and that's fine, they simply can't be paid out
-- via the real Send integration until they re-verify (this table's
-- own application-submission gate is what actually enforces "mandatory
-- going forward").
alter table supplier_profiles add column if not exists payout_bank_name text;
alter table supplier_profiles add column if not exists payout_account_number text;
alter table supplier_profiles add column if not exists payout_account_name text;
alter table supplier_profiles add column if not exists payout_bank_network_id text;
