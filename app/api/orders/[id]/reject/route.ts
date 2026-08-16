// app/api/orders/[id]/reject/route.ts
//
// Buyer rejects delivery proof, reason required. Always routes to
// `disputed` automatically (design doc's transition table — never a dead
// end); dispute_type is 'pre_approval_rejection' since no funds have
// moved. Distinct from /report-issue, which is the post-settlement path.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { rejectProof, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
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

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const category = VALID_CATEGORIES.includes(body?.category) ? (body.category as DisputeCategory) : null;
  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const evidenceUrls = Array.isArray(body?.evidenceUrls) ? body.evidenceUrls.filter((u: unknown) => typeof u === "string") : [];

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
    return Response.json({ error: err instanceof Error ? err.message : "Failed to reject delivery proof." }, { status: 500 });
  }
}
