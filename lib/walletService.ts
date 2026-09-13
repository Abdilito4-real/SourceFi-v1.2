// lib/walletService.ts
//
// Buyer pre-funded wallet balance (migration 0020_buyer_wallet.sql).
// Pure wallet-side bookkeeping only — this module knows nothing about
// order status or the order state machine, that stays in
// lib/orderService.ts, which imports the handful of functions below it
// actually needs and fires the shared handlePaymentStatusEvent consumer
// itself. Kept this way specifically to avoid a circular import between
// this file and lib/orderService.ts (fundOrderFromWallet-shaped logic
// needs handlePaymentStatusEvent, which lives there).
//
// The EXTERNAL top-up call is real now (lib/yellowCardWalletTopupProvider.ts,
// used automatically once YELLOW_CARD_API_KEY/YELLOW_CARD_SECRET_KEY are
// set — StubWalletTopupProvider below is only the fallback when they
// aren't). It's still deliberately one-way, though: Yellow Card's refund
// API refunds exactly one original receive, in full, no amount
// parameter. There's no documented way to give a buyer back an unspent
// PORTION of a top-up once some of it has been spent across multiple
// orders, so there's no withdrawal path, real or otherwise, today. See
// docs/payment-integration.md's "Buyer wallet" section. The provider-
// interface split (WalletTopupProvider) still exists for the same
// reason lib/paymentBoundary.ts's does — the stub and the real Yellow
// Card implementation are interchangeable behind it without touching
// call sites, exactly like every other payment leg.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MIN_WALLET_TOPUP_MINOR } from "./money";
import type { BuyerWalletRow } from "./types";

export class InsufficientWalletBalanceError extends Error {
  /** How much more (minor units) the buyer needs to top up to cover the
   * amount that was just attempted, computed from a fresh balance read
   * taken AFTER the failed debit, never from a stale pre-check. */
  shortfallMinor: number;
  constructor(shortfallMinor: number) {
    super(`Insufficient wallet balance. Top up ${shortfallMinor} kobo more to continue.`);
    this.name = "InsufficientWalletBalanceError";
    this.shortfallMinor = shortfallMinor;
  }
}

export class InvalidTopupAmountError extends Error {
  constructor(amountMinor: number) {
    super(`Top-up amount (${amountMinor} kobo) is below the ${MIN_WALLET_TOPUP_MINOR} kobo minimum.`);
    this.name = "InvalidTopupAmountError";
  }
}

/** A distinct class from lib/orderService.ts's old BuyerKycRequiredError
 * (which used to gate fundOrder directly) — KYC now gates topping up the
 * wallet instead, the step that will eventually make a real external
 * Yellow Card call needing this data, same "each layer throws its own
 * domain error for the same underlying rule" pattern
 * lib/yellowCardProvider.ts's MissingBuyerKycError already established
 * alongside the old fundOrder-level check. */
export class BuyerKycRequiredError extends Error {
  constructor() {
    super("Complete your buyer verification before topping up your wallet.");
    this.name = "BuyerKycRequiredError";
  }
}

export interface WalletTopupResult {
  reference: string;
  status: "processing" | "confirmed";
  /** Set only by a real bank-transfer provider (YellowCardWalletTopupProvider):
   * the account the buyer needs to actually pay into. undefined for the
   * stub. Mirrors FundingResult.paymentInstructions
   * (lib/paymentBoundary.ts), same shape, same "never fabricated" rule. */
  paymentInstructions?: {
    bankName: string;
    accountNumber: string;
    accountName: string;
  };
}

/** Mirrors PaymentBoundary's shape (lib/paymentBoundary.ts): the ONLY
 * thing call sites depend on for the external leg of a top-up, never a
 * concrete provider client. `idempotencyKey` is caller-supplied (see
 * initiateWalletTopup below) rather than derived from anything
 * server-generated per attempt — a top-up has no pre-existing DB
 * identity the way an order does (fundOrder's sequenceId keys off
 * orderId), so a genuine client retry has to bring its own stable key
 * for a real provider's dedup to actually prevent a second real bank-
 * transfer request. */
export interface WalletTopupProvider {
  initiateTopup(userId: number, amountMinor: number, idempotencyKey: string): Promise<WalletTopupResult>;
}

/** Deliberately fake, deterministic, no network calls — see this file's
 * module comment for why the real Yellow Card leg isn't wired yet.
 * Confirms itself after a short simulated delay via the injected
 * callback, same shape/spirit as StubPaymentProvider
 * (lib/paymentBoundary.ts). */
export class StubWalletTopupProvider implements WalletTopupProvider {
  private readonly onConfirmed: (userId: number, amountMinor: number, reference: string) => Promise<void> | void;
  private readonly simulatedDelayMs: number;
  private counter = 0;

  constructor(
    onConfirmed: (userId: number, amountMinor: number, reference: string) => Promise<void> | void,
    simulatedDelayMs = 10
  ) {
    this.onConfirmed = onConfirmed;
    this.simulatedDelayMs = simulatedDelayMs;
  }

  async initiateTopup(userId: number, amountMinor: number, _idempotencyKey: string): Promise<WalletTopupResult> {
    this.counter += 1;
    const reference = `topup-stub-${Date.now()}-${this.counter}`;
    void this.scheduleConfirmation(userId, amountMinor, reference);
    return { reference, status: "processing" };
  }

  private async scheduleConfirmation(userId: number, amountMinor: number, reference: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.simulatedDelayMs));
    await this.onConfirmed(userId, amountMinor, reference);
  }
}

export async function getWalletBalance(supabase: SupabaseClient, userId: number): Promise<{ balanceMinor: number }> {
  const { data, error } = await supabase.from("buyer_wallets").select("balance_minor").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return { balanceMinor: (data as Pick<BuyerWalletRow, "balance_minor"> | null)?.balance_minor ?? 0 };
}

/** Buyer requests a top-up. Inserts a `processing` wallet_transactions
 * row up front (order_id null — this is a topup, not an order_funding)
 * so the attempt is visible even before the provider confirms, then
 * hands off to the provider. Never touches Yellow Card itself, same
 * "route code only depends on the interface" discipline
 * lib/paymentBoundary.ts established. */
export async function initiateWalletTopup(
  supabase: SupabaseClient,
  provider: WalletTopupProvider,
  userId: number,
  amountMinor: number,
  idempotencyKey: string
): Promise<WalletTopupResult> {
  if (amountMinor < MIN_WALLET_TOPUP_MINOR) throw new InvalidTopupAmountError(amountMinor);

  // Real Yellow Card integration: a top-up's recipient object needs this
  // on file. Checked once here instead of on every order funding — by
  // the time money is IN the wallet it already went through a KYC'd
  // top-up, funding an order from it never needs to re-check.
  // StubWalletTopupProvider itself doesn't need this data (it's
  // simulated), but the gate stays live regardless of which provider is
  // configured.
  const { data: kyc } = await supabase.from("buyer_kyc_profiles").select("id").eq("user_id", userId).maybeSingle();
  if (!kyc) throw new BuyerKycRequiredError();

  const result = await provider.initiateTopup(userId, amountMinor, idempotencyKey);

  await supabase.from("wallet_transactions").insert({
    user_id: userId,
    type: "topup",
    amount_minor: amountMinor,
    order_id: null,
    provider_reference: result.reference,
    status: result.status,
  });

  return result;
}

/** Atomic increment via the wallet_credit RPC (migration 0020) — never a
 * read-then-write from here, that's what makes this race-safe under
 * concurrent credits. Shared by top-up confirmation and by
 * creditWalletForRefund below. */
async function creditWallet(supabase: SupabaseClient, userId: number, amountMinor: number): Promise<void> {
  const { error } = await supabase.rpc("wallet_credit", { p_user_id: userId, p_amount_minor: amountMinor });
  if (error) throw new Error(error.message ?? "Wallet credit failed.");
}

/** The provider confirmation callback (StubWalletTopupProvider today,
 * YellowCardWalletTopupProvider's real webhook path too) lands here.
 * Update-first, gated on the row still being "processing", THEN credit
 * — never the other order. A real webhook can and does redeliver the
 * same notification (this codebase's own Circle/Yellow Card webhook
 * handling already assumes at-least-once delivery); crediting
 * unconditionally would double-credit the wallet on a redelivery. Same
 * compare-and-swap discipline lib/orderService.ts's tryTransition uses
 * for order status, applied here to a wallet_transactions row instead. */
export async function confirmWalletTopup(supabase: SupabaseClient, userId: number, amountMinor: number, reference: string): Promise<void> {
  const { data: updated } = await supabase
    .from("wallet_transactions")
    .update({ status: "confirmed" })
    .eq("provider_reference", reference)
    .eq("status", "processing")
    .select("id")
    .maybeSingle();
  if (!updated) return; // already confirmed (redelivered notification) or unknown reference — no-op, not a double-credit
  await creditWallet(supabase, userId, amountMinor);
}

/** Records a refund credited back to the wallet (a distinct
 * wallet_transactions type from `topup`, so the audit trail stays
 * honest about where the money actually came from). Called from
 * lib/orderService.ts's handleRefundConfirmed once it's established the
 * order was wallet-funded. */
export async function creditWalletForRefund(supabase: SupabaseClient, userId: number, orderId: number, amountMinor: number): Promise<void> {
  await creditWallet(supabase, userId, amountMinor);
  await supabase.from("wallet_transactions").insert({
    user_id: userId,
    type: "refund_to_wallet",
    amount_minor: amountMinor,
    order_id: orderId,
    status: "confirmed",
  });
}

/** Atomic decrement via the wallet_debit RPC (migration 0020) — the
 * single source of truth for "does this buyer have enough," never a
 * check-then-act from the app layer. Real supabase-js never throws on a
 * Postgres exception, it returns {data:null, error}; the FakeSupabase
 * test double (tests/testUtils/fakeSupabase.ts) has no error-wrapping at
 * all, its registered handler signals failure with a real JS throw
 * instead (see wireWalletRpcs there) — this function handles both
 * shapes so it behaves identically against the real client and the test
 * fixture. On insufficient balance (either shape), re-queries the
 * balance rather than trusting a stale pre-check, so the reported
 * shortfall is accurate even after losing a race against a concurrent
 * debit. */
export async function debitWalletForOrder(supabase: SupabaseClient, userId: number, orderId: number, amountMinor: number): Promise<void> {
  let rpcErrorMessage: string | null = null;
  try {
    const { error } = await supabase.rpc("wallet_debit", { p_user_id: userId, p_amount_minor: amountMinor });
    if (error) rpcErrorMessage = error.message ?? "Wallet debit failed.";
  } catch (err) {
    rpcErrorMessage = err instanceof Error ? err.message : String(err);
  }

  if (rpcErrorMessage) {
    if (rpcErrorMessage.includes("insufficient_wallet_balance")) {
      const { balanceMinor } = await getWalletBalance(supabase, userId);
      throw new InsufficientWalletBalanceError(Math.max(0, amountMinor - balanceMinor));
    }
    throw new Error(rpcErrorMessage);
  }

  await supabase.from("wallet_transactions").insert({
    user_id: userId,
    type: "order_funding",
    amount_minor: amountMinor,
    order_id: orderId,
    status: "confirmed",
  });
}

/** Was this order ever funded from the buyer's wallet? Checked by
 * lib/orderService.ts's refund-initiating call sites (resolveDispute,
 * cancelFundedOrder, abandonOrder) and handleRefundConfirmed, to decide
 * whether a refund should credit the wallet instead of calling Yellow
 * Card's refund endpoint — which would either hit its full-amount-only
 * guard on a partial (fee-retaining) refund, or try to refund a receive
 * that was never created for this order at all, since a wallet-funded
 * order never went through Yellow Card in the first place. */
export async function wasOrderFundedFromWallet(supabase: SupabaseClient, orderId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("wallet_transactions")
    .select("id")
    .eq("order_id", orderId)
    .eq("type", "order_funding")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
