// app/api/notifications/read-all/route.ts
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";

export async function POST() {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", auth.user.id)
    .is("read_at", null);

  if (error) return Response.json({ error: "Failed to mark all as read." }, { status: 500 });
  return Response.json({ success: true });
}
