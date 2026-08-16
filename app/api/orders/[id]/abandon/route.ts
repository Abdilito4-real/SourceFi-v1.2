// app/api/orders/[id]/abandon/route.ts
//
// Prompt 3, flow 6, supplier voluntarily exits a funded order before
// submitting proof. Full refund, no fee (see abandonOrder's doc comment
// for why); records a strike toward the Decision 4 escalation.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import { abandonOrder, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { getClientIp } from "../../../../../lib/authz";
import type { SupplierExitCategory } from "../../../../../lib/types";

const VALID_CATEGORIES: SupplierExitCategory[] = ["cannot_fulfill", "schedule_conflict", "pricing_error", "other"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const quota = checkDualQuota("order-terminate", getClientIp(request), auth.user.email, 8, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json({ error: "Too many cancellations recently. Try again shortly." }, { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const category = VALID_CATEGORIES.includes(body?.category) ? (body.category as SupplierExitCategory) : null;
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 1000) || null : null;
  if (!category) return Response.json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const order = await abandonOrder(supabase, getPaymentProvider(), orderId, auth.user.id, { category, description });
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel this order." }, { status: 500 });
  }
}
