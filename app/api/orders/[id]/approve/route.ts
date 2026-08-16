// app/api/orders/[id]/approve/route.ts
//
// Buyer approves delivery proof. This is the route the whole Section D.0
// finding is about: it moves the order to buyer_approved (intent only)
// and then release_submitted (transfer requested), NEVER directly to
// escrow_released — only a later, real confirmation from the payment
// boundary (handled by lib/paymentProvider.ts's callback into
// lib/orderService.ts's handlePaymentStatusEvent) does that.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import { approveOrder, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const order = await approveOrder(supabase, getPaymentProvider(), orderId, auth.user.id);
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to approve order." }, { status: 500 });
  }
}
