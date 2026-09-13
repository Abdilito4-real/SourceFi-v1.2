// app/api/orders/[id]/cancel/route.ts
//
// Prompt 3, flows 1 & 4, one route, branches server-side on the order's
// CURRENT status rather than exposing two separate endpoints the client
// has to pick between: pending_payment/payment_failed goes through
// cancelBeforeFunding() (no funds moved, no fee); funded/fulfilling goes
// through cancelFundedOrder() (refund minus the disclosed
// CANCELLATION_FEE_MINOR). Any other status is simply not cancellable
// this way, see the termination matrix for what those states use
// instead (reject/dispute, abandon, admin resolution).
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import {
  cancelBeforeFunding,
  cancelFundedOrder,
  NotOrderOwnerError,
  OrderNotFoundError,
} from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { getClientIp } from "../../../../../lib/authz";
import { dbErrorResponse } from "../../../../../lib/dbErrorResponse";
import type { BuyerCancellationCategory } from "../../../../../lib/types";

const VALID_CATEGORIES: BuyerCancellationCategory[] = ["changed_mind", "found_alternative", "no_longer_needed", "price_disagreement", "other"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  // Prompt 3's own explicit ask: "repeated cancellation... needs a
  // cooldown or a flag", this is that cooldown, shared with
  // abandon/withdraw under the same "order-terminate" bucket.
  const quota = await checkDualQuota("order-terminate", getClientIp(request), auth.user.email, 8, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json({ error: "Too many cancellations recently. Try again shortly." }, { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const category = VALID_CATEGORIES.includes(body?.category) ? (body.category as BuyerCancellationCategory) : null;
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 1000) || null : null;
  if (!category) return Response.json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const { data: order, error } = await supabase.from("orders").select("status").eq("id", orderId).maybeSingle();
    if (error) throw error;
    if (!order) throw new OrderNotFoundError(orderId);

    if (order.status === "pending_payment" || order.status === "payment_failed") {
      const result = await cancelBeforeFunding(supabase, orderId, auth.user.id, { category, description });
      return Response.json({ success: true, order: result, feeMinor: 0, refundMinor: null });
    }

    if (order.status === "funded" || order.status === "fulfilling") {
      const result = await cancelFundedOrder(supabase, getPaymentProvider(), orderId, auth.user.id, { category, description });
      return Response.json({ success: true, order: result.order, feeMinor: result.feeMinor, refundMinor: result.refundMinor });
    }

    return Response.json(
      { error: "This order can't be cancelled this way anymore." },
      { status: 409 }
    );
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    return dbErrorResponse(`cancel order ${orderId}`, err instanceof Error ? err : new Error(String(err)));
  }
}
