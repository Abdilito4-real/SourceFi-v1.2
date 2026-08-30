-- 0020_buyer_wallet.sql
--
-- Buyer pre-funded wallet balance: a buyer tops up a platform balance
-- ahead of time and funds orders instantly from it, instead of a fresh
-- Yellow Card bank-transfer request per order. fundOrder() (lib/orderService.ts)
-- becomes wallet-first from this migration on — a real, user-visible
-- behavior change to the live funding flow, not an addition alongside it.
--
-- UPDATED: the actual external top-up call (buyer's real money going
-- INTO this balance) is real now, via lib/yellowCardWalletTopupProvider.ts
-- once YELLOW_CARD_API_KEY/YELLOW_CARD_SECRET_KEY are set
-- (lib/walletService.ts's StubWalletTopupProvider is only the fallback
-- when they aren't). Still deliberately one-way, though, and that part
-- hasn't changed: Yellow Card's refund API refunds exactly one original
-- receive, in full, no amount parameter — there is no documented way to
-- give a buyer back an unspent PORTION of a top-up once some of it has
-- been spent across multiple orders, so there's still no withdrawal
-- path, real or otherwise. See docs/payment-integration.md's "Buyer
-- wallet" section.
--
-- Deliberately NOT part of the ledger_entries double-entry system:
-- ledger_entries.order_id is NOT NULL by design (0004_marketplace_pivot.sql),
-- an intentional "every ledger transaction is real order money movement"
-- invariant, and a top-up has no order yet. Money only enters
-- ledger_entries (via the existing, UNCHANGED recordFundingConfirmed)
-- the moment it actually leaves the wallet to fund a specific order.
create table if not exists buyer_wallets (
  user_id bigint primary key references users(id),
  balance_minor bigint not null default 0 check (balance_minor >= 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  updated_at timestamptz not null default now()
);

-- Append-only audit trail: topups (order_id null), spends against a
-- specific order (order_funding), and refunds credited back
-- (refund_to_wallet). `wasOrderFundedFromWallet`-style lookups
-- (lib/orderService.ts, lib/walletService.ts) query this by order_id +
-- type='order_funding' to decide whether a refund should credit the
-- wallet instead of calling Yellow Card's refund endpoint.
create table if not exists wallet_transactions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users(id),
  type text not null check (type in ('topup', 'order_funding', 'refund_to_wallet')),
  amount_minor bigint not null check (amount_minor > 0),
  order_id bigint references orders(id),
  provider_reference text,
  status text not null check (status in ('processing', 'confirmed', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists idx_wallet_transactions_user on wallet_transactions (user_id);
create index if not exists idx_wallet_transactions_order on wallet_transactions (order_id);

-- Two atomic Postgres functions, same "insert-if-missing, then select
-- ... for update, then read-modify-write" shape as 0016_rate_limiting.sql's
-- rl_record_failure/rl_check_quota — the one precedent in this repo for a
-- must-never-race balance-style operation. wallet_debit's row lock is
-- what actually makes concurrent double-spend impossible; the app layer
-- (lib/walletService.ts) never reads-then-writes the balance itself.
create or replace function wallet_credit(p_user_id bigint, p_amount_minor bigint)
returns bigint as $$
declare
  v_balance bigint;
begin
  insert into buyer_wallets (user_id, balance_minor)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance_minor into v_balance from buyer_wallets where user_id = p_user_id for update;

  v_balance := v_balance + p_amount_minor;
  update buyer_wallets set balance_minor = v_balance, updated_at = now() where user_id = p_user_id;

  return v_balance;
end;
$$ language plpgsql;

-- Raises a distinct, greppable exception (not a returned boolean) on
-- insufficient balance, deliberately: lib/walletService.ts's
-- debitWalletForOrder() catches it and re-queries the real balance to
-- report an accurate shortfall, rather than trusting a stale read from
-- before the lock was taken.
create or replace function wallet_debit(p_user_id bigint, p_amount_minor bigint)
returns bigint as $$
declare
  v_balance bigint;
begin
  insert into buyer_wallets (user_id, balance_minor)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance_minor into v_balance from buyer_wallets where user_id = p_user_id for update;

  if v_balance < p_amount_minor then
    raise exception 'insufficient_wallet_balance: balance % is less than requested debit %', v_balance, p_amount_minor;
  end if;

  v_balance := v_balance - p_amount_minor;
  update buyer_wallets set balance_minor = v_balance, updated_at = now() where user_id = p_user_id;

  return v_balance;
end;
$$ language plpgsql;

alter table buyer_wallets enable row level security;
alter table wallet_transactions enable row level security;

-- Same posture as buyer_kyc_profiles_select_own (migration 0018):
-- self-only, extends the real RLS pilot rather than leaving new
-- financial tables on default-deny-only. App routes still read/write
-- through the existing service-role client + explicit buyer_id
-- ownership check (the RLS-scoped client in lib/supabaseUserClient.ts
-- is only piloted on orders/supplier_profiles today, not extended here).
create policy buyer_wallets_select_own on buyer_wallets
  for select to authenticated
  using (user_id = current_app_user_id());

create policy wallet_transactions_select_own on wallet_transactions
  for select to authenticated
  using (user_id = current_app_user_id());

-- payment_events.provider's check constraint (0004_marketplace_pivot.sql:264)
-- only allowed 'yellow_card'/'circle'. A wallet-funded order fires its
-- funding/refund confirmation through the exact same
-- handlePaymentStatusEvent consumer (lib/orderService.ts) as those two,
-- with provider: "wallet", so the same table needs to accept it.
alter table payment_events drop constraint if exists payment_events_provider_check;
alter table payment_events add constraint payment_events_provider_check
  check (provider in ('yellow_card', 'circle', 'wallet'));
