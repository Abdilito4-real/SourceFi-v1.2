// app/api/orders/[id]/approve/route.ts
//
// Buyer approves delivery proof. This is the route the whole Section D.0
// finding is about: it moves the order to buyer_approved (intent only)
// and then release_submitted (transfer requested), NEVER directly to
// escrow_released, only a later, real confirmation from the payment
// boundary (handled by lib/paymentProvider.ts's callback into
// lib/orderService.ts's handlePaymentStatusEvent) does that.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import {
  approveOrder,
  NotOrderOwnerError,
  OrderNotFoundError,
  VerificationCallIncompleteError,
  CallCodeNotConfirmedError,
} from "../../../../../lib/orderService";
import { InvalidOrderTransitionError, POST_APPROVAL_STATUSES } from "../../../../../lib/orderStateMachine";
import { MissingSupplierWalletError, NoUsdcTokenOnEscrowWalletError, InsufficientEscrowBalanceError } from "../../../../../lib/circleEscrowProvider";
import { logInternalError } from "../../../../../lib/errorReference";

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
    if (err instanceof InvalidOrderTransitionError) {
      // approveOrder checks order.status up front rather than purely via
      // tryTransition's CAS, so a retry landing after the first attempt
      // already succeeded shows up here with `from` set to a status
      // approveOrder itself produces, see POST_APPROVAL_STATUSES's doc
      // comment. Same "already in progress, not a failure" treatment as
      // fund/route.ts's from === to case, just a different-shaped signal.
      if (POST_APPROVAL_STATUSES.includes(err.from)) return Response.json({ alreadyInProgress: true });
      return Response.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof VerificationCallIncompleteError) return Response.json({ error: err.message }, { status: 409 });
    if (err instanceof CallCodeNotConfirmedError) return Response.json({ error: err.message }, { status: 409 });
    if (
      err instanceof MissingSupplierWalletError ||
      err instanceof NoUsdcTokenOnEscrowWalletError ||
      err instanceof InsufficientEscrowBalanceError
    ) {
      // The buyer's intent to release was already recorded (order moved
      // to release_submitted before this failure), this is a real
      // upstream payment-provider problem, not something retrying the
      // same click fixes. 502 (not 500) to reflect that distinction.
      //
      // err.message here names wallet IDs and "USDC" directly (see
      // Never leak the raw provider error to the buyer. Log it, return a
      // clean fund-position statement plus a reference code instead.
      const ref = logInternalError(`approveOrder release, order ${orderId}`, err);
      return Response.json(
        {
          error: `Releasing your funds didn't go through on our end. Your money is still safely held in escrow, nothing was lost. Try again in a few minutes, and if it keeps happening, contact support with reference ${ref}.`,
          referenceCode: ref,
        },
        { status: 502 }
      );
    }
    return Response.json({ error: err instanceof Error ? err.message : "Failed to approve order." }, { status: 500 });
  }
}
