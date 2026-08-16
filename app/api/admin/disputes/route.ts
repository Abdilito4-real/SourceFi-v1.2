// app/api/admin/disputes/route.ts
//
// Admin dispute queue, filterable by status, shows dispute_type so an
// admin can tell a pre-approval rejection apart from a post-settlement
// report at a glance (design doc Section C.7 / F).
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";
import { dbErrorResponse } from "../../../../lib/dbErrorResponse";
import type { DisputeStatus } from "../../../../lib/types";

const VALID_STATUSES: DisputeStatus[] = ["open", "under_review", "resolved_buyer", "resolved_supplier", "resolved_split"];

export async function GET(request: Request) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const statusParam = new URL(request.url).searchParams.get("status");
  const status = VALID_STATUSES.includes(statusParam as DisputeStatus) ? (statusParam as DisputeStatus) : "open";

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("disputes").select("*").eq("status", status).order("created_at", { ascending: true });
  if (error) return dbErrorResponse("GET admin/disputes", error);

  const orderIds = Array.from(new Set((data || []).map((d) => d.order_id)));
  const raisedByIds = Array.from(new Set((data || []).map((d) => d.raised_by)));

  const [{ data: orders }, { data: raisers }] = await Promise.all([
    orderIds.length > 0
      ? supabase.from("orders").select("id, order_code, status, buyer_id, supplier_id, amount_minor").in("id", orderIds)
      : Promise.resolve({ data: [] as { id: number }[] }),
    raisedByIds.length > 0
      ? supabase.from("users").select("id, email").in("id", raisedByIds)
      : Promise.resolve({ data: [] as { id: number; email: string }[] }),
  ]);

  const orderById = new Map((orders || []).map((o) => [o.id, o]));
  const emailById = new Map((raisers || []).map((u) => [u.id, u.email]));

  const disputes = (data || []).map((d) => ({
    ...d,
    order: orderById.get(d.order_id) ?? null,
    raised_by_email: emailById.get(d.raised_by) ?? null,
  }));

  return Response.json({ disputes });
}
