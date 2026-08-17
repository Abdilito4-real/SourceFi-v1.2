-- 0012_call_presence.sql
--
-- Live "who's in the verification call right now" state, so the other
-- party can get an incoming-call prompt instead of having to already be
-- looking at the order. Null = not currently in the call. Set on join,
-- refreshed by a client heartbeat while in-call (see JitsiMeetRoom.tsx),
-- cleared on a clean leave. A crashed tab that never reports "left"
-- just goes stale, readers treat anything older than ~45s as inactive
-- (see OrderDetailsModal.tsx), so this never needs to be trusted as
-- exact, only as a recent heartbeat.
alter table orders add column if not exists buyer_call_active_since timestamptz;
alter table orders add column if not exists supplier_call_active_since timestamptz;
