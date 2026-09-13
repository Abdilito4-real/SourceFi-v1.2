// app/api/webhooks/yellowcard/route.ts
//
// Yellow Card's real webhook notification for the funding/refund legs,
// same shape as app/api/webhooks/circle/route.ts. Confirmed against
// their published docs (docs.yellowcard.engineering/docs/webhooks-api):
// a single `X-YC-Signature` header, base64 HMAC-SHA256 of the raw body
// (lib/yellowCardAuth.ts's verifyYellowCardWebhookSignature). Payload:
//   { id, sequenceId, status, apiKey, event, errorCode?, sessionId, executedAt }
// — a lightweight status ping, NO amounts, so exactly like the Circle
// webhook this only triggers a re-fetch
// (YellowCardProvider.checkAndReportReceiveStatus, the same call the
// reconciliation cron would use), never trusted for money-relevant
// state directly.
//
// `event` distinguishes funding vs. refund notifications
// (RECEIVE.COMPLETE/FAILED/... vs. something REFUND-related) — the
// docs' worked examples only showed funding-leg event names
// (RECEIVE.*), a refund-specific event name still isn't spelled out
// verbatim anywhere. RE-CHECKED against docs.yellowcard.engineering/docs/
// cancellation-refunds-collection-requests, though, and it's better-
// supported than a bare guess now: Yellow Card's own documented refund
// STATUS vocabulary for a receive is exactly `pending_refund` /
// `refunded` / `refund_failed` (all three containing "REFUND"),
// matching lib/yellowCardProvider.ts's checkAndReportReceiveStatus,
// which already checks for exactly "refunded"/"refund_failed" — that
// part is now confirmed, not inferred. The webhook `event` string
// itself (as opposed to the status value returned by a GET) still
// isn't shown verbatim, so this still checks for "REFUND" in the event
// string defensively rather than assuming an exact name — but that
// heuristic is now well-supported by the confirmed status vocabulary,
// not a bare guess. Confirm the literal event string against a live
// refund notification once sandbox credentials exist, same as before.
//
// UPDATED, real settlement: also resolves a notification against the
// leg='settlement' payment_events row lib/circleEscrowProvider.ts's
// initiateEscrowRelease now writes (a Yellow Card Send, not a
// Receive — a different resource, a different `id` namespace, but the
// exact same webhook envelope/signature scheme, one registration
// already covers it). Confirmed real event names for this specific
// flow are NOT settled (docs.yellowcard.engineering is mid-migration
// from legacy PAYMENT.*/SETTLEMENT.* names to v2 SEND.*/CRYPTO_SEND.*/
// CONVERT.*, and the one guide page describing this flow still shows
// the legacy names) — this route doesn't gate on `event` at all for
// the settlement branch, it just checks whether the `id` matches a
// pending settlement, same "the DB record proves relevance, not a
// guessed string match" approach a receive-vs-refund inference doesn't
// get to use.
//
// Register this endpoint via
// app/api/admin/yellowcard-webhook/register/route.ts once deployed —
// one registration covers every notification Yellow Card ever sends
// here, funding/refund/settlement/wallet-top-up alike, it's per-URL,
// not per-leg.
import { getYellowCardProvider, getYellowCardWalletTopupProvider } from "../../../../lib/paymentProvider";
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";

export async function POST(request: Request) {
  const provider = getYellowCardProvider();
  if (!provider) {
    return Response.json({ error: "Yellow Card is not configured." }, { status: 503 });
  }

  const signature = request.headers.get("x-yc-signature");
  if (!signature) {
    console.error("Yellow Card webhook: missing X-YC-Signature header.");
    return Response.json({ error: "Missing signature header." }, { status: 401 });
  }

  const rawBody = await request.text();
  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    console.error("Yellow Card webhook: signature did not verify. Rejecting.");
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const root = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const receiveId = typeof root?.id === "string" ? root.id : null;
  const event = typeof root?.event === "string" ? root.event : "";

  if (!receiveId) {
    console.error("Yellow Card webhook: no id found in a signed, verified payload. Confirm the payload shape:", payload);
    return Response.json({ received: true });
  }

  const leg: "funding" | "refund" = event.toUpperCase().includes("REFUND") ? "refund" : "funding";

  const supabase = getSupabaseServerClient();
  const { data: eventRow } = await supabase
    .from("payment_events")
    .select("order_id")
    .eq("provider_reference", receiveId)
    .eq("leg", leg)
    .maybeSingle();

  // A refund notification's provider_reference is the SAME receive id
  // the original funding leg used (see initiateRefund), not a distinct
  // refund reference — fall back to the funding leg's row if a
  // leg='refund' row isn't found yet (the refund's own payment_events
  // row, if this codebase ever writes one, would only exist after the
  // refund was initiated).
  const orderId = (eventRow as { order_id: number } | null)?.order_id ?? (await lookupOrderIdByFundingReference(supabase, receiveId));

  if (orderId != null) {
    try {
      await provider.checkAndReportReceiveStatus(orderId, receiveId, leg);
    } catch (err) {
      // Still 2xx: Yellow Card would otherwise retry with the identical
      // payload. No reconciliation cron exists yet for this leg (see
      // docs/payment-integration.md), so a failure here is currently only
      // caught by the same webhook retrying — worth building a
      // lib/releaseReconciliation.ts-style sweep for this leg too if
      // stuck funding/refund events turn out to be a real problem.
      console.error(`Yellow Card webhook: checkAndReportReceiveStatus failed for order ${orderId}, receive ${receiveId}:`, err);
    }
    return Response.json({ received: true });
  }

  // Not a funding/refund receive — check whether it's a real settlement
  // send instead (lib/circleEscrowProvider.ts's initiateEscrowRelease,
  // see this file's header). checkAndReportSettlementStatus re-fetches
  // the authoritative state itself (GET /business/send/{id}), same
  // "never trust the webhook body for money-relevant state" posture as
  // every other leg here.
  const { data: settlementEventRow } = await supabase
    .from("payment_events")
    .select("order_id")
    .eq("provider_reference", receiveId)
    .eq("leg", "settlement")
    .maybeSingle();
  const settlementOrderId = (settlementEventRow as { order_id: number } | null)?.order_id ?? null;
  if (settlementOrderId != null) {
    try {
      await provider.checkAndReportSettlementStatus(settlementOrderId, receiveId);
    } catch (err) {
      console.error(`Yellow Card webhook: checkAndReportSettlementStatus failed for order ${settlementOrderId}, send ${receiveId}:`, err);
    }
    return Response.json({ received: true });
  }

  // Not an order-scoped receive/send either — check whether it's a
  // buyer wallet top-up instead (migration 0020_buyer_wallet.sql), a
  // real receive Yellow Card sends the exact same notification shape
  // for, just never tied to an order in payment_events (there's no
  // order to tie it to at top-up time). walletTopupProvider is null if
  // Yellow Card isn't configured, but `provider` above already returned
  // 503 in that case, so this is only reachable when it genuinely is.
  const walletTopupProvider = getYellowCardWalletTopupProvider();
  if (walletTopupProvider) {
    try {
      const handled = await walletTopupProvider.checkAndReportTopupStatus(receiveId);
      if (handled) return Response.json({ received: true });
    } catch (err) {
      console.error(`Yellow Card webhook: checkAndReportTopupStatus failed for receive ${receiveId}:`, err);
      return Response.json({ received: true });
    }
  }

  console.error(`Yellow Card webhook: verified notification for receive/send ${receiveId} (event: ${event || "(none)"}) matched no order, no settlement, and no wallet top-up.`);
  return Response.json({ received: true });
}

async function lookupOrderIdByFundingReference(supabase: ReturnType<typeof getSupabaseServerClient>, receiveId: string): Promise<number | null> {
  const { data } = await supabase.from("payment_events").select("order_id").eq("provider_reference", receiveId).eq("leg", "funding").maybeSingle();
  return (data as { order_id: number } | null)?.order_id ?? null;
}
