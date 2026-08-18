-- 0014_release_usdc_split.sql
--
-- Persists the USDC split actually used for a real Circle release, at
-- the moment it's sent (lib/circleEscrowProvider.ts), now that
-- lib/orderService.ts's computeUsdcSplit uses a LIVE NGN/USD rate
-- (lib/fxRate.ts) instead of a fixed constant. The rate can move
-- between release-initiation and release-confirmation (which arrives
-- later, via polling), so the ledger entry booked at confirmation time
-- (handleReleaseConfirmed/handleSettlementConfirmed) must read this
-- persisted value back rather than recompute, or it could silently stop
-- matching the amount actually sent on-chain. Null for orders that
-- never went through a real release (the stub provider's simulated
-- path, or any order settled before this migration).
alter table orders add column if not exists release_usdc_total_minor integer;
alter table orders add column if not exists release_usdc_platform_fee_minor integer;
alter table orders add column if not exists release_ngn_per_usd numeric;
