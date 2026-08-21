// app/api/admin/yellowcard-webhook/register/route.ts
//
// One-time (idempotent) admin action, mirrors
// app/api/admin/circle-webhook/register/route.ts exactly: tells Yellow
// Card where to send real webhook notifications
// (app/api/webhooks/yellowcard/route.ts). Not run automatically on
// server boot, a real deployed HTTPS URL has to exist first.
import { requireRole, logAudit } from "../../../../../lib/authz";
import { getYellowCardProvider } from "../../../../../lib/paymentProvider";
import { logInternalError } from "../../../../../lib/errorReference";

export async function POST(request: Request) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const provider = getYellowCardProvider();
  if (!provider) {
    return Response.json({ error: "Yellow Card is not configured (YELLOW_CARD_API_KEY/YELLOW_CARD_SECRET_KEY)." }, { status: 503 });
  }

  const origin = request.headers.get("origin") ?? new URL(request.url).origin;
  const endpointUrl = `${origin}/api/webhooks/yellowcard`;
  if (!endpointUrl.startsWith("https://")) {
    return Response.json({ error: `Yellow Card requires an HTTPS endpoint, got ${endpointUrl}. Register this from the real deployed URL.` }, { status: 400 });
  }

  try {
    const result = await provider.registerWebhook(endpointUrl);
    await logAudit({
      actorEmail: auth.user.email,
      action: "yellowcard_webhook_registered",
      target: endpointUrl,
      details: result,
      request,
    });
    return Response.json({ success: true, ...result });
  } catch (err) {
    const ref = logInternalError("yellowcard-webhook register", err);
    return Response.json({ error: "Webhook registration failed. See server logs.", referenceCode: ref }, { status: 500 });
  }
}
