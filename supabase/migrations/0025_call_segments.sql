-- 0025_call_segments.sql
--
-- Real corroboration for the verification call's duration gate. Before
-- this, orders.verification_call_seconds was a bare running total, bumped
-- by whichever party's client reported a segment (lib/orderService.ts's
-- recordVerificationCallProgress) — a single dishonest party could hit
-- POST /api/orders/[id]/call-progress directly with a fabricated
-- secondsElapsed and satisfy the entire 5-minute requirement alone, with
-- no real call, and no check the other party was ever connected at all.
--
-- This table stores each party's own reported join-to-leave segments
-- (start/end timestamps, never a bare duration) instead of one mutable
-- counter. verification_call_seconds is now DERIVED, computed as the
-- overlap between the buyer's segments and the supplier's segments (see
-- lib/callVerification.ts's computeOverlapSeconds), so credit only
-- accrues for time BOTH parties independently reported being on the call
-- at the same time — one party spamming fabricated segments with nobody
-- else ever reporting anything overlapping now earns zero credit,
-- instead of the whole requirement.
--
-- Not a perfect guarantee (two colluding accounts can still fabricate
-- matching fake segments without a real call — the same residual
-- collusion risk lib/orderService.ts's confirmCallCode has always
-- documented for the code-confirmation step), but it closes the "one
-- unilateral HTTP request, zero corroboration" hole entirely.
create table if not exists call_segments (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id),
  party text not null check (party in ('buyer', 'supplier')),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists call_segments_order_id_idx on call_segments(order_id);
