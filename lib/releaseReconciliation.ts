// lib/releaseReconciliation.ts
//
// The durable backstop for "confirmation lost if the process restarts
// mid-poll" (lib/circleEscrowProvider.ts's former single point of
// failure). Finds orders stuck at release_submitted/release_processing
// longer than expected and re-checks each one's real state with Circle,
// independent of whatever this process's own in-memory poll loop was or
// wasn't doing. Meant to run on a schedule (see
// app/api/cron/reconcile-releases/route.ts), not from a request path.
//
// Deliberately a separate file from lib/orderService.ts: this needs a
// concrete CircleEscrowProvider (for checkAndReportReleaseStatus), and
// circleEscrowProvider.ts already imports FROM orderService.ts
// (computeUsdcSplit) — importing orderService.ts's internals back into a
// file circleEscrowProvider.ts-adjacent code would risk a circular
// import. This file only needs plain Supabase queries plus the payment
// boundary, no orderService import required at all: checkAndReportReleaseStatus
// already reports through the SAME onStatusUpdate callback
// lib/paymentProvider.ts wired up to handlePaymentStatusEvent.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCircleEscrowProvider } from "./paymentProvider";

/** How long an order can sit at release_submitted/release_processing
 * before this sweep re-checks it with Circle. Long enough that a normal
 * in-flight release has had time to confirm via the poll or webhook
 * first (this is a backstop, not the primary path), short enough that a
 * real stuck release doesn't sit unnoticed for long between sweeps. */
const STUCK_THRESHOLD_MS = 2 * 60 * 1000;

export interface ReconciliationResult {
  checked: number;
  resolved: number;
  stillPending: number;
  skippedNoCircle: boolean;
}

/** A no-op (skippedNoCircle: true) unless real Circle credentials are
 * actually configured — the stub provider resolves every leg on its own
 * short in-process timer already, there's no real Circle transaction to
 * re-check and nothing for this sweep to do. */
export async function reconcileStuckReleases(supabase: SupabaseClient): Promise<ReconciliationResult> {
  const circleProvider = getCircleEscrowProvider();
  if (!circleProvider) {
    return { checked: 0, resolved: 0, stillPending: 0, skippedNoCircle: true };
  }

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
  const { data: stuckOrders, error } = await supabase
    .from("orders")
    .select("id")
    .in("status", ["release_submitted", "release_processing"])
    .lt("updated_at", cutoff);
  if (error) throw error;

  let resolved = 0;
  let stillPending = 0;

  for (const row of (stuckOrders ?? []) as Array<{ id: number }>) {
    const orderId = row.id;

    // The most recent release-leg payment_events row with a provider
    // reference on file, that's the Circle transaction id
    // attemptEscrowRelease persisted the moment Circle accepted the
    // request (see lib/orderService.ts). An order with NO such reference
    // never got that far, Circle was never told about it, so there is
    // nothing to re-check here, that's app/api/admin/orders/[id]/retry-release's
    // job instead, not this sweep's.
    const { data: eventRow, error: eventError } = await supabase
      .from("payment_events")
      .select("provider_reference")
      .eq("order_id", orderId)
      .eq("leg", "release")
      .not("provider_reference", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eventError) {
      console.error(`reconcileStuckReleases: failed to look up payment_events for order ${orderId}:`, eventError);
      continue;
    }
    const reference = (eventRow as { provider_reference: string } | null)?.provider_reference;
    if (!reference) continue;

    try {
      const reported = await circleProvider.checkAndReportReleaseStatus(orderId, reference);
      if (reported) resolved += 1;
      else stillPending += 1;
    } catch (err) {
      console.error(`reconcileStuckReleases: checking order ${orderId} (transaction ${reference}) failed:`, err);
      stillPending += 1;
    }
  }

  return { checked: (stuckOrders ?? []).length, resolved, stillPending, skippedNoCircle: false };
}
