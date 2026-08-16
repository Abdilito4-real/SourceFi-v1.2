-- 0008_call_room_privacy.sql
--
-- The verification call's Jitsi room was named SourceFi_<order_code>,
-- and order_code is a 6-digit Math.random() string shown to users
-- (ORD-482913) — guessable/brute-forceable, and meet.jit.si has no idea
-- who our buyer/supplier are, so anyone with the room name could join a
-- "private" call. This column holds a real random UUID (122 bits of
-- entropy, generated server-side via crypto.randomUUID() in
-- lib/orderService.ts, never derived from anything user-visible) that
-- becomes the actual room name instead. Nullable + no default: existing
-- rows are backfilled lazily on first read by ensureCallRoomId() rather
-- than requiring a data migration here. Additive, idempotent, safe to
-- re-run.
alter table orders
  add column if not exists verification_call_room_id text;
