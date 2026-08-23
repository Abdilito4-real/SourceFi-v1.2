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
// (RECEIVE.*), a refund-specific event name isn't documented as
// explicitly. Inferred defensively below (checked for "REFUND" in the
// event string) rather than assumed; confirm the real event name
// against a live refund notification once sandbox credentials exist.
//
// Register this endpoint via
// app/api/admin/yellowcard-webhook/register/route.ts once deployed.
import { getYellowCardProvider } from "../../../../lib/paymentProvider";
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
  if (orderId == null) {
    console.error(`Yellow Card webhook: verified notification for receive ${receiveId} but no matching order found.`);
    return Response.json({ received: true });
  }

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

async function lookupOrderIdByFundingReference(supabase: ReturnType<typeof getSupabaseServerClient>, receiveId: string): Promise<number | null> {
  const { data } = await supabase.from("payment_events").select("order_id").eq("provider_reference", receiveId).eq("leg", "funding").maybeSingle();
  return (data as { order_id: number } | null)?.order_id ?? null;
}
