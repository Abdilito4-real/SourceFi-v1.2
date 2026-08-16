// app/api/notifications/[id]/read/route.ts
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const notificationId = Number(id);
  if (!Number.isInteger(notificationId)) return Response.json({ error: "Invalid notification id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("user_id", auth.user.id) // ownership check via the update's own WHERE, never someone else's row
    .is("read_at", null);

  if (error) return Response.json({ error: "Failed to mark as read." }, { status: 500 });
  return Response.json({ success: true });
}
