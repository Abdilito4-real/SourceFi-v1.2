-- 0010_termination_flows.sql
--
-- Prompt 3 (termination and declination flows) of the feedback/
-- notifications/security pack, see the termination matrix reviewed
-- before this was written for the full state x actor mapping and the
-- policy decisions this migration encodes. Same idempotent style as
-- every migration before this one.

-- ============================================================================
-- order_status_history, append-only log of every status transition.
-- Populated inside lib/orderService.ts's tryTransition() itself, so this
-- is automatically complete for every existing AND future transition, not
-- something each new flow has to remember to write to separately. This is
-- what "Timeline on the request shows every transition so both parties
-- see the same history" is actually built on.
-- ============================================================================
create table if not exists order_status_history (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  -- Null only for the very first row (order creation has no prior status).
  from_status order_status,
  to_status order_status not null,
  -- Null for a system/timeout-driven transition, see actor_role.
  actor_id bigint references users(id),
  actor_role text not null check (actor_role in ('buyer', 'supplier', 'admin', 'system')),
  reason_category text,
  reason_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_status_history_order on order_status_history (order_id, created_at);

-- ============================================================================
-- order_cancellations, one row per buyer/supplier-initiated cancellation
-- abandonment, or proof withdrawal. Distinct from order_status_history:
-- this is the "why", including the fund consequence ACTUALLY applied
-- (fee_charged_minor / refund_minor), recorded once at the time it
-- happened rather than re-derived later from order_status_history's
-- reason_text.
-- ============================================================================
create table if not exists order_cancellations (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  actor_id bigint not null references users(id),
  actor_role text not null check (actor_role in ('buyer', 'supplier')),
  -- Buyer categories: 'changed_mind', 'found_alternative', 'no_longer_needed', 'price_disagreement', 'other'.
  -- Supplier categories: 'cannot_fulfill', 'schedule_conflict', 'pricing_error', 'other'.
  -- Not a pg enum (see lib/types.ts's CancellationCategory), same posture
  -- as disputes.category: a plain text + check, matching that table's
  -- existing convention in this schema rather than introducing a new one.
  category text not null,
  description text,
  fee_charged_minor bigint not null default 0,
  refund_minor bigint,
  created_at timestamptz not null default now()
);

create index if not exists idx_order_cancellations_order on order_cancellations (order_id);

-- ============================================================================
-- supplier_strikes, one row per voluntary abandonment (Prompt 3's flow
-- 6). Counted within a trailing 90-day window for escalation, never a
-- running total that never resets, see lib/orderService.ts's
-- abandonOrder() for the exact thresholds.
-- ============================================================================
create table if not exists supplier_strikes (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references supplier_profiles(id) on delete cascade,
  order_id bigint references orders(id),
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_supplier_strikes_supplier on supplier_strikes (supplier_id, created_at);

-- A 2nd strike within 90 days blocks new orders for 7 days (see
-- abandonOrder()), tracked as an explicit until-timestamp, checked at
-- order-creation time, rather than re-deriving "are they currently
-- blocked" from the strikes table on every read.
alter table supplier_profiles add column if not exists blocked_until timestamptz;

-- ============================================================================
-- Admin suspension, orthogonal to role. Blocks new orders immediately;
-- existing in-flight orders continue normally and are just flagged for
-- admin attention (see app/api/admin/users/[id]/suspend/route.ts), never
-- an automatic mass-cancel, which could punish a buyer mid-delivery for a
-- problem that's the supplier's alone.
-- ============================================================================
alter table users add column if not exists suspended_at timestamptz;
alter table users add column if not exists suspension_reason text;
alter table users add column if not exists suspended_by bigint references users(id);

alter table order_status_history enable row level security;
alter table order_cancellations enable row level security;
alter table supplier_strikes enable row level security;
