// app/api/push/vapid-public-key/route.ts
//
// Deliberately unauthenticated, the VAPID public key isn't a secret (see
// lib/notifications/webPush.ts), and the client needs it before it can
// even attempt PushManager.subscribe(). Served at runtime rather than
// baked into the bundle as NEXT_PUBLIC_, see that file's comment for why.
import { getVapidPublicKey } from "../../../../lib/notifications/webPush";

export async function GET() {
  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    return Response.json({ error: "Push notifications are not configured on this server yet." }, { status: 501 });
  }
  return Response.json({ publicKey });
}
