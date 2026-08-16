-- 0006_supplier_listings.sql
--
-- Replaces the fixed, admin-curated material catalog (lib/constants.ts's
-- materialLibrary, seeded into `materials` by migration 0000) with
-- supplier-uploaded listings — per explicit product direction: materials
-- can only be uploaded by the supplier whose profile they belong to, and
-- are visible to buyers for search/browsing from there.
--
-- Deliberately additive, not a replacement migration: the old `materials`
-- table and `supplier_materials` junction (migration 0004) are left
-- alone, unused rather than dropped — same preserve-don't-drop posture
-- as every migration before this one. `orders.material_id` (references
-- the old fixed catalog) also stays as an unused legacy column; a NEW
-- `supplier_listing_id` column is what orders actually use going
-- forward.
create table if not exists supplier_listings (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references supplier_profiles(id),
  name text not null,
  category text,
  description text,
  unit text,                                   -- e.g. "per bag", "per m3", "per 500 units"
  price_minor bigint check (price_minor is null or price_minor > 0),  -- indicative NGN price, optional — the real order amount is still agreed per-order
  image_url text,
  active boolean not null default true,        -- supplier can pause a listing without deleting it
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_supplier_listings_supplier on supplier_listings (supplier_id);
-- The shape the buyer-facing search actually queries: active, not
-- deleted, scoped to one supplier.
create index if not exists idx_supplier_listings_active_lookup
  on supplier_listings (supplier_id)
  where active = true and deleted_at is null;

drop trigger if exists trg_supplier_listings_updated_at on supplier_listings;
create trigger trg_supplier_listings_updated_at
  before update on supplier_listings
  for each row execute function set_updated_at();

alter table supplier_listings enable row level security;

-- Orders can optionally reference the specific listing a buyer picked —
-- additive, nullable (a buyer can still create a freeform order without
-- picking a listing at all).
alter table orders add column if not exists supplier_listing_id bigint references supplier_listings(id);
create index if not exists idx_orders_supplier_listing on orders (supplier_listing_id);
