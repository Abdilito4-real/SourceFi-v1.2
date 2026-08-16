-- 0007_verification_call.sql
--
-- Cumulative real in-call seconds toward the mandatory pre-approval
-- verification call (design doc's live-session requirement). Additive,
-- idempotent, safe to re-run.
alter table orders
  add column if not exists verification_call_seconds integer not null default 0;
