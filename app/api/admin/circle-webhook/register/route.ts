// app/api/admin/circle-webhook/register/route.ts
//
// One-time (idempotent) admin action: tells Circle where to send real
// webhook notifications (app/api/webhooks/circle/route.ts). Not run
// automatically on server boot, a real deployed HTTPS URL has to exist
// first, chicken-and-egg. Safe to call again after a redeploy, see
// CircleEscrowProvider.registerWebhook's own doc comment for why it
// won't create a duplicate subscription.
import { requireRole, logAudit } from "../../../../../lib/authz";
import { getCircleEscrowProvider } from "../../../../../lib/paymentProvider";
import { logInternalError } from "../../../../../lib/errorReference";

export async function POST(request: Request) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const circleProvider = getCircleEscrowProvider();
  if (!circleProvider) {
    return Response.json({ error: "Circle is not configured (CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET/ESCROW_WALLET_ID)." }, { status: 503 });
  }

  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  const endpointUrl = `${origin}/api/webhooks/circle`;
  if (!endpointUrl.startsWith("https://")) {
    return Response.json({ error: `Circle requires an HTTPS endpoint, got ${endpointUrl}. Register this from the real deployed URL.` }, { status: 400 });
  }

  try {
    const result = await circleProvider.registerWebhook(endpointUrl);
    await logAudit({
      actorEmail: auth.user.email,
      action: "circle_webhook_registered",
      target: endpointUrl,
      details: result,
      request,
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    const ref = logInternalError("circle-webhook register", err);
    return Response.json({ error: "Webhook registration failed. See server logs.", referenceCode: ref }, { status: 500 });
  }
}
