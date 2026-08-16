// app/api/admin/supplier-verification/route.ts
//
// Repurposed from app/api/admin/sourcer-applications/route.ts. Same
// shape: admin-only, filter by status, join applicant email/username in
// server-side for display.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";
import type { ApplicationStatus } from "../../../../lib/types";

const VALID_STATUSES: ApplicationStatus[] = ["pending", "approved", "rejected"];

export async function GET(request: Request) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const statusParam = new URL(request.url).searchParams.get("status");
  const status = VALID_STATUSES.includes(statusParam as ApplicationStatus) ? (statusParam as ApplicationStatus) : "pending";

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("supplier_verification_applications")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const applicantIds = Array.from(new Set((data || []).map((a) => a.user_id)));
  const { data: users } =
    applicantIds.length > 0
      ? await supabase.from("users").select("id, email, username").in("id", applicantIds)
      : { data: [] as { id: number; email: string; username: string | null }[] };
  const userById = new Map((users || []).map((u) => [u.id, u]));

  const applications = (data || []).map((a) => ({
    ...a,
    applicant_email: userById.get(a.user_id)?.email ?? null,
    applicant_username: userById.get(a.user_id)?.username ?? null,
  }));

  return Response.json({ applications });
}
