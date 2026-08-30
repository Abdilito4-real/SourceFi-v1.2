// app/api/wallet/topup/route.ts
//
// Buyer requests a wallet top-up. Real Yellow Card bank-transfer
// top-up once YELLOW_CARD_API_KEY/YELLOW_CARD_SECRET_KEY are set
// (lib/paymentProvider.ts's getWalletTopupProvider()), simulated
// otherwise — see lib/yellowCardWalletTopupProvider.ts's module comment
// for the one-way (no withdrawal) design and why.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole, getClientIp } from "../../../../lib/authz";
import { getWalletTopupProvider } from "../../../../lib/paymentProvider";
import { initiateWalletTopup, InvalidTopupAmountError, BuyerKycRequiredError } from "../../../../lib/walletService";
import { checkDualQuota } from "../../../../lib/rateLimit";
import { dbErrorResponse } from "../../../../lib/dbErrorResponse";

export async function POST(request: Request) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  // A top-up initiates a real bank-transfer instruction (once Yellow
  // Card is configured) — every individual request can look perfectly
  // valid the same way order funding above does, same dual per-IP +
  // per-account gate. Lower ceiling than order-fund: a real bank
  // transfer per top-up is a heavier action than funding an
  // already-created order from an existing balance.
  const quota = await checkDualQuota("wallet-topup", getClientIp(request), auth.user.email, 10, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json(
      { error: "Too many top-up attempts recently. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } }
    );
  }

  const body = await request.json().catch(() => null);
  const amountMinor = Number(body?.amountMinor);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return Response.json({ error: "amountMinor must be a positive integer." }, { status: 400 });
  }
  // The client generates this once per submit press (components/WalletTopupModal.tsx)
  // and it's what a real provider's own dedup keys off — see
  // WalletTopupProvider's doc comment (lib/walletService.ts) for why a
  // top-up needs a caller-supplied idempotency key rather than one
  // derived from something server-side, unlike order funding.
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (!idempotencyKey) {
    return Response.json({ error: "idempotencyKey is required." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const result = await initiateWalletTopup(supabase, getWalletTopupProvider(), auth.user.id, amountMinor, idempotencyKey);
    return Response.json({
      success: true,
      reference: result.reference,
      status: result.status,
      amountMinor,
      paymentInstructions: result.paymentInstructions ?? null,
    });
  } catch (err) {
    if (err instanceof BuyerKycRequiredError) {
      // The UI's cue to show BuyerKycModal, same pattern the old
      // fundOrder-level check used, just moved here — see
      // components/WalletTopupModal.tsx.
      return Response.json({ error: err.message, kycRequired: true }, { status: 409 });
    }
    if (err instanceof InvalidTopupAmountError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    return dbErrorResponse(`wallet topup, user ${auth.user.id}`, err instanceof Error ? err : new Error(String(err)));
  }
}
