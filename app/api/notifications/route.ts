// app/api/notifications/route.ts
//
// The in-app notification centre's read path, this is what stays
// correct regardless of whether push ever arrived (feedback-layer rule).
// Always scoped to the caller's own user_id, never a client-supplied one.
import { getUserScopedOrFallbackClient } from "../../../lib/supabaseUserClient";
import { requireRole } from "../../../lib/authz";

const PAGE_SIZE = 30;

export async function GET(request: Request) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  // RLS pilot expansion (0021_rls_expand_pilot.sql): self-only, backed
  // by notifications_select_own. This is admin's own inbox here, not
  // oversight of anyone else's, so admin goes through the user-scoped
  // client too — unlike the orders route's admin branch.
  const supabase = await getUserScopedOrFallbackClient(auth.user.id);
  const { searchParams } = new URL(request.url);
  const before = searchParams.get("before"); // ISO timestamp cursor, for "load more"

  let query = supabase
    .from("notifications")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);
  if (before) query = query.lt("created_at", before);

  const [{ data: notifications, error }, { count: unreadCount }] = await Promise.all([
    query,
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.user.id)
      .is("read_at", null),
  ]);

  if (error) return Response.json({ error: "Failed to load notifications." }, { status: 500 });

  return Response.json({ notifications: notifications ?? [], unreadCount: unreadCount ?? 0 });
}
