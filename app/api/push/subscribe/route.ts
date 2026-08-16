// app/api/push/subscribe/route.ts
//
// Any authenticated role can subscribe, a push subscription is a
// per-device, per-user thing, not a role-gated action. Upserts on
// endpoint (migration 0009's unique constraint): re-subscribing the same
// device (e.g. after clearing the subscription and re-enabling) replaces
// its row instead of accumulating a duplicate. "Store subscriptions
// server-side per user PER DEVICE, one user may have several", this is
// additive per user, never a single-subscription-per-user replace.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";

export async function POST(request: Request) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : null;
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : null;
  const authKey = typeof body?.keys?.auth === "string" ? body.keys.auth : null;
  const userAgent = typeof body?.userAgent === "string" ? body.userAgent.slice(0, 300) : null;

  if (!endpoint || !p256dh || !authKey) {
    return Response.json({ error: "endpoint and keys.p256dh/keys.auth are required." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: auth.user.id,
      endpoint,
      p256dh,
      auth: authKey,
      user_agent: userAgent,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" }
  );

  if (error) {
    console.error("push subscribe: upsert failed:", error);
    return Response.json({ error: "Couldn't save your subscription. Try again." }, { status: 500 });
  }

  return Response.json({ success: true });
}
