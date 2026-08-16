-- 0004_marketplace_pivot.sql
--
-- Implements the approved design in docs/marketplace-payments-design.md.
-- Run this AFTER whichever lineage you're on (0000_fresh_project_full_schema.sql,
-- OR 0001_stage4_auth.sql + 0002_stage5_data_layer.sql + 0003_align_sourcing_requests.sql)
-- PLUS fresh_0001_sourcer_applications.sql either way — same as every migration
-- before it, both lineages converge to the same end state this file assumes.
--
-- What this does, in one sentence: retires the "sourcer visits a supplier on
-- the buyer's behalf, per transaction" model and replaces it with suppliers
-- as first-class, once-verified platform accounts that fulfill orders and
-- get paid directly. See docs/marketplace-payments-design.md Section 0 for
-- why this is a pivot, not a rename, and Section J for the open decisions
-- this migration encodes a specific (documented, reversible-in-code) answer
-- for: platform fee kept on a buyer-ruled refund is NOT decided by this
-- migration (that's application-layer logic, not schema) — flagged again
-- here so it isn't missed.
--
-- Deliberately NOT destructive: sourcing_requests, sourcer_profiles,
-- sourcer_applications, audit_reports, and the old passive `suppliers`
-- table are RENAMED with a `deprecated_` prefix, not dropped. There's a
-- live demo at sourcefi.vercel.app; this preserves whatever's in there
-- rather than assuming it's disposable. Drop them for real in a later,
-- separate cleanup migration once you've confirmed nothing needs them.
--
-- Idempotent where practical, matching the style of every migration before
-- this one — safe to re-run.

-- ============================================================================
-- 1. Role: sourcer -> supplier
--
-- Order matters here and previously didn't: the UPDATE has to run AFTER
-- the old constraint (role in ('buyer','sourcer','admin')) is dropped,
-- not before — 'supplier' isn't a legal value under the old constraint,
-- so updating rows to it while that constraint is still in force trips
-- users_role_check on the very first row touched. Caught via a real
-- failed run against a live Supabase project, not just review.
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'users_role_check') then
    alter table users drop constraint users_role_check;
  end if;
end $$;

update users set role = 'supplier' where role = 'sourcer';

alter table users add constraint users_role_check check (role in ('buyer', 'supplier', 'admin'));

-- ============================================================================
-- 2. Rename the old, passive per-transaction tables out of the way.
--    Preserved, not dropped — see header.
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'sourcing_requests') then
    alter table sourcing_requests rename to deprecated_sourcing_requests;
  end if;
  if exists (select 1 from information_schema.tables where table_name = 'sourcer_profiles') then
    alter table sourcer_profiles rename to deprecated_sourcer_profiles;
  end if;
  if exists (select 1 from information_schema.tables where table_name = 'sourcer_applications') then
    alter table sourcer_applications rename to deprecated_sourcer_applications;
  end if;
  if exists (select 1 from information_schema.tables where table_name = 'audit_reports') then
    alter table audit_reports rename to deprecated_audit_reports;
  end if;
  -- The OLD passive suppliers table (name/CAC/location/verified boolean,
  -- never a users row, never paid directly) — superseded by
  -- supplier_profiles below, which IS a users row. Renamed, not merged:
  -- the two shapes aren't compatible enough to auto-migrate rows
  -- responsibly (no user_id to attach old rows to), and per the demo note
  -- above, preserved rather than assumed disposable.
  if exists (select 1 from information_schema.tables where table_name = 'suppliers') then
    alter table suppliers rename to deprecated_suppliers_no_account;
  end if;
end $$;

-- disputes stays — nothing has ever written to it (README confirms "no
-- dispute path exists"), so there's no data to preserve, and its shape is
-- extended in place in Section 6 below rather than renamed+recreated.

-- ============================================================================
-- 3. supplier_profiles — a supplier IS a users row (role = 'supplier') with
--    this profile attached. Verification lifecycle lives here.
-- ============================================================================
create table if not exists supplier_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  business_name text not null,
  cac_registration_number text,
  business_location text not null,
  what_they_sell text not null,
  phone text,
  address text,

  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'pending', 'verified', 'expired')),
  verified_at timestamptz,
  verified_by bigint references users(id),
  verification_expires_at timestamptz,
  -- Increments when an order involving this supplier reaches `funded`
  -- (app-layer responsibility, Stage 2 of this rework) — resets to 0 at
  -- each (re)verification approval.
  orders_since_verification integer not null default 0,

  wallet_address text,
  wallet_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists idx_supplier_profiles_user_id on supplier_profiles (user_id) where deleted_at is null;
create index if not exists idx_supplier_profiles_status on supplier_profiles (verification_status);

drop trigger if exists trg_supplier_profiles_updated_at on supplier_profiles;
create trigger trg_supplier_profiles_updated_at
  before update on supplier_profiles
  for each row execute function set_updated_at();

-- Single source of truth for "is this supplier allowed to receive a
-- funded order right now" — computed live from the two expiry conditions
-- (90 days OR 20 orders, whichever comes first), never just the cached
-- verification_status column alone. See design doc Section D.2 for why:
-- a scheduled job keeps verification_status roughly in sync for display,
-- but the actual authorization gate (checked at order-creation AND again
-- at order-funding time) always calls this function, not the column.
create or replace function is_supplier_currently_verified(p_supplier_id bigint)
returns boolean as $$
  select coalesce(
    (
      select verification_status = 'verified'
        and verification_expires_at is not null
        and now() <= verification_expires_at
        and orders_since_verification < 20
      from supplier_profiles
      where id = p_supplier_id
        and deleted_at is null
    ),
    false
  );
$$ language sql stable;

-- What a verified supplier is understood to produce/sell, structured (in
-- addition to the free-text what_they_sell) — lets buyers filter the
-- supplier directory by material.
create table if not exists supplier_materials (
  supplier_id bigint not null references supplier_profiles(id),
  material_id bigint not null references materials(id),
  primary key (supplier_id, material_id)
);

-- ============================================================================
-- 4. supplier_verification_applications — repurposed sourcer_applications.
--    Same admin-review shape (pending/approved/rejected, one-pending-per-
--    user, reviewed_by/reviewed_at/review_notes, compare-and-swap in the
--    API layer), different fields, different consequence on approval (see
--    Section F of the design doc — approval creates/updates a full
--    supplier_profiles row with verification metadata, not just a role
--    flip).
-- ============================================================================
create table if not exists supplier_verification_applications (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  business_name text not null,
  cac_registration_number text,
  business_location text not null,
  what_they_sell text not null,
  supporting_document_url text,
  reviewed_by bigint references users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Covers both first-time verification AND re-verification after expiry —
-- same table, same one-pending-per-user rule either way.
create unique index if not exists idx_supplier_verif_apps_one_pending_per_user
  on supplier_verification_applications (user_id) where status = 'pending';
create index if not exists idx_supplier_verif_apps_status on supplier_verification_applications (status);

drop trigger if exists trg_supplier_verif_apps_updated_at on supplier_verification_applications;
create trigger trg_supplier_verif_apps_updated_at
  before update on supplier_verification_applications
  for each row execute function set_updated_at();

-- ============================================================================
-- 5. orders — supersedes sourcing_requests. Buyer orders directly against
--    a specific, currently-verified supplier; no claim/fee-naming step.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum (
      'pending_payment', 'payment_processing', 'payment_failed',
      'converting', 'escrow_depositing', 'funded',
      'fulfilling', 'proof_submitted',
      'buyer_approved', 'release_submitted', 'release_processing', 'escrow_released',
      'settlement_processing', 'settled',
      'rejected', 'disputed',
      'refund_processing', 'refunded',
      'cancelled', 'expired'
    );
  end if;
end $$;

create table if not exists orders (
  id bigint generated always as identity primary key,
  order_code text not null,
  status order_status not null default 'pending_payment',

  buyer_id bigint not null references users(id),
  supplier_id bigint not null references supplier_profiles(id),
  material_id bigint references materials(id),

  title text not null,
  description text,
  quantity text,
  delivery_location text not null,

  -- Buyer-facing amount is always NGN (see design doc Section 3 — the
  -- buyer never interacts with USDC directly). USDC amounts live on
  -- payment_events/ledger_entries rows, computed at funding/settlement
  -- time from whatever rate the payment layer reports.
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  platform_fee_minor bigint not null default 0,

  -- Audit trail snapshot only — NOT the authorization check. The real
  -- check is is_supplier_currently_verified(), called live at both
  -- order-creation and order-funding time.
  supplier_verified_at_order_time timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists idx_orders_order_code on orders (order_code);
create index if not exists idx_orders_status on orders (status);
create index if not exists idx_orders_buyer_id on orders (buyer_id);
create index if not exists idx_orders_supplier_id on orders (supplier_id);
create index if not exists idx_orders_created_at on orders (created_at desc);

drop trigger if exists trg_orders_updated_at on orders;
create trigger trg_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- ============================================================================
-- 6. payment_events — the fine-grained async trail for both the funding
--    leg (NGN -> USDC -> escrow) and the release leg (approval -> transfer
--    -> confirmation), per design doc Section C.4. Distinct from
--    orders.status (coarse, user-facing) and ledger_entries (accounting).
-- ============================================================================
create table if not exists payment_events (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  leg text not null check (leg in ('funding', 'release', 'settlement', 'refund')),
  provider text not null check (provider in ('yellow_card', 'circle')),
  provider_reference text,
  event_type text not null,
  provider_state text,
  -- Only ever set from a real, confirmed provider lookup (Circle's
  -- getTransaction, e.g.) — never fabricated. See design doc Section D.0.
  tx_hash text,
  amount_minor bigint,
  currency text,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_payment_events_order on payment_events (order_id);
create index if not exists idx_payment_events_provider_ref on payment_events (provider_reference);

-- Idempotency backstop independent of the provider cooperating (design doc
-- Section D.4): only one in-flight release event per order at a time.
create unique index if not exists idx_payment_events_one_release_in_flight
  on payment_events (order_id)
  where leg = 'release' and event_type = 'release_submitted';

-- ============================================================================
-- 7. delivery_proofs
-- ============================================================================
create table if not exists delivery_proofs (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  supplier_id bigint not null references supplier_profiles(id),
  photo_urls text[] not null default '{}',
  receipt_url text,
  notes text,
  submitted_at timestamptz not null default now()
);

create index if not exists idx_delivery_proofs_order on delivery_proofs (order_id);

-- ============================================================================
-- 8. ledger_entries — double-entry, invariant-checked. Per-currency
--    balancing with an FX_CLEARING contra-account for NGN<->USDC
--    conversions — see design doc Section C.6 for why NOT one blended
--    ledger.
-- ============================================================================
create table if not exists ledger_entries (
  id bigint generated always as identity primary key,
  ledger_transaction_id uuid not null,
  order_id bigint not null references orders(id),
  account text not null check (account in (
    'ESCROW_WALLET_USDC', 'PLATFORM_REVENUE', 'SUPPLIER_PAYABLE',
    'EXTERNAL_NGN_BUYER', 'EXTERNAL_NGN_SUPPLIER', 'FX_CLEARING'
  )),
  account_ref bigint references users(id),
  direction text not null check (direction in ('debit', 'credit')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (currency in ('NGN', 'USDC')),
  created_at timestamptz not null default now()
);

create index if not exists idx_ledger_entries_txn on ledger_entries (ledger_transaction_id);
create index if not exists idx_ledger_entries_order on ledger_entries (order_id);

-- Invariant: for a given (ledger_transaction_id, currency), debits must
-- equal credits. A DEFERRED constraint trigger — fires at COMMIT, after
-- every row of a ledger transaction has been inserted, not per-row (which
-- would reject the normal, transiently-unbalanced-until-the-last-row case).
-- This requires application code to insert every row of one
-- ledger_transaction_id within a single DB transaction — that's the
-- discipline this trigger enforces, not just documents.
create or replace function check_ledger_balance() returns trigger as $$
declare
  bad record;
begin
  for bad in
    select ledger_transaction_id, currency,
           sum(case when direction = 'debit' then amount_minor else 0 end) as total_debit,
           sum(case when direction = 'credit' then amount_minor else 0 end) as total_credit
    from ledger_entries
    where ledger_transaction_id = new.ledger_transaction_id
    group by ledger_transaction_id, currency
    having sum(case when direction = 'debit' then amount_minor else 0 end)
        <> sum(case when direction = 'credit' then amount_minor else 0 end)
  loop
    raise exception 'Ledger transaction % is unbalanced for currency %: debits=% credits=%',
      bad.ledger_transaction_id, bad.currency, bad.total_debit, bad.total_credit;
  end loop;
  return null;
end;
$$ language plpgsql;

drop trigger if exists trg_ledger_balance_check on ledger_entries;
create constraint trigger trg_ledger_balance_check
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function check_ledger_balance();

-- ============================================================================
-- 9. disputes — extended in place (nothing has ever written to this table,
--    per README, so no data migration concern). Adds dispute_type
--    (distinguishes a pre-approval rejection from a genuinely new
--    post-settlement report — design doc Section C.7), category, evidence,
--    and repoints from sourcing_request_id to order_id.
-- ============================================================================
do $$
declare
  fk record;
begin
  if exists (select 1 from information_schema.tables where table_name = 'disputes') then
    -- Drop ANY foreign key on disputes that points at sourcing_requests
    -- (under either its original name or its renamed deprecated_ form) —
    -- found dynamically via pg_constraint rather than guessed by name.
    -- The exact auto-generated constraint name depends on which
    -- migration lineage originally created this column
    -- (0000_fresh_project_full_schema.sql vs. 0001_stage4_auth.sql +
    -- 0002_stage5_data_layer.sql), and guessing wrong here silently
    -- leaves a stale FK pointing at the renamed deprecated table instead
    -- of the new orders table — caught via a real failed run, not just
    -- review, same as the role-constraint ordering bug above.
    for fk in
      select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_class frel on frel.oid = con.confrelid
      where rel.relname = 'disputes'
        and con.contype = 'f'
        and frel.relname in ('sourcing_requests', 'deprecated_sourcing_requests')
    loop
      execute format('alter table disputes drop constraint %I', fk.conname);
    end loop;

    if exists (select 1 from information_schema.columns where table_name = 'disputes' and column_name = 'sourcing_request_id') then
      alter table disputes rename column sourcing_request_id to order_id;
    end if;

    -- Guarded so a second run of this migration doesn't fail on "constraint
    -- already exists" — the file's own header promises "safe to re-run".
    if not exists (
      select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      where rel.relname = 'disputes' and con.conname = 'disputes_order_id_fkey'
    ) then
      alter table disputes add constraint disputes_order_id_fkey foreign key (order_id) references orders(id);
    end if;

    if not exists (select 1 from information_schema.columns where table_name = 'disputes' and column_name = 'dispute_type') then
      alter table disputes add column dispute_type text
        check (dispute_type in ('pre_approval_rejection', 'post_settlement_report'));
    end if;
    if not exists (select 1 from information_schema.columns where table_name = 'disputes' and column_name = 'category') then
      alter table disputes add column category text
        check (category in ('item_not_as_described', 'item_not_delivered', 'quality_issue', 'wrong_quantity', 'damaged_in_transit', 'other'));
    end if;
    if not exists (select 1 from information_schema.columns where table_name = 'disputes' and column_name = 'evidence_urls') then
      alter table disputes add column evidence_urls text[] not null default '{}';
    end if;
    if not exists (select 1 from information_schema.columns where table_name = 'disputes' and column_name = 'description') then
      alter table disputes add column description text;
    end if;
  else
    create table disputes (
      id bigint generated always as identity primary key,
      order_id bigint not null references orders(id),
      raised_by bigint not null references users(id),
      dispute_type text not null check (dispute_type in ('pre_approval_rejection', 'post_settlement_report')),
      category text not null check (category in ('item_not_as_described', 'item_not_delivered', 'quality_issue', 'wrong_quantity', 'damaged_in_transit', 'other')),
      description text,
      evidence_urls text[] not null default '{}',
      status text not null default 'open' check (status in ('open', 'under_review', 'resolved_buyer', 'resolved_supplier', 'resolved_split')),
      resolution_notes text,
      resolved_by bigint references users(id),
      resolved_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    );
  end if;
end $$;

create index if not exists idx_disputes_order on disputes (order_id);
create index if not exists idx_disputes_status on disputes (status);

drop trigger if exists trg_disputes_updated_at on disputes;
create trigger trg_disputes_updated_at
  before update on disputes
  for each row execute function set_updated_at();

-- Every state change, every ruling, every admin note on a dispute —
-- required for the audit history the pack asks for.
create table if not exists dispute_events (
  id bigint generated always as identity primary key,
  dispute_id bigint not null references disputes(id),
  actor_id bigint references users(id),
  event_type text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_dispute_events_dispute on dispute_events (dispute_id);

-- ============================================================================
-- 10. ratings — DB cache of an on-chain source of truth, not the source
--     of truth itself. on_chain_tx_hash is what makes a rating
--     independently verifiable, per the pack's requirement.
-- ============================================================================
create table if not exists ratings (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  buyer_id bigint not null references users(id),
  supplier_id bigint not null references supplier_profiles(id),
  score smallint not null check (score between 1 and 5),
  comment text,
  on_chain_tx_hash text,
  on_chain_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_ratings_one_per_order on ratings (order_id);
create index if not exists idx_ratings_supplier on ratings (supplier_id);

-- ============================================================================
-- 11. Row-level security — same posture as every table before it: enabled,
--     zero policies, default-deny backstop. Real visibility stays in the
--     API route layer (service-role client bypasses RLS by design).
-- ============================================================================
alter table supplier_profiles enable row level security;
alter table supplier_materials enable row level security;
alter table supplier_verification_applications enable row level security;
alter table orders enable row level security;
alter table payment_events enable row level security;
alter table delivery_proofs enable row level security;
alter table ledger_entries enable row level security;
alter table dispute_events enable row level security;
alter table ratings enable row level security;
-- disputes already has RLS enabled from 0000_fresh_project_full_schema.sql.

-- ============================================================================
-- Not decided by this migration, deliberately (design doc Section J):
--   - Platform fee treatment on a buyer-ruled refund (#2) — application
--     logic when a refund is issued, not a schema concern.
--   - Whether a dispute ruling triggers real money movement automatically
--     in this stage, or just records the ruling (#9) — application logic
--     in the dispute-resolution route, not this migration.
--   - Exact timeout durations (#4) — application-layer scheduled-job
--     config, not schema.
-- ============================================================================
