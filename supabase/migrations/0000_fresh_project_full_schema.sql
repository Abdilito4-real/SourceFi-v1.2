-- 0000_fresh_project_full_schema.sql
--
-- For a BRAND-NEW, EMPTY Supabase project only. Run this ONE file instead
-- of 0001_stage4_auth.sql and 0002_stage5_data_layer.sql — this is the
-- same end state as running those two in sequence, consolidated for a
-- database that doesn't already have `users`/`requests` tables from
-- somewhere outside this repo's migration history.
--
-- If you're continuing on the ORIGINAL project (the one that already had
-- users/requests before Stage 4), ignore this file — keep using
-- 0001_stage4_auth.sql and 0002_stage5_data_layer.sql as before. Nothing
-- about those two files changes; this is an alternative starting point,
-- not a replacement for them.
--
-- Idempotent — safe to re-run. Because this targets an empty database,
-- there's no legacy data to rename around, backfill, or preserve
-- compatibility with — every table is created directly in its final Stage
-- 5 shape, and the application code (app/api/escrow, app/api/requests,
-- components/App.tsx) has been rewired to match: buyer_id/sourcer_id are
-- real foreign keys (not email text), money is integer minor units
-- throughout, and there is no buyer_email/sourcer_email/sourcing_fee/
-- budget/evidence column at all — this schema never carried them. If
-- you're instead running this against the ORIGINAL project (real rows,
-- deployed app code still on the old columns), use
-- 0001_stage4_auth.sql + 0002_stage5_data_layer.sql, which keep the
-- deprecated columns around for exactly that reason.
--
-- Same three decisions as the Stage 5 review doc apply here too:
--   1. Currency defaults to USD — matches what the app does today, not a
--      resolution of the Naira-vs-USD question in CLAUDE.md.
--   2. RLS is enabled with zero policies (default-deny backstop). The
--      service-role client this app uses bypasses RLS by design — real
--      per-user visibility is enforced in the API route layer, not here.
--   3. Identity is real id-based foreign keys (buyer_id/sourcer_id), not
--      email text — the app joins in emails for display server-side (see
--      app/api/requests/route.ts) rather than storing them redundantly.

-- ============================================================================
-- Enum types
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sourcing_request_status') then
    create type sourcing_request_status as enum (
      'open', 'claimed', 'escrow', 'verified', 'escrow_released',
      'disputed', 'cancelled', 'expired'
    );
  end if;
end $$;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================================
-- users
-- ============================================================================
create table if not exists users (
  id bigint generated always as identity primary key,
  email text not null,
  username text,
  wallet_address text,
  wallet_id text,
  wallet_set_id text,
  -- Stage 4: server-assigned, DB-authoritative. Never trust a client-
  -- supplied copy of this for an authorization decision.
  role text not null default 'buyer',
  -- Stage 4: the verified Privy DID this row is bound to. Server-verified
  -- once per session via @privy-io/node — see lib/privyServer.ts — never
  -- client-supplied.
  privy_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_role_check') then
    alter table users add constraint users_role_check check (role in ('buyer', 'sourcer', 'admin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_email_key') then
    alter table users add constraint users_email_key unique (email);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_privy_user_id_key') then
    alter table users add constraint users_privy_user_id_key unique (privy_user_id);
  end if;
end $$;

create index if not exists idx_users_privy_user_id on users (privy_user_id);
create index if not exists idx_users_role on users (role);

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ============================================================================
-- materials — the catalog currently hardcoded in lib/constants.ts, seeded
-- in as real rows. `slug` matches today's static `id` field.
-- ============================================================================
create table if not exists materials (
  id bigint generated always as identity primary key,
  slug text not null,
  name text not null,
  tag text,
  savings text,
  hook text,
  explainer text,
  why_rare text,
  metrics text,
  video_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_materials_slug on materials (slug);

drop trigger if exists trg_materials_updated_at on materials;
create trigger trg_materials_updated_at
  before update on materials
  for each row execute function set_updated_at();

insert into materials (slug, name, tag, savings, hook, explainer, why_rare, metrics, video_url) values
  ('earthblocks', 'Compressed Earth Blocks (CEB)', 'Stabilized raw earth', 'Up to 40% less carbon',
   'Non-fired, high-density blocks made from locally sourced soil and structural binders.',
   'Compressed Earth Blocks are manufactured by compressing damp soil mixed with stabilizers (such as cement or lime) in a manual or hydraulic press. Unlike traditional clay bricks, they are cured naturally in the sun rather than fired in a kiln, preserving forests and cutting carbon footprint drastically while offering dense, highly soundproof thermal mass walls.',
   'Local hydraulic CEB pressing yards in Nigeria are sparse and scattered. Most commercial contractors lack on-site soil testing and press availability.',
   '290x140x110mm standard modular', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('bubbledeck', 'BubbleDeck Slabs', 'HDPE void balls', 'Up to 35% less concrete',
   'Hollow plastic spheres replace non-structural concrete in the slab''s core.',
   'BubbleDeck slabs eliminate dead weight by substituting solid concrete in the center of the structural slab with hollow plastic spheres. This hollow core reduces the slab''s dead load, enabling longer spans, thinner floors, fewer columns, and major structural savings on foundation steel.',
   'Almost no material suppliers or structural stockists in Nigeria carry these HDPE voids locally. Most specified BubbleDeck projects require custom imports.',
   '270mm-360mm spherical voids', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('lc3cement', 'LC3 Cement', 'Limestone Calcined Clay', 'Up to 40% CO2 reduction',
   'Low-carbon cement blend utilizing calcined clay and limestone to substitute clinker.',
   'LC3 is a revolutionary cement blend that replaces up to 50% of carbon-intensive clinker with a combination of calcined clay and ground limestone. It achieves equivalent structural strength and durability to standard Ordinary Portland Cement (OPC) while dramatically lowering raw manufacturing emissions.',
   'Calcination facilities for structural clay remain in early-stage pilot phases across Nigeria. Commercial distributors still favor standard high-clinker OPC.',
   'Type IL calcined clay composite', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('geopolymer', 'Geopolymer Concrete', 'Fly ash / slag binder', 'Clinker-free concrete',
   'Alkali-activated industrial byproduct binders completely replace Portland cement.',
   'Geopolymer concrete utilizes industrial byproducts like fly ash, blast furnace slag, or metakaolin activated by alkaline liquids to form a durable binder. This completely eliminates Portland cement, resulting in superb acid resistance, zero clinker emissions, and high early compressive strength.',
   'Ready-mix batching plants in Nigeria do not stock liquid alkaline activators or maintain dry-blend slag fly ash storage bins natively.',
   '30-50 MPa heavy industrial grade', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('hempcrete', 'Hempcrete Blocks', 'Hemp hurd / lime binder', 'Carbon-negative walls',
   'Carbon-sequestering composite insulating material made of hemp hurds and hydrated lime.',
   'Hempcrete is a bio-composite building material made of woody hemp plant cores (hurds) mixed with a lime-based binder. As the hemp grows, it sequesters carbon dioxide, making the final cured blocks carbon-negative over their lifecycle while providing superior insulating and vapor-permeable performance.',
   'Hemp cultivation and structural processing infrastructure are in early regulatory phases. No domestic commercial industrial lime blending exists.',
   'R-value R-2.4 per inch thermal', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('bamboo', 'Structural Bamboo', 'Laminated Guadua / Dendrocalamus', 'High tensile rapid renewal',
   'Vetted, treated bamboo columns offering rapid-growth alternative to heavy structural timber.',
   'Vetted structural bamboo poles represent a rapid-renewal alternative to structural steel and timber. Properly treated with boron salts, structural bamboo poles resist insect attacks, withstand intense seismic shifts, and offer excellent strength-to-weight ratios.',
   'Lack of commercial boron-treating preservation facilities and standardized grade-stamping yards for structural bamboo in West Africa.',
   '80-120mm curated load diameter', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('recycledplastic', 'Recycled Plastic Products', 'Polymer-wood composites', 'Zero-rot weather resistance',
   'Compressed high-density structural lumber and composite panels made from municipal plastic waste.',
   'Polymer-composite building panels are produced by shredding and compressing municipal plastic waste (like HDPE and LDPE) with organic fibers. This creates ultra-dense, zero-rot, completely waterproof cladding boards, structural decking, and formwork boards that outperform natural timber in wet tropical environments.',
   'Recycling plants with high-pressure polymer extrusion and composite stabilizing equipment are scarce; most local plastic recycling focuses on PET bottles.',
   '100% recycled HDPE/LDPE planks', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('passivecooling', 'Passive Cooling Materials', 'Phase Change Materials (PCM)', 'Up to 50% HVAC load savings',
   'Thermal energy storage materials that absorb heat during the day and release it at night.',
   'Phase Change Materials (PCMs) are micro-encapsulated organic paraffin compounds integrated into wallboards or ceiling tiles. They absorb excess thermal heat when room temperature rises and solidify as it cools, stabilizing interior environments and slashing AC energy demand.',
   'Almost entirely imported as specialized chemical products. No local supply network exists for structural insulation builders in West Africa.',
   '21°C - 23°C phase transition shift', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('structuralsystems', 'Light-Gauge Steel Systems', 'Cold-formed steel framing', '90% faster wall erection',
   'Cold-rolled structural steel profiles offering precise, rapid, lightweight structural framing.',
   'Light-gauge steel framing utilizes structural C and U sections cold-formed from thin galvanized sheets. It provides a lightweight, mold-proof, termite-proof, and fully recyclable framing solution that speeds up multi-story construction schedules immensely.',
   'High-precision roll-forming mill operators with local structural design software integration are limited; structural steel remains expensive.',
   '0.8mm - 1.6mm galvanized structural', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('cement', 'Rapid-Hardening Cement', 'High-early strength OPC', '48-hour formwork strippage',
   'Fine-ground Ordinary Portland Cement designed to achieve high initial compressive strength.',
   'Rapid-hardening cement is ground to a much higher fineness than traditional OPC. This accelerates the hydration process, allowing concrete to achieve equivalent 7-day strength in just 48 hours, enabling contractors to strip structural formwork early and speed up high-rise frame schedules.',
   'Domestic cement plants in Nigeria rarely batch high-fineness OPC on standard run; most specialized rapid cement requires custom mill orders.',
   'CEMI 52.5R high-early strength', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('tiles', 'Porcelain Raised Access Tiles', 'Elevated structural tiles', 'Clean underfloor service runs',
   'Modular porcelain tiles on adjustable pedestals to route active cables and cooling underfoot.',
   'Raised porcelain floor systems elevate modular porcelain tiles on heavy-duty structural pedestals. This leaves a continuous underfloor chamber to route active power lines, cooling ducts, and IT fiber cables freely, eliminating wall-chasing and permitting rapid office reconfiguration.',
   'Standard structural pedestals and dense modular porcelain tiles are rarely stocked in local outlets; mostly imported on-demand.',
   '600x600x20mm high-traffic modular', 'https://www.youtube.com/embed/dQw4w9WgXcQ'),
  ('steel', 'GFRP Reinforcing Bars', 'Glass-Fiber Rebar', 'Zero rust, 100-year life',
   'High-tensile, non-corrosive glass-fiber rebar to replace carbon steel in concrete.',
   'Glass Fiber Reinforced Polymer (GFRP) rebar is a high-strength concrete reinforcement that can never rust, even when exposed to harsh saltwater or humid coastal environments. It is 4x lighter than steel, offers 2x higher tensile strength, and eliminates concrete spalling permanently.',
   'No domestic GFRP factories exist in West Africa. Structural engineers default to traditional carbon steel due to unfamiliarity with polymer codes.',
   '8mm - 16mm tensile profile bar', 'https://www.youtube.com/embed/dQw4w9WgXcQ')
on conflict (slug) do nothing;

-- ============================================================================
-- suppliers — CAC format validation and collusion flagging are Stage 7's
-- job; this is the table only.
-- ============================================================================
create table if not exists suppliers (
  id bigint generated always as identity primary key,
  name text not null,
  cac_registration_number text,
  phone text,
  address text,
  location text,
  verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

drop trigger if exists trg_suppliers_updated_at on suppliers;
create trigger trg_suppliers_updated_at
  before update on suppliers
  for each row execute function set_updated_at();

-- ============================================================================
-- sourcer_profiles — every counter starts at zero. Stage 7 explicitly
-- bans seeded stats, so nothing here seeds any.
-- ============================================================================
create table if not exists sourcer_profiles (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  bio text,
  cities_served text[] not null default '{}',
  completed_jobs_count integer not null default 0,
  rating_sum integer not null default 0,
  rating_count integer not null default 0,
  vetted_by bigint references users(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists idx_sourcer_profiles_user_id on sourcer_profiles (user_id) where deleted_at is null;

drop trigger if exists trg_sourcer_profiles_updated_at on sourcer_profiles;
create trigger trg_sourcer_profiles_updated_at
  before update on sourcer_profiles
  for each row execute function set_updated_at();

-- ============================================================================
-- sourcing_requests — the core table. No deprecated columns here: this is
-- a fresh project, and the application code writes buyer_id/sourcer_id/
-- budget_minor/sourcing_fee_minor directly — see lib/requestStateMachine.ts
-- for the status transitions this table's status column is validated
-- against server-side.
-- ============================================================================
create table if not exists sourcing_requests (
  id bigint generated always as identity primary key,
  request_code text not null,
  title text not null,
  location text,
  category text,
  status sourcing_request_status not null default 'open',

  buyer_id bigint not null references users(id),
  sourcer_id bigint references users(id),
  material_id bigint references materials(id),
  budget_minor bigint not null check (budget_minor >= 0),
  budget_currency text not null default 'USD' check (budget_currency in ('USD', 'NGN')),
  sourcing_fee_minor bigint,
  platform_fee_minor bigint,

  -- Small per-request workflow flags — previously fields inside a JSONB
  -- evidence blob, now real columns. The audit report itself (notes,
  -- image, supplier id, GPS) lives in audit_reports; these three are
  -- everything else that isn't a status transition.
  invite_sent_at timestamptz,
  cleared_by_sourcer boolean not null default false,
  cleared_at timestamptz,
  flagged boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists idx_sourcing_requests_request_code on sourcing_requests (request_code);
create index if not exists idx_sourcing_requests_status on sourcing_requests (status);
create index if not exists idx_sourcing_requests_buyer_id on sourcing_requests (buyer_id);
create index if not exists idx_sourcing_requests_sourcer_id on sourcing_requests (sourcer_id);
create index if not exists idx_sourcing_requests_material_id on sourcing_requests (material_id);
create index if not exists idx_sourcing_requests_created_at on sourcing_requests (created_at desc);

drop trigger if exists trg_sourcing_requests_updated_at on sourcing_requests;
create trigger trg_sourcing_requests_updated_at
  before update on sourcing_requests
  for each row execute function set_updated_at();

-- ============================================================================
-- escrow_transactions — a transaction LOG, not the balanced double-entry
-- ledger Stage 6 builds. Append-only by convention: no soft delete,
-- because a financial log entry is never edited or removed.
-- ============================================================================
create table if not exists escrow_transactions (
  id bigint generated always as identity primary key,
  sourcing_request_id bigint not null references sourcing_requests(id),
  type text not null check (type in ('deposit', 'release', 'refund')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'USD' check (currency in ('USD', 'NGN')),
  tx_hash text,
  initiated_by bigint references users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_escrow_tx_request on escrow_transactions (sourcing_request_id);

-- ============================================================================
-- audit_reports — the sourcer's field-visit report. GPS/EXIF extraction
-- and handshake-code hardening are Stage 7's job; this gives that stage
-- somewhere real to write to.
-- ============================================================================
create table if not exists audit_reports (
  id bigint generated always as identity primary key,
  sourcing_request_id bigint not null references sourcing_requests(id),
  sourcer_id bigint not null references users(id),
  supplier_id bigint references suppliers(id),
  supplier_business_id_raw text,
  notes text,
  image_url text,
  gps_lat numeric,
  gps_lng numeric,
  verified boolean not null default false,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_audit_reports_request on audit_reports (sourcing_request_id);

drop trigger if exists trg_audit_reports_updated_at on audit_reports;
create trigger trg_audit_reports_updated_at
  before update on audit_reports
  for each row execute function set_updated_at();

-- ============================================================================
-- disputes — schema only. Stage 8 builds the filing flow, freeze
-- semantics, and the admin review queue.
-- ============================================================================
create table if not exists disputes (
  id bigint generated always as identity primary key,
  sourcing_request_id bigint not null references sourcing_requests(id),
  raised_by bigint not null references users(id),
  reason text not null,
  status text not null default 'open' check (status in ('open', 'under_review', 'resolved_buyer', 'resolved_sourcer', 'resolved_split')),
  resolution_notes text,
  resolved_by bigint references users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_disputes_request on disputes (sourcing_request_id);
create index if not exists idx_disputes_status on disputes (status);

drop trigger if exists trg_disputes_updated_at on disputes;
create trigger trg_disputes_updated_at
  before update on disputes
  for each row execute function set_updated_at();

-- ============================================================================
-- notifications — schema only. Nothing writes to this yet.
-- ============================================================================
create table if not exists notifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  type text not null,
  title text not null,
  body text,
  related_request_id bigint references sourcing_requests(id),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_user_id on notifications (user_id);
create index if not exists idx_notifications_unread on notifications (user_id) where read_at is null;

-- ============================================================================
-- audit_log — who did what, when, from where. Written by lib/authz.ts's
-- logAudit() on every role change and admin action. Deliberately no
-- soft-delete column: an audit trail that can be "deleted" isn't one.
-- ============================================================================
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

-- ============================================================================
-- Row-level security — enabled everywhere, zero policies for anon/
-- authenticated. Default-deny backstop, not the primary access boundary:
-- this app's Supabase client always authenticates as service_role (see
-- lib/supabaseServer.ts), which bypasses RLS by design, so real per-user
-- visibility is enforced in the API route layer. This guarantees that if
-- the anon/publishable key were ever used by mistake, it sees nothing.
-- ============================================================================
alter table users enable row level security;
alter table sourcing_requests enable row level security;
alter table escrow_transactions enable row level security;
alter table audit_reports enable row level security;
alter table disputes enable row level security;
alter table notifications enable row level security;
alter table sourcer_profiles enable row level security;
alter table suppliers enable row level security;
alter table materials enable row level security;
alter table audit_log enable row level security;

-- ============================================================================
-- Bootstrapping the first admin
--
-- There is deliberately no self-service or API path to become an admin.
-- The very first admin has to be set directly in the database, AFTER your
-- first real login (the row has to exist first). Replace the email below
-- and run once:
--
--   update users set role = 'admin' where email = 'you@example.com';
--
-- Every admin after that is granted via PATCH /api/admin/users/[id]/role
-- by an existing admin, and it's audit-logged.
-- ============================================================================
