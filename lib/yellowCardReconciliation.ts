// lib/yellowCardReconciliation.ts
//
// The Yellow Card counterpart to lib/releaseReconciliation.ts's Circle
// sweep — a DB-driven backstop for "the webhook never arrived, or this
// process restarted mid-poll", independent of any one process's memory.
// app/api/webhooks/yellowcard/route.ts's own header comment already
// named this as real, bounded follow-up work ("worth building a
// lib/releaseReconciliation.ts-style sweep for this leg too if stuck
// funding/refund events turn out to be a real problem") — this is that
// sweep, for every leg that's genuinely still reachable via Yellow Card
// today.
//
// Deliberately covers THREE legs, not four: funding is wallet-first as
// of migration 0020 (lib/orderService.ts's fundOrder), always
// `provider: "wallet"`, always resolved synchronously in the same
// request — there is no code path left that puts an order into
// `payment_processing` and waits on a real Yellow Card funding receive,
// so a sweep for it would find nothing, ever. Refund is ALMOST always
// wallet-first too (creditWalletForRefund, same file) for the same
// reason, but initiateRefundForOrder falls back to a real Yellow Card
// refund when wasOrderFundedFromWallet is false — a real, if narrow,
// case (any order that predates wallet-first funding) — so refund stays
// in scope here. Settlement and wallet top-up were never wallet-routed
// to begin with, both fully in scope.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getYellowCardProvider, getYellowCardWalletTopupProvider } from "./paymentProvider";

// Same value and same reasoning as lib/releaseReconciliation.ts's
// STUCK_THRESHOLD_MS: long enough that a normal in-flight leg has had
// time to confirm via its own poll/webhook first (this is a backstop,
// not the primary path), short enough that a real stuck leg doesn't sit
// unnoticed for long between sweeps.
const STUCK_THRESHOLD_MS = 2 * 60 * 1000;

export interface LegSweepResult {
  checked: number;
  resolved: number;
  stillPending: number;
}

export interface YellowCardReconciliationResult {
  refunds: LegSweepResult;
  settlements: LegSweepResult;
  topups: LegSweepResult;
  skippedNoYellowCard: boolean;
}

const EMPTY_LEG: LegSweepResult = { checked: 0, resolved: 0, stillPending: 0 };

/** A no-op (skippedNoYellowCard: true) unless real Yellow Card
 * credentials are actually configured. Runs all three sweeps in
 * parallel, each independent — one leg's failure doesn't block the
 * others. */
export async function reconcileStuckYellowCardLegs(supabase: SupabaseClient): Promise<YellowCardReconciliationResult> {
  const provider = getYellowCardProvider();
  if (!provider) {
    return { refunds: EMPTY_LEG, settlements: EMPTY_LEG, topups: EMPTY_LEG, skippedNoYellowCard: true };
  }
  const walletTopupProvider = getYellowCardWalletTopupProvider();

  const [refunds, settlements, topups] = await Promise.all([
    reconcileRefunds(supabase, provider),
    reconcileSettlements(supabase, provider),
    walletTopupProvider ? reconcileTopups(supabase, walletTopupProvider) : Promise.resolve(EMPTY_LEG),
  ]);

  return { refunds, settlements, topups, skippedNoYellowCard: false };
}

/** Exported alongside the three per-leg sweeps below (not just the
 * combined reconcileStuckYellowCardLegs) so tests can exercise the
 * actual query/counting logic directly with a lightweight fake provider
 * — no need to fuss with real env vars or lib/paymentProvider.ts's
 * singleton wiring just to prove a stuck row gets found and counted
 * correctly. */
export async function reconcileRefunds(
  supabase: SupabaseClient,
  provider: NonNullable<ReturnType<typeof getYellowCardProvider>>
): Promise<LegSweepResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
  const { data: stuckOrders, error } = await supabase.from("orders").select("id").eq("status", "refund_processing").lt("updated_at", cutoff);
  if (error) throw error;

  let resolved = 0;
  let stillPending = 0;

  for (const row of (stuckOrders ?? []) as Array<{ id: number }>) {
    const orderId = row.id;
    // provider="yellow_card" specifically: a wallet-funded refund
    // (provider="wallet") resolves synchronously in the same request
    // that initiated it, an order funded that way is never actually
    // sitting at refund_processing by the time this sweep runs — this
    // filter is defensive/clarifying more than load-bearing.
    const { data: eventRow, error: eventError } = await supabase
      .from("payment_events")
      .select("provider_reference")
      .eq("order_id", orderId)
      .eq("leg", "refund")
      .eq("provider", "yellow_card")
      .not("provider_reference", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eventError) {
      console.error(`reconcileRefunds: failed to look up payment_events for order ${orderId}:`, eventError);
      continue;
    }
    const reference = (eventRow as { provider_reference: string } | null)?.provider_reference;
    if (!reference) continue; // no real Yellow Card refund on file for this order, nothing to re-check

    try {
      const reported = await provider.checkAndReportReceiveStatus(orderId, reference, "refund");
      if (reported) resolved += 1;
      else stillPending += 1;
    } catch (err) {
      console.error(`reconcileRefunds: checking order ${orderId} (receive ${reference}) failed:`, err);
      stillPending += 1;
    }
  }

  return { checked: (stuckOrders ?? []).length, resolved, stillPending };
}

export async function reconcileSettlements(
  supabase: SupabaseClient,
  provider: NonNullable<ReturnType<typeof getYellowCardProvider>>
): Promise<LegSweepResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
  const { data: stuckOrders, error } = await supabase.from("orders").select("id").eq("status", "settlement_processing").lt("updated_at", cutoff);
  if (error) throw error;

  let resolved = 0;
  let stillPending = 0;

  for (const row of (stuckOrders ?? []) as Array<{ id: number }>) {
    const orderId = row.id;
    const { data: eventRow, error: eventError } = await supabase
      .from("payment_events")
      .select("provider_reference")
      .eq("order_id", orderId)
      .eq("leg", "settlement")
      .not("provider_reference", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eventError) {
      console.error(`reconcileSettlements: failed to look up payment_events for order ${orderId}:`, eventError);
      continue;
    }
    const reference = (eventRow as { provider_reference: string } | null)?.provider_reference;
    if (!reference) continue; // release never actually reached the settlement-initiated step, nothing to re-check

    try {
      const reported = await provider.checkAndReportSettlementStatus(orderId, reference);
      if (reported) resolved += 1;
      else stillPending += 1;
    } catch (err) {
      console.error(`reconcileSettlements: checking order ${orderId} (send ${reference}) failed:`, err);
      stillPending += 1;
    }
  }

  return { checked: (stuckOrders ?? []).length, resolved, stillPending };
}

export async function reconcileTopups(
  supabase: SupabaseClient,
  walletTopupProvider: NonNullable<ReturnType<typeof getYellowCardWalletTopupProvider>>
): Promise<LegSweepResult> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
  // wallet_transactions has no updated_at column (migration
  // 0020_buyer_wallet.sql) — a top-up row's status flips exactly once,
  // confirmWalletTopup's own compare-and-swap makes a second write a
  // no-op, so staleness against created_at is exactly as meaningful as
  // updated_at would be here.
  const { data: stuckTopups, error } = await supabase
    .from("wallet_transactions")
    .select("provider_reference")
    .eq("type", "topup")
    .eq("status", "processing")
    .not("provider_reference", "is", null)
    .lt("created_at", cutoff);
  if (error) throw error;

  let resolved = 0;
  let stillPending = 0;

  for (const row of (stuckTopups ?? []) as Array<{ provider_reference: string }>) {
    try {
      const reported = await walletTopupProvider.checkAndReportTopupStatus(row.provider_reference);
      if (reported) resolved += 1;
      else stillPending += 1;
    } catch (err) {
      console.error(`reconcileTopups: checking receive ${row.provider_reference} failed:`, err);
      stillPending += 1;
    }
  }

  return { checked: (stuckTopups ?? []).length, resolved, stillPending };
}
