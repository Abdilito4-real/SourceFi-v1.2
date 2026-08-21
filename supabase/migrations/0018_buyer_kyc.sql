-- 0018_buyer_kyc.sql
--
-- Real Yellow Card integration, part 1: their "Submit Receive Request"
-- (the funding leg) requires a `recipient` object with the buyer's
-- full name, phone, date of birth, government ID type/number, and
-- address — none of which `users` stores today. This table is the new
-- prerequisite a buyer completes once before their first funding
-- action (gated in lib/orderService.ts's fundOrder), same
-- self-service shape as supplier_profiles (one row per user, owner-only
-- read/write, no admin review step needed here since this isn't a
-- role grant, just data collection).
--
-- Field-name note: Yellow Card's docs describe the recipient object's
-- required fields in prose (name, phone, email, country, address, dob,
-- idNumber, idType) but the interactive schema panel for the exact
-- nested shape didn't fully expand during research — first_name/
-- last_name (concatenated when building the actual request) is the
-- safer, more standard shape than guessing at a single combined `name`
-- field. Confirm against Yellow Card's sandbox once real credentials
-- exist, before the first real funding attempt, see
-- docs/payment-integration.md.
create table if not exists buyer_kyc_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  first_name text not null,
  last_name text not null,
  phone text not null,
  date_of_birth date not null,
  id_type text not null,
  id_number text not null,
  address text not null,
  country text not null default 'NG',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_buyer_kyc_profiles_user_id on buyer_kyc_profiles (user_id);

drop trigger if exists trg_buyer_kyc_profiles_updated_at on buyer_kyc_profiles;
create trigger trg_buyer_kyc_profiles_updated_at
  before update on buyer_kyc_profiles
  for each row execute function set_updated_at();

alter table buyer_kyc_profiles enable row level security;

-- Extends the real RLS pilot (migration 0017) rather than leaving a new
-- PII table on the old default-deny-only posture: self-only, mirrors
-- supplier_profiles_select_own exactly. No admin-read policy needed,
-- there is no admin review step for this table (see this file's header).
create policy buyer_kyc_profiles_select_own on buyer_kyc_profiles
  for select to authenticated
  using (user_id = current_app_user_id());
