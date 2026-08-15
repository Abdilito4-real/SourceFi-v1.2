// app/api/admin/users/route.ts
//
// List-only — the actual role change still goes through the existing
// PATCH /api/admin/users/[id]/role, unchanged. This just gives the admin
// dashboard something to render a Users table from, replacing "look the
// id up in Supabase's table editor" as the only way to find one.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";

export async function GET() {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("users")
    .select("id, email, username, role, created_at")
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ users: data || [] });
}
