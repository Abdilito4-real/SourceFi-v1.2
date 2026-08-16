// app/api/push/unsubscribe/route.ts
//
// Deletes by (endpoint, owning user), never lets a caller delete a
// subscription that isn't theirs, same ownership discipline as every
// other mutation in this app.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";

export async function POST(request: Request) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : null;
  if (!endpoint) return Response.json({ error: "endpoint is required." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", auth.user.id);
  if (error) return Response.json({ error: "Couldn't remove your subscription." }, { status: 500 });

  return Response.json({ success: true });
}
