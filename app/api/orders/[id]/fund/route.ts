// app/api/orders/[id]/fund/route.ts
//
// The ENTIRE surface area the UI touches when the buyer clicks
// "Fund Order" (design doc Section E), everything past this route
// handler is lib/orderService.ts's fundOrder() calling the payment
// boundary, never a Yellow Card/Circle SDK here directly.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import { fundOrder, NotOrderOwnerError, OrderNotFoundError, SupplierNotCurrentlyVerifiedError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const result = await fundOrder(supabase, getPaymentProvider(), orderId, auth.user.id);
    return Response.json({ success: true, order: result.order, paymentReference: result.paymentReference });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof SupplierNotCurrentlyVerifiedError) {
      return Response.json({ error: "This order's supplier is no longer currently verified. Contact support." }, { status: 409 });
    }
    if (err instanceof InvalidOrderTransitionError) {
      // TRANSITIONS in orderStateMachine.ts has no self-transition for any
      // status, so from === to can only mean fundOrder's own
      // compare-and-swap already moved the order past "pending_payment"
      //, almost certainly a Retry landing after the first attempt
      // actually succeeded. Treat it as "already in progress", not a
      // failure: the client re-fetches and shows the order's real
      // (in-flight or further) state instead of a scary transition error.
      if (err.from === err.to) return Response.json({ alreadyInProgress: true });
      return Response.json({ error: err.message }, { status: 409 });
    }
    return Response.json({ error: err instanceof Error ? err.message : "Failed to fund order." }, { status: 500 });
  }
}
