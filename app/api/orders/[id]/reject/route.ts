// app/api/orders/[id]/reject/route.ts
//
// Buyer rejects delivery proof, reason required. Always routes to
// `disputed` automatically (design doc's transition table, never a dead
// end); dispute_type is 'pre_approval_rejection' since no funds have
// moved. Distinct from /report-issue, which is the post-settlement path.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { rejectProof, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
import { filterSafeHttpUrls } from "../../../../../lib/safeUrl";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { getClientIp } from "../../../../../lib/authz";
import { dbErrorResponse } from "../../../../../lib/dbErrorResponse";
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

  // Prompt 4, M1, dispute filing rate-limited per IP AND per account (8
  // per 10 minutes each): every call here can be individually "valid," so
  // this caps volume rather than failures.
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
    const order = await rejectProof(supabase, orderId, auth.user.id, { category, description, evidenceUrls });
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    return dbErrorResponse(`reject proof, order ${orderId}`, err instanceof Error ? err : new Error(String(err)));
  }
}
