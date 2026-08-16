-- 0002_stage5_data_layer.sql
--
-- Stage 5 (data layer). Run this against your Supabase project's SQL
-- editor (or `supabase db push`) AFTER 0001_stage4_auth.sql. Idempotent
-- safe to re-run. Nothing in here drops a column or a row; deprecated
-- columns are marked in comments, not removed, until the application code
-- that reads them is rewired and verified (see the Stage 5 review doc for
-- what's deferred to that phase).
--
-- Three decisions in here that are product/architecture calls, not schema
-- mechanics, each is called out again inline at the point it happens:
--   1. Currency defaults to USD (matches what the app actually does today,
--      not a resolution of the Naira-vs-USD tension in CLAUDE.md).
--   2. RLS is enabled with zero policies (default-deny backstop), the
--      service-role client this app uses bypasses it by design, so the
--      real access control stays the API route's job, not Postgres's.
--   3. `requests` is renamed to `sourcing_requests` and gains real
--      `buyer_id`/`sourcer_id` FKs alongside (not instead of, yet) the
--      existing email columns.

-- ============================================================================
-- 0. requests -> sourcing_requests
-- ============================================================================
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'requests')
     and not exists (select 1 from information_schema.tables where table_name = 'sourcing_requests') then
    alter table requests rename to sourcing_requests;
  end if;
end $$;

-- ============================================================================
-- 1. sourcing_request_status, a real enum instead of a free-text column.
-- Same eight values the app already writes (see lib/types.ts's RequestStatus)
--, this formalizes what exists, it does not adopt Stage 6's richer state
-- list. Stage 6 gets its own migration when it defines its own rules.
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

do $$
begin
  -- Guards against re-running (udt_name becomes 'sourcing_request_status'
  -- after the first successful run) without assuming the original column
  -- was exactly `text`, a table created via Supabase's UI table editor
  -- could just as easily have made it `varchar`.
  if exists (
    select 1 from information_schema.columns
    where table_name = 'sourcing_requests' and column_name = 'status'
      and udt_name in ('text', 'varchar', 'bpchar')
  ) then
    alter table sourcing_requests
      alter column status type sourcing_request_status using status::text::sourcing_request_status;
  end if;
end $$;

-- ============================================================================
-- 2. sourcing_requests, real FKs alongside the email columns, money as
-- integer minor units alongside the old float/text columns, soft delete.
-- ============================================================================
alter table sourcing_requests add column if not exists buyer_id bigint references users(id);
alter table sourcing_requests add column if not exists sourcer_id bigint references users(id);
alter table sourcing_requests add column if not exists material_id bigint;

-- Backfilled from the email columns below, once materials exists (section 4)
-- and users has rows to match against. Nullable for now on purpose: old app
-- code (still live until the wiring phase ships) only ever sets
-- buyer_email/sourcer_email, so a NOT NULL constraint here would break
-- inserts from the currently-deployed code. Tighten to NOT NULL once the
-- wiring phase confirms every write path sets buyer_id directly.
update sourcing_requests sr
set buyer_id = u.id
from users u
where sr.buyer_email = u.email and sr.buyer_id is null;

update sourcing_requests sr
set sourcer_id = u.id
from users u
where sr.sourcer_email is not null and sr.sourcer_email = u.email and sr.sourcer_id is null;

-- buyer_email / sourcer_email are now DEPRECATED, kept only so the
-- currently-deployed app code (which still reads/writes them) keeps
-- working until the wiring phase cuts over to buyer_id/sourcer_id.

alter table sourcing_requests add column if not exists budget_minor bigint;
alter table sourcing_requests add column if not exists budget_currency text not null default 'USD' check (budget_currency in ('USD', 'NGN'));
alter table sourcing_requests add column if not exists sourcing_fee_minor bigint;
alter table sourcing_requests add column if not exists platform_fee_minor bigint;

-- budget stays NULL for existing rows, it's freeform text today ("2,500
-- USD", "~₦3m", anything a buyer typed) and not safely parseable into a
-- number. Backfilling it with a best-effort regex would put fabricated
-- amounts in a money column, which is worse than leaving it empty. New
-- requests populate budget_minor for real once the "New Request" form is
-- rewired in the wiring phase.
--
-- sourcing_fee, unlike budget, has always been a real number (parseFloat'd
-- on every write), safe to backfill directly.
update sourcing_requests
set sourcing_fee_minor = round(sourcing_fee::numeric * 100)::bigint
where sourcing_fee is not null and sourcing_fee_minor is null;

-- sourcing_fee (old float column) is now DEPRECATED, same reason as the
-- email columns: kept until the wiring phase finishes reading from
-- sourcing_fee_minor everywhere.

alter table sourcing_requests add column if not exists updated_at timestamptz not null default now();
alter table sourcing_requests add column if not exists deleted_at timestamptz;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sourcing_requests_updated_at on sourcing_requests;
create trigger trg_sourcing_requests_updated_at
  before update on sourcing_requests
  for each row execute function set_updated_at();

create index if not exists idx_sourcing_requests_status on sourcing_requests (status);
create index if not exists idx_sourcing_requests_buyer_id on sourcing_requests (buyer_id);
create index if not exists idx_sourcing_requests_sourcer_id on sourcing_requests (sourcer_id);
create index if not exists idx_sourcing_requests_material_id on sourcing_requests (material_id);
create index if not exists idx_sourcing_requests_created_at on sourcing_requests (created_at desc);

-- ============================================================================
-- 3. users, bring up to the same soft-delete/updated_at standard as
-- everything else. Role/privy_user_id already added in 0001.
-- ============================================================================
alter table users add column if not exists updated_at timestamptz not null default now();
alter table users add column if not exists deleted_at timestamptz;

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ============================================================================
-- 4. materials, the catalog currently hardcoded in lib/constants.ts
-- seeded in as real rows. `slug` matches today's static `id` field so the
-- wiring phase can join on it without renumbering anything.
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

-- Now that materials exists, add the FK sourcing_requests.material_id was
-- missing (added nullable above, before this table existed).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sourcing_requests_material_id_fkey'
  ) then
    alter table sourcing_requests
      add constraint sourcing_requests_material_id_fkey foreign key (material_id) references materials(id);
  end if;
end $$;

-- ============================================================================
-- 5. suppliers, didn't exist as an entity before; was a free-text
-- business_id field inside evidence JSONB. CAC format validation and
-- collusion flagging are Stage 7's job, this is the table only.
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
-- 6. sourcer_profiles, every counter starts at zero. Stage 7 explicitly
-- says "remove all seeded stats", so nothing here seeds any.
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
-- 7. escrow_transactions, a real ledger row per fund movement, replacing
-- the deposit_tx_hash/release_tx_hash/deposit_amount/release_amount fields
-- currently stuffed into sourcing_requests.evidence JSONB. This is a
-- transaction LOG, not the double-entry balanced ledger Stage 6 asks for
-- that's a materially bigger piece of work with its own test suite
-- ("ledger must balance to zero, and there's a test that asserts it") and
-- stays there. Append-only by convention: no soft delete, because a
-- financial log entry is never edited or removed, only ever added to.
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

-- Backfill from evidence JSONB where present. Timestamps use the parent
-- request's created_at rather than parsing evidence's toUTCString() dates
-- an approximation for pre-migration rows, not a precision guarantee.
insert into escrow_transactions (sourcing_request_id, type, amount_minor, currency, tx_hash, initiated_by, created_at)
select sr.id, 'deposit',
       round(coalesce(nullif(sr.evidence->>'deposit_amount', ''), '0')::numeric * 100)::bigint,
       'USD', sr.evidence->>'deposit_tx_hash', sr.buyer_id, sr.created_at
from sourcing_requests sr
where sr.evidence ? 'deposit_tx_hash'
  and coalesce(nullif(sr.evidence->>'deposit_amount', ''), '0')::numeric > 0
  and not exists (
    select 1 from escrow_transactions et where et.sourcing_request_id = sr.id and et.type = 'deposit'
  );

insert into escrow_transactions (sourcing_request_id, type, amount_minor, currency, tx_hash, initiated_by, created_at)
select sr.id, 'release',
       round(coalesce(nullif(sr.evidence->>'release_amount', ''), '0')::numeric * 100)::bigint,
       'USD', sr.evidence->>'release_tx_hash', sr.buyer_id, sr.created_at
from sourcing_requests sr
where sr.evidence ? 'release_tx_hash'
  and coalesce(nullif(sr.evidence->>'release_amount', ''), '0')::numeric > 0
  and not exists (
    select 1 from escrow_transactions et where et.sourcing_request_id = sr.id and et.type = 'release'
  );

-- ============================================================================
-- 8. audit_reports, the sourcer's field-visit report, out of evidence
-- JSONB into real columns. GPS/EXIF extraction and handshake-code hardening
-- are Stage 7's job; this just gives that stage somewhere real to write to.
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

insert into audit_reports (sourcing_request_id, sourcer_id, supplier_business_id_raw, notes, image_url, verified, submitted_at)
select sr.id, sr.sourcer_id, sr.evidence->>'business_id', sr.evidence->>'notes', sr.evidence->>'image',
       true, coalesce(nullif(sr.evidence->>'verified_at', '')::timestamptz, sr.created_at)
from sourcing_requests sr
where sr.evidence ? 'verified_at'
  and sr.sourcer_id is not null
  and not exists (
    select 1 from audit_reports ar where ar.sourcing_request_id = sr.id
  );

-- ============================================================================
-- 9. disputes, schema only. Stage 8 builds the filing flow, freeze
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
-- 10. notifications, schema only. Nothing writes to this yet; that's
-- incremental across whichever later stage first needs to notify someone.
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
-- 11. Row-level security, enabled everywhere, zero policies for
-- anon/authenticated. This is a default-deny backstop, not the primary
-- access boundary: this app's Supabase client always authenticates as
-- service_role (see lib/supabaseServer.ts), which bypasses RLS by design,
-- so real per-user visibility is enforced in the API route layer, same as
-- Stage 4's authz work. What this DOES do is guarantee that if the anon/
-- publishable key were ever used by mistake, or a future feature queries
-- Supabase directly from the client, it sees nothing instead of everything.
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
