// app/api/orders/[id]/fund/route.ts
//
// The ENTIRE surface area the UI touches when the buyer clicks
// "Fund Order". Wallet-first as of migration 0020 (lib/walletService.ts):
// this never calls a payment provider directly, lib/orderService.ts's
// fundOrder() debits the buyer's platform wallet balance atomically.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole, getClientIp } from "../../../../../lib/authz";
import { fundOrder, NotOrderOwnerError, OrderNotFoundError, SupplierNotCurrentlyVerifiedError, InsufficientWalletBalanceError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { dbErrorResponse } from "../../../../../lib/dbErrorResponse";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  // This debits a real wallet balance, unlike reject/cancel/abandon it
  // never had a volume cap at all — every individual call can look
  // perfectly valid (a real order, a real sufficient balance) the same
  // way checkDualQuota's own header comment describes for dispute
  // filing, so a failure-lockout wouldn't catch a scripted spam run.
  // Same per-IP + per-account dual gate, a higher ceiling than
  // cancel/abandon's 8 since funding many orders in one sitting is
  // completely normal buyer behavior, not itself suspicious.
  const quota = await checkDualQuota("order-fund", getClientIp(request), auth.user.email, 20, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json(
      { error: "Too many funding attempts recently. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } }
    );
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const result = await fundOrder(supabase, orderId, auth.user.id);
    return Response.json({
      success: true,
      order: result.order,
      paymentReference: result.paymentReference,
      paymentInstructions: result.paymentInstructions,
    });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InsufficientWalletBalanceError) {
      // The UI's cue to show WalletTopupModal (prefilled with the
      // shortfall) rather than a plain error toast, see
      // components/WalletTopupModal.tsx.
      return Response.json({ error: err.message, insufficientBalance: true, shortfallMinor: err.shortfallMinor }, { status: 409 });
    }
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
    return dbErrorResponse(`fund order ${orderId}`, err instanceof Error ? err : new Error(String(err)));
  }
}
