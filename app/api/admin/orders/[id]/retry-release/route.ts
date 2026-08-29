// app/api/admin/orders/[id]/retry-release/route.ts
//
// Part 1 of the production-hardening pass (idempotency-safe retry): the
// explicit admin action docs/payment-integration.md's "Known gaps"
// section said didn't exist yet, for an order stuck at
// release_submitted after a real Circle release attempt failed (missing
// supplier wallet, no USDC balance, insufficient balance — see
// approveOrder's original comment, now lib/orderService.ts's
// attemptEscrowRelease). Safe to click more than once: Circle's
// idempotencyKey (lib/uuidv5.ts) is deterministic per order, a resend
// can't become a second on-chain transfer.
import { getSupabaseServerClient } from "../../../../../../lib/supabaseServer";
import { requireRole, logAudit } from "../../../../../../lib/authz";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey } from "../../../../../../lib/rateLimit";
import { getPaymentProvider } from "../../../../../../lib/paymentProvider";
import { retryEscrowRelease, ReleaseNotRetryableError, OrderNotFoundError } from "../../../../../../lib/orderService";
import {
  MissingSupplierWalletError,
  MissingYellowCardConfigError,
  NoUsdcTokenOnEscrowWalletError,
  InsufficientEscrowBalanceError,
} from "../../../../../../lib/circleEscrowProvider";
import { MissingSupplierPayoutProfileError } from "../../../../../../lib/yellowCardProvider";
import { logInternalError } from "../../../../../../lib/errorReference";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const limitKey = rateLimitKey("retry-release", auth.user.email);
  const limit = await checkRateLimit(limitKey);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many retry attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 30) } }
    );
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) {
    await recordFailure(limitKey);
    return Response.json({ error: "Invalid order id." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const order = await retryEscrowRelease(supabase, getPaymentProvider(), orderId);
    await recordSuccess(limitKey);
    await logAudit({
      actorEmail: auth.user.email,
      action: "order_release_retried",
      target: String(orderId),
      details: { newStatus: order.status },
      request,
    });
    return Response.json({ success: true, order });
  } catch (err) {
    await recordFailure(limitKey);
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof ReleaseNotRetryableError) {
      return Response.json({ error: err.message, currentStatus: err.currentStatus }, { status: 409 });
    }
    if (
      err instanceof MissingSupplierWalletError ||
      err instanceof MissingSupplierPayoutProfileError ||
      err instanceof MissingYellowCardConfigError ||
      err instanceof NoUsdcTokenOnEscrowWalletError ||
      err instanceof InsufficientEscrowBalanceError
    ) {
      // Unlike approve/route.ts (buyer-facing, where the "never leak the
      // raw provider error" rule really does apply), this route is
      // admin-only — an admin already sees the escrow wallet's exact
      // balance on the Ledger page, so hiding it here just forces a trip
      // to server logs for something the UI could say directly. Each of
      // these three error classes' own .message is already written as a
      // plain, actionable sentence (see their constructors in
      // lib/circleEscrowProvider.ts), not a stack trace, so it's safe to
      // surface verbatim. Still logged server-side with a reference code
      // for cross-referencing, same as everywhere else.
      const ref = logInternalError(`retryEscrowRelease, order ${orderId}`, err);
      return Response.json(
        {
          error: `${err.message} Funds are still safely held in escrow, nothing was lost. Reference ${ref}.`,
          referenceCode: ref,
        },
        { status: 502 }
      );
    }
    const ref = logInternalError(`retry-release route, order ${orderId}`, err);
    return Response.json({ error: "Retry failed. See server logs.", referenceCode: ref }, { status: 500 });
  }
}
