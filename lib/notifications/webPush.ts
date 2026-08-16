// lib/notifications/webPush.ts
//
// The one place VAPID keys and the `web-push` library are touched
// mirrors lib/paymentProvider.ts's "one place, swap later" posture.
// VAPID_PRIVATE_KEY is read from process.env ONLY, server-side, never
// exposed as NEXT_PUBLIC_ or bundled into client JS. The public key is
// legitimately public (it identifies this app server to the push
// service, not a secret) but is still served at runtime, via
// GET /api/push/vapid-public-key, rather than baked into the client
// bundle as a build-time NEXT_PUBLIC_ var.
import "server-only";
import webpush from "web-push";

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:support@sourcefi.app";
  if (!publicKey || !privateKey) {
    throw new Error(
      "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set. Generate a pair with `npx web-push generate-vapid-keys` and add them to .env.local."
    );
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

/** Not a secret, safe to return to any caller, including an
 * unauthenticated one (see app/api/push/vapid-public-key/route.ts). Null
 * when VAPID isn't configured at all, so the client can degrade to "push
 * isn't available" instead of a confusing subscribe failure. */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export interface PushPayload {
  category: string;
  eventType: string;
  resourceType: string | null;
  resourceId: number | null;
  notificationId: number;
  tag: string;
  /** Lock-screen-safe. See lib/notifications/dispatch.ts's NotifyInput
   * doc comment for the payload-security contract this must already
   * satisfy by the time it reaches here, this module doesn't re-check
   * it, the caller owns that. */
  title: string;
  body: string;
  deepLink: string | null;
}

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendResult = "ok" | "gone" | "error";

/** Sends to one subscription. 'gone' means the push service returned
 * 404/410, the subscription is dead and the caller should delete it
 * (feedback-layer rule: "Handle 404/410 responses by deleting dead
 * subscriptions"). 'error' is anything else, transient, don't delete on
 * a blip. */
export async function sendPushToSubscription(sub: PushSubscriptionRow, payload: PushPayload): Promise<SendResult> {
  ensureConfigured();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return "ok";
  } catch (err) {
    const statusCode = (err as { statusCode?: number } | null)?.statusCode;
    if (statusCode === 404 || statusCode === 410) return "gone";
    console.error(`Push send failed for subscription ${sub.id}:`, err);
    return "error";
  }
}
