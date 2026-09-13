-- 0021_rls_expand_pilot.sql
--
-- Extends the real RLS pilot (0017_orders_rls_pilot.sql) from
-- orders/supplier_profiles to the next 9 tables, exactly the follow-up
-- docs/security.md named: "Extending the pattern table-by-table
-- (payment_events, disputes, notifications, ...) is real, bounded
-- follow-up work now that the hard part (the JWT bridge itself)
-- exists." That JWT bridge (lib/supabaseUserClient.ts,
-- current_app_user_id() below, already defined by 0017) doesn't
-- change here — this migration is purely more policies for it to run
-- against, reused as-is.
--
-- SELECT-only, on purpose, same posture as 0017: a wrong SELECT policy
-- just hides a row behind the existing app-layer check and
-- service-role fallback that stay in place regardless; a wrong
-- INSERT/UPDATE policy could break a real write. No write path is
-- touched by this migration or by the route changes that pair with it.
--
-- Two shapes:
--   1. Order-scoped (payment_events, delivery_proofs, disputes,
--      ratings): visible to either party of that order, mirroring
--      orders_select_own's own buyer_id/supplier_id check exactly, via
--      a subquery into orders — these tables have no buyer_id/
--      supplier_id of their own to check directly (ratings does, but
--      the order_id path keeps all four identical and equally
--      correct).
--   2. Self-scoped (notifications, notification_preferences,
--      supplier_verification_applications): a direct
--      user_id = current_app_user_id() check.
--
-- NOT included, on purpose:
--   - buyer_kyc_profiles, buyer_wallets, wallet_transactions,
--     supplier_payout_profiles already have this exact self-only
--     policy shape, created alongside their own tables (migrations
--     0018/0019/0020) — re-declaring any of them here would fail with
--     "policy already exists". They were simply never wired into a
--     route until this same change: see
--     app/api/wallet/route.ts and app/api/buyer-kyc/me/route.ts, now
--     updated to actually use the authenticated-role client and
--     exercise those existing policies for the first time.
--     wallet_transactions and supplier_payout_profiles stay unwired —
--     no GET route reads either one yet (a transaction-history screen,
--     a "view my payout bank details" screen) — their policies remain
--     inert until one exists, same as before this migration.

create policy payment_events_select_own on payment_events
  for select to authenticated
  using (
    order_id in (
      select id from orders
      where buyer_id = current_app_user_id()
         or supplier_id in (select id from supplier_profiles where user_id = current_app_user_id())
    )
  );

create policy delivery_proofs_select_own on delivery_proofs
  for select to authenticated
  using (
    order_id in (
      select id from orders
      where buyer_id = current_app_user_id()
         or supplier_id in (select id from supplier_profiles where user_id = current_app_user_id())
    )
  );

create policy disputes_select_own on disputes
  for select to authenticated
  using (
    order_id in (
      select id from orders
      where buyer_id = current_app_user_id()
         or supplier_id in (select id from supplier_profiles where user_id = current_app_user_id())
    )
  );

create policy ratings_select_own on ratings
  for select to authenticated
  using (
    order_id in (
      select id from orders
      where buyer_id = current_app_user_id()
         or supplier_id in (select id from supplier_profiles where user_id = current_app_user_id())
    )
  );

create policy notifications_select_own on notifications
  for select to authenticated
  using (user_id = current_app_user_id());

create policy notification_preferences_select_own on notification_preferences
  for select to authenticated
  using (user_id = current_app_user_id());

create policy supplier_verification_applications_select_own on supplier_verification_applications
  for select to authenticated
  using (user_id = current_app_user_id());
