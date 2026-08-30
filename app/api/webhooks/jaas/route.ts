// app/api/webhooks/jaas/route.ts
//
// 8x8 JaaS's real webhook notification for the verification call —
// closes the one gap the client-reported corroboration in
// lib/orderService.ts's recordVerificationCallProgress explicitly
// documents as unclosed: two colluding accounts fabricating matching
// segments with no real call ever happening. This route is what makes
// verification_call_seconds authoritative instead of merely
// corroborated-between-two-untrusted-reports, see
// lib/orderService.ts's applyJaasWebhookPresence for the actual logic.
//
// Confirmed against developer.8x8.com/jaas/docs (Events, Payload
// structure, Check the webhook signatures pages) — including a full
// worked signature example, reproduced byte-for-byte in
// tests/jaasWebhookAuth.test.ts, so unlike Yellow Card's webhook side
// this one is CONFIRMED correct, not inferred from prose alone.
//
// Registration is manual, not an API call: JaaS Console -> Webhooks ->
// add an endpoint at this route's URL, select PARTICIPANT_JOINED and
// PARTICIPANT_LEFT, then "Reveal secret" and set it as
// JAAS_WEBHOOK_SECRET. See README.md's "Still open" section.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { verifyJaasWebhookSignature, isJaasWebhookConfigured } from "../../../../lib/jaasWebhookAuth";
import { applyJaasWebhookPresence } from "../../../../lib/orderService";

export async function POST(request: Request) {
  if (!isJaasWebhookConfigured()) {
    return Response.json({ error: "JaaS webhooks are not configured." }, { status: 503 });
  }
  const secret = process.env.JAAS_WEBHOOK_SECRET as string;

  const signatureHeader = request.headers.get("x-jaas-signature");
  if (!signatureHeader) {
    console.error("JaaS webhook: missing X-Jaas-Signature header.");
    return Response.json({ error: "Missing signature header." }, { status: 401 });
  }

  const rawBody = await request.text();
  const verification = verifyJaasWebhookSignature(rawBody, signatureHeader, secret);
  if (!verification.valid) {
    console.error("JaaS webhook: signature did not verify. Rejecting.");
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const root = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const eventType = typeof root?.eventType === "string" ? root.eventType : "";
  const fqn = typeof root?.fqn === "string" ? root.fqn : "";
  const timestampMs = typeof root?.timestamp === "number" ? root.timestamp : null;
  const data = typeof root?.data === "object" && root.data !== null ? (root.data as Record<string, unknown>) : null;

  // Only the two events the corroboration engine needs. Every other
  // eventType (recordings, transcriptions, chat, polls, reactions, ...)
  // is genuinely irrelevant here — still 2xx, this is JaaS correctly
  // notifying about something this endpoint just doesn't act on, not a
  // failure.
  if (eventType !== "PARTICIPANT_JOINED" && eventType !== "PARTICIPANT_LEFT") {
    return Response.json({ received: true });
  }

  const appId = process.env.JAAS_APP_ID;
  // fqn is "[AppID]/[room name]" per JaaS's own docs. Requiring it to
  // start with THIS app's own appId is defense in depth: the signature
  // above already proves the event came from whichever endpoint this
  // exact secret was issued for (JaaS secrets are per-endpoint), but
  // there's no reason to also trust an event for a room under some
  // other tenant if one ever arrived.
  if (!appId || !fqn.startsWith(`${appId}/`)) {
    console.error(`JaaS webhook: verified event's fqn "${fqn}" doesn't match this app's own appId, ignoring.`);
    return Response.json({ received: true });
  }
  const roomId = fqn.slice(appId.length + 1);
  const participantUserId = typeof data?.id === "string" ? data.id : null;
  if (!roomId || !participantUserId || timestampMs === null) {
    console.error("JaaS webhook: verified payload missing roomId/participant id/timestamp, ignoring:", payload);
    return Response.json({ received: true });
  }

  const supabase = getSupabaseServerClient();
  const { data: order } = await supabase
    .from("orders")
    .select("id, buyer_id, supplier_id")
    .eq("verification_call_room_id", roomId)
    .maybeSingle();
  if (!order) {
    // Not necessarily a problem — a stale/rotated room id, or an event
    // for a room this app never created (shouldn't happen given the
    // appId check above, but not fatal either way).
    return Response.json({ received: true });
  }

  let party: "buyer" | "supplier" | null = null;
  if (participantUserId === String(order.buyer_id)) {
    party = "buyer";
  } else {
    const { data: profile } = await supabase.from("supplier_profiles").select("id, user_id").eq("id", order.supplier_id).maybeSingle();
    if (profile && participantUserId === String(profile.user_id)) party = "supplier";
  }
  if (!party) {
    // A participant who joined this room but isn't the buyer or the
    // assigned supplier per THIS app's own JWT-issued identity — the
    // JWT only ever gets minted for those two (lib/jaasAuth.ts), so
    // this shouldn't happen; log it rather than silently drop it.
    console.error(`JaaS webhook: participant ${participantUserId} in order ${order.id}'s room is neither the buyer nor the assigned supplier.`);
    return Response.json({ received: true });
  }

  try {
    await applyJaasWebhookPresence(supabase, order.id, party, eventType === "PARTICIPANT_JOINED", new Date(timestampMs).toISOString());
  } catch (err) {
    // Still 2xx: JaaS would otherwise retry with the identical payload,
    // and applyJaasWebhookPresence's own idempotency guard (see its
    // comment) means a retry after a transient failure here is safe.
    console.error(`JaaS webhook: applyJaasWebhookPresence failed for order ${order.id}, party ${party}, event ${eventType}:`, err);
  }

  return Response.json({ received: true });
}
