// app/api/orders/[id]/report-issue/route.ts
//
// The genuinely new mechanism design doc Section 5 asks for: a buyer
// flagging a problem discovered AFTER approval/settlement, where today's
// app (and even /reject above) has no path. Only usable on a `settled`
// order; deliberately does not change orders.status, see
// lib/orderStateMachine.ts's comment on why settled has no outgoing
// transition to disputed, and lib/orderService.ts's
// reportPostSettlementIssue.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { reportPostSettlementIssue, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { filterSafeHttpUrls } from "../../../../../lib/safeUrl";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { getClientIp } from "../../../../../lib/authz";
import type { DisputeCategory } from "../../../../../lib/types";

const VALID_CATEGORIES: DisputeCategory[] = [
  "item_not_as_described",
  "item_not_delivered",
  "quality_issue",
  "wrong_quantity",
  "damaged_in_transit",
  "other",
];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const quota = await checkDualQuota("dispute-file", getClientIp(request), auth.user.email, 8, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json({ error: "Too many reports filed recently. Try again shortly." }, { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const category = VALID_CATEGORIES.includes(body?.category) ? (body.category as DisputeCategory) : null;
  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const evidenceUrls = Array.isArray(body?.evidenceUrls) ? filterSafeHttpUrls(body.evidenceUrls) : [];

  if (!category) {
    return Response.json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const result = await reportPostSettlementIssue(supabase, orderId, auth.user.id, { category, description, evidenceUrls });
    return Response.json({ success: true, disputeId: result.disputeId });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to report an issue." }, { status: 500 });
  }
}
