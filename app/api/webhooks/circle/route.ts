// app/api/webhooks/circle/route.ts
//
// Part 2 of the production-hardening pass: Circle's real webhook
// notification for the escrow-release leg, replacing "confirmation is
// only ever polled in-process" as the sole source of truth. Verified
// against the installed @circle-fin/developer-controlled-wallets SDK's
// own JSDoc, not guessed: Circle signs each notification POST with
// `X-Circle-Signature` + `X-Circle-Key-Id` headers, verifiable via
// client.getNotificationSignature() (lib/circleEscrowProvider.ts's
// verifyWebhookSignature, lib/circleWebhook.ts for the crypto).
//
// PAYLOAD SHAPE: confirmed against Circle's own published docs (not
// guessed), the wallets transactions-outbound/transactions-inbound
// notification references and the general notifications-quickstart
// envelope doc on developers.circle.com. Envelope:
//   { subscriptionId, notificationId, notificationType, notification, timestamp, version }
// `notification` for a transactions.inbound/transactions.outbound event
// matches the REST Transaction object exactly (id, state, txHash,
// errorReason, ...), the same shape client.getTransaction() returns.
// Circle also sends a one-time `notificationType: "webhooks.test"` ping
// with a `{hello:"world"}` body when a subscription is first created,
// handled below as an expected no-op.
//
// Reports directly from `notification`'s own state/txHash/errorReason
// (CircleEscrowProvider.reportWebhookNotification) rather than making a
// second client.getTransaction() call, now that the shape is confirmed
// to match the REST Transaction object exactly. Safe: the signature
// already proves this came from Circle, and downstream processing
// (handleReleaseConfirmed's order.status guard) is already idempotent
// against a stale/out-of-order delivery regardless of where the state
// came from, so a re-fetch bought no extra safety, only latency. Falls
// back to a real re-fetch (checkAndReportReleaseStatus) only if the
// body doesn't carry a usable `state`, e.g. an unrecognized shape.
//
// Register this endpoint with Circle via
// app/api/admin/circle-webhook/register/route.ts once deployed.
import { getCircleEscrowProvider } from "../../../../lib/paymentProvider";
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";

/** `notification` (root.notification, the confirmed shape) is returned
 * alongside the id so the caller can report directly from it without a
 * second lookup. root itself is kept as a harmless fallback candidate
 * only, in case a differently-shaped Circle product notification ever
 * lands on this same endpoint. */
function extractNotification(payload: unknown): { transactionId: string; notification: unknown } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  for (const candidate of [root.notification, root]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const obj = candidate as Record<string, unknown>;
    if (typeof obj.id === "string") return { transactionId: obj.id, notification: candidate };
  }
  return null;
}

export async function POST(request: Request) {
  const circleProvider = getCircleEscrowProvider();
  if (!circleProvider) {
    // No Circle credentials configured, this endpoint has nothing to do.
    return Response.json({ error: "Circle is not configured." }, { status: 503 });
  }

  const keyId = request.headers.get("x-circle-key-id");
  const signature = request.headers.get("x-circle-signature");
  if (!keyId || !signature) {
    console.error("Circle webhook: missing X-Circle-Key-Id or X-Circle-Signature header.");
    return Response.json({ error: "Missing signature headers." }, { status: 401 });
  }

  // Raw body text, not a re-serialized JSON.parse/stringify round trip,
  // which is not guaranteed to reproduce the exact bytes Circle signed.
  const rawBody = await request.text();

  let verified: boolean;
  try {
    verified = await circleProvider.verifyWebhookSignature(rawBody, keyId, signature);
  } catch (err) {
    console.error("Circle webhook: signature verification threw:", err);
    return Response.json({ error: "Signature verification failed." }, { status: 401 });
  }
  if (!verified) {
    console.error("Circle webhook: signature did not verify. Rejecting.");
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const notificationType = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).notificationType : undefined;
  if (notificationType === "webhooks.test") {
    // Circle's one-time ping when a subscription is first created (see
    // registerWebhook), expected, not an error, nothing to reconcile.
    return Response.json({ received: true });
  }

  const extracted = extractNotification(payload);
  if (!extracted) {
    console.error(`Circle webhook: no transaction id found in a signed, verified payload (notificationType: ${String(notificationType)}). Confirm the payload shape:`, payload);
    // 2xx anyway: this is a shape we don't recognize, not a security
    // failure, and returning an error would just make Circle retry the
    // same unrecognized shape forever.
    return Response.json({ received: true });
  }
  const { transactionId, notification } = extracted;

  const supabase = getSupabaseServerClient();
  const { data: eventRow } = await supabase
    .from("payment_events")
    .select("order_id")
    .eq("provider_reference", transactionId)
    .eq("leg", "release")
    .maybeSingle();

  const orderId = (eventRow as { order_id: number } | null)?.order_id;
  if (orderId == null) {
    console.error(`Circle webhook: verified notification for transaction ${transactionId} but no matching order found.`);
    return Response.json({ received: true });
  }

  try {
    // Reports directly from the notification body (see this file's
    // header for why that's safe now), falling back to a real
    // client.getTransaction() re-fetch only if the body lacks a usable
    // `state`.
    await circleProvider.reportWebhookNotification(orderId, transactionId, notification);
  } catch (err) {
    // Still 2xx: Circle would otherwise retry with the identical
    // payload, and app/api/cron/reconcile-releases will independently
    // catch this order regardless of whether this attempt succeeded.
    console.error(`Circle webhook: reportWebhookNotification failed for order ${orderId}, transaction ${transactionId}:`, err);
  }

  return Response.json({ received: true });
}
