// lib/ledger.ts
//
// The double-entry ledger writer, docs/marketplace-payments-design.md
// Section C.6. The fundamental invariant: for every ledger transaction,
// total debits must equal total credits, checked PER CURRENCY (an order's
// money touches both NGN and USDC, at rates that can differ moment to
// moment, see the design doc for why one blended balance-to-zero would
// hide that instead of accounting for it).
//
// Two layers of enforcement, deliberately redundant:
//   1. assertBalanced() here, in application code, BEFORE anything is
//      sent to the database, fail fast, with a clear error, at the call
//      site that got the amounts wrong.
//   2. The deferred constraint trigger in migration 0004 on the
//      `ledger_entries` table itself, which does not trust that (1) was
//      called, a insert that somehow bypassed this module still can't
//      commit an unbalanced set of rows.
// Neither one is a substitute for the other. (1) gives a fast, readable
// failure in the route handler that made the mistake. (2) is the actual
// backstop if (1) is ever bypassed, forgotten, or wrong.
//
// The four functions below (recordFundingConfirmed / recordEscrowRelease /
// recordSettlement / recordRefundFromEscrow) are where the design doc's
// Section D.3 transition table's "ledger effect" column becomes real
// code. Each one fires at the point a financial fact is CONFIRMED (order
// reaches `funded` / `escrow_released` / `settled`), not at every
// intermediate processing state, the granular async trail belongs in
// `payment_events`, not here.
import "server-only";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LedgerAccount } from "./types";

export interface LedgerLeg {
  account: LedgerAccount;
  /** Set only for SUPPLIER_PAYABLE, which supplier this leg belongs to. */
  accountRef?: number | null;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: "NGN" | "USDC";
}

export class UnbalancedLedgerTransactionError extends Error {
  constructor(currency: string, totalDebit: number, totalCredit: number) {
    super(
      `Ledger transaction is unbalanced for ${currency}: total debits (${totalDebit}) ` +
        `!= total credits (${totalCredit}). Refusing to write.`
    );
    this.name = "UnbalancedLedgerTransactionError";
  }
}

/** The invariant itself, checked per currency, before any DB call.
 * Exported so tests can assert directly against it without needing a
 * mocked Supabase client for the pure-logic half of this module. */
export function assertBalanced(legs: LedgerLeg[]): void {
  if (legs.length === 0) {
    throw new Error("A ledger transaction must have at least one leg.");
  }
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const leg of legs) {
    if (leg.amountMinor <= 0) {
      throw new Error(`Ledger leg amount must be positive, got ${leg.amountMinor} on ${leg.account}.`);
    }
    const bucket = totals.get(leg.currency) ?? { debit: 0, credit: 0 };
    if (leg.direction === "debit") bucket.debit += leg.amountMinor;
    else bucket.credit += leg.amountMinor;
    totals.set(leg.currency, bucket);
  }
  for (const [currency, { debit, credit }] of totals) {
    if (debit !== credit) {
      throw new UnbalancedLedgerTransactionError(currency, debit, credit);
    }
  }
}

/** Writes one balanced ledger transaction (one or more legs, sharing a
 * fresh ledger_transaction_id) and returns that id. Throws
 * UnbalancedLedgerTransactionError BEFORE touching the database if the
 * legs don't balance, see the module comment for why this doesn't make
 * the DB-level trigger redundant. */
export async function writeLedgerTransaction(
  supabase: SupabaseClient,
  orderId: number,
  legs: LedgerLeg[]
): Promise<string> {
  // A zero-amount leg (e.g. recordEscrowRelease called with no platform
  // fee) represents no real movement, drop it rather than writing a
  // meaningless row or tripping assertBalanced's positive-amount check.
  // A transaction left with nothing at all still correctly throws below.
  const realLegs = legs.filter((leg) => leg.amountMinor > 0);
  assertBalanced(realLegs);

  const ledgerTransactionId = randomUUID();
  const rows = realLegs.map((leg) => ({
    ledger_transaction_id: ledgerTransactionId,
    order_id: orderId,
    account: leg.account,
    account_ref: leg.accountRef ?? null,
    direction: leg.direction,
    amount_minor: leg.amountMinor,
    currency: leg.currency,
  }));

  const { error } = await supabase.from("ledger_entries").insert(rows);
  if (error) throw error;
  return ledgerTransactionId;
}

// ============================================================================
// The four order-lifecycle ledger events. Each takes the amounts already
// confirmed by a payment_events row (never re-derives an amount from
// client input, same "don't trust a client-supplied amount" rule
// app/api/escrow/route.ts already follows today).
// ============================================================================

/** Order reaches `funded`: NGN left the buyer's world, USDC arrived in
 * escrow. Recorded as ONE ledger transaction covering both currencies
 * FX_CLEARING appears on both sides (debited against the NGN inflow,
 * credited against the USDC that left it for escrow), which is what lets
 * each currency's subset net to zero independently without inventing an
 * extra account for "money paid to the conversion provider." See the
 * design doc's Section C.6 rationale for why NGN and USDC never share one
 * balanced set. */
export async function recordFundingConfirmed(
  supabase: SupabaseClient,
  orderId: number,
  ngnAmountMinor: number,
  usdcAmountMinor: number
): Promise<string> {
  return writeLedgerTransaction(supabase, orderId, [
    { account: "FX_CLEARING", direction: "debit", amountMinor: ngnAmountMinor, currency: "NGN" },
    { account: "EXTERNAL_NGN_BUYER", direction: "credit", amountMinor: ngnAmountMinor, currency: "NGN" },
    { account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: usdcAmountMinor, currency: "USDC" },
    { account: "FX_CLEARING", direction: "credit", amountMinor: usdcAmountMinor, currency: "USDC" },
  ]);
}

/** Order reaches `escrow_released`: Circle's transfer is CONFIRMED with a
 * real txHash on file (design doc Section D.0), only NOW does the
 * platform fee get recognized as revenue, and only NOW does the supplier
 * have a real payable. USDC-only; no currency conversion happens at this
 * step.
 *
 * Sign convention (kept consistent across all four functions so a
 * cumulative balance per account means something, not just each single
 * transaction balancing in isolation): ESCROW_WALLET_USDC is a real
 * asset, debit when USDC arrives (recordFundingConfirmed), credit when
 * it leaves (here). SUPPLIER_PAYABLE and FX_CLEARING are internal
 * transit buckets, not liabilities in the strict accounting sense, they
 * debit when value is earmarked into them, credit when it's paid out /
 * moves on. `supplierAmountUsdcMinor + platformFeeUsdcMinor` must equal
 * exactly what recordFundingConfirmed debited into escrow for this order
 *, that's what makes ESCROW_WALLET_USDC's cumulative balance net to
 * zero across an order's full lifecycle, which is the property worth
 * checking in a reconciliation job later. */
export async function recordEscrowRelease(
  supabase: SupabaseClient,
  orderId: number,
  supplierId: number,
  supplierAmountUsdcMinor: number,
  platformFeeUsdcMinor: number
): Promise<string> {
  return writeLedgerTransaction(supabase, orderId, [
    { account: "ESCROW_WALLET_USDC", direction: "credit", amountMinor: supplierAmountUsdcMinor, currency: "USDC" },
    { account: "SUPPLIER_PAYABLE", accountRef: supplierId, direction: "debit", amountMinor: supplierAmountUsdcMinor, currency: "USDC" },
    { account: "ESCROW_WALLET_USDC", direction: "credit", amountMinor: platformFeeUsdcMinor, currency: "USDC" },
    { account: "PLATFORM_REVENUE", direction: "debit", amountMinor: platformFeeUsdcMinor, currency: "USDC" },
  ]);
}

/** Order reaches `settled`: the supplier's USDC payable is cleared by
 * converting it to NGN and paying it out. Mirrors recordFundingConfirmed's
 * shape in reverse, FX_CLEARING bridges the two currencies again, and
 * EXTERNAL_NGN_SUPPLIER is debited (not credited) because this is an
 * OUTFLOW crossing the boundary, the opposite of EXTERNAL_NGN_BUYER's
 * credit-on-inflow in recordFundingConfirmed. Note: the platform fee's
 * NGN-equivalent has no corresponding NGN leg anywhere in this design
 * it stays as USDC in PLATFORM_REVENUE, never converted per-order. That
 * means FX_CLEARING's NGN balance will NOT return to exactly zero across
 * a full order lifecycle when platformFeeUsdcMinor > 0; the residual is
 * the fee's NGN-equivalent value, which is a legitimate reconciliation
 * signal (undistributed platform revenue awaiting its own off-ramp), not
 * a bug. */
export async function recordSettlement(
  supabase: SupabaseClient,
  orderId: number,
  supplierId: number,
  supplierUsdcPayableMinor: number,
  supplierNgnPayoutMinor: number
): Promise<string> {
  return writeLedgerTransaction(supabase, orderId, [
    { account: "SUPPLIER_PAYABLE", accountRef: supplierId, direction: "credit", amountMinor: supplierUsdcPayableMinor, currency: "USDC" },
    { account: "FX_CLEARING", direction: "debit", amountMinor: supplierUsdcPayableMinor, currency: "USDC" },
    { account: "FX_CLEARING", direction: "credit", amountMinor: supplierNgnPayoutMinor, currency: "NGN" },
    { account: "EXTERNAL_NGN_SUPPLIER", direction: "debit", amountMinor: supplierNgnPayoutMinor, currency: "NGN" },
  ]);
}

/** Reverses a PRE-RELEASE funding leg, i.e. the order was disputed and
 * ruled for the buyer while still in `funded`/`rejected`/
 * `release_submitted`/`release_processing` (Circle transfer never reached
 * CONFIRMED, so escrow still holds the full amount and nothing was ever
 * booked to PLATFORM_REVENUE or SUPPLIER_PAYABLE). This is the only
 * refund case this module implements.
 *
 * It deliberately does NOT handle a refund after `escrow_released` or
 * `settled`, by that point SUPPLIER_PAYABLE/PLATFORM_REVENUE/
 * EXTERNAL_NGN_SUPPLIER already reflect a completed release, and
 * "clawing back" a supplier who's already been paid is a materially
 * different, harder financial decision (does the platform eat the loss?
 * pursue the supplier? partial clawback?) that Section J's open
 * questions flag rather than default. Calling this function for an order
 * that isn't in one of the four pre-release states above will produce an
 * economically wrong ledger entry, that precondition is the caller's
 * responsibility (the dispute-resolution route in Stage 3), not something
 * this function can verify from the amounts alone. */
export async function recordRefundFromEscrow(
  supabase: SupabaseClient,
  orderId: number,
  ngnRefundAmountMinor: number,
  usdcAmountMinor: number
): Promise<string> {
  // The exact mirror image of recordFundingConfirmed, every debit
  // becomes a credit and vice versa, same accounts, same amounts (when
  // it's a full refund). That symmetry is what makes
  // funding-then-full-refund net every touched account back to zero.
  return writeLedgerTransaction(supabase, orderId, [
    { account: "ESCROW_WALLET_USDC", direction: "credit", amountMinor: usdcAmountMinor, currency: "USDC" },
    { account: "FX_CLEARING", direction: "debit", amountMinor: usdcAmountMinor, currency: "USDC" },
    { account: "FX_CLEARING", direction: "credit", amountMinor: ngnRefundAmountMinor, currency: "NGN" },
    { account: "EXTERNAL_NGN_BUYER", direction: "debit", amountMinor: ngnRefundAmountMinor, currency: "NGN" },
  ]);
}

/** Prompt 3 (termination flows), Decision 2: a buyer who cancels a
 * FUNDED order before the supplier submits proof gets refunded the order
 * amount minus a disclosed non-refundable fee, the fee is recognized as
 * platform revenue immediately, not left floating. This is the one new
 * ledger shape this pass adds, so the reasoning is spelled out in full
 * rather than assumed:
 *
 * This is exactly recordRefundFromEscrow's shape (refund leg) PLUS
 * recordEscrowRelease's fee-recognition half (fee leg), combined into one
 * balanced transaction instead of two separate ones, same accounts, same
 * directional conventions as both of those functions already established,
 * nothing new invented. `usdcFeeMinor + usdcRefundMinor` must equal
 * exactly what recordFundingConfirmed originally debited into escrow for
 * this order, same invariant recordEscrowRelease's split relies on.
 *
 * Deliberately does NOT handle "cancel after escrow_released", same
 * boundary recordRefundFromEscrow draws: once a release is confirmed,
 * clawing money back is a materially different, harder decision this
 * function doesn't attempt.
 *
 * The fee's NGN-equivalent gets no NGN ledger leg of its own, same
 * "stays as USDC revenue, no per-order NGN conversion" posture
 * recordSettlement's doc comment already states for the platform fee.
 * The NGN figure disclosed to the buyer is recorded separately, in
 * order_cancellations.fee_charged_minor (display/audit), not here.
 *
 * NOTE for review: this is genuinely new accounting logic, not a copy of
 * an existing, already-reviewed function, worth a second look before any
 * of this runs against real money. */
export async function recordPartialRefundWithFee(
  supabase: SupabaseClient,
  orderId: number,
  ngnRefundAmountMinor: number,
  usdcRefundMinor: number,
  usdcFeeMinor: number
): Promise<string> {
  return writeLedgerTransaction(supabase, orderId, [
    // Everything the buyer's original payment put into escrow leaves it
    // now, the refunded portion AND the retained fee portion.
    { account: "ESCROW_WALLET_USDC", direction: "credit", amountMinor: usdcRefundMinor + usdcFeeMinor, currency: "USDC" },
    // Refund leg, mirrors recordRefundFromEscrow exactly, smaller amount.
    { account: "FX_CLEARING", direction: "debit", amountMinor: usdcRefundMinor, currency: "USDC" },
    { account: "FX_CLEARING", direction: "credit", amountMinor: ngnRefundAmountMinor, currency: "NGN" },
    { account: "EXTERNAL_NGN_BUYER", direction: "debit", amountMinor: ngnRefundAmountMinor, currency: "NGN" },
    // Fee leg, mirrors recordEscrowRelease's platform-fee half exactly;
    // no SUPPLIER_PAYABLE leg here since no supplier delivered anything.
    { account: "PLATFORM_REVENUE", direction: "debit", amountMinor: usdcFeeMinor, currency: "USDC" },
  ]);
}
