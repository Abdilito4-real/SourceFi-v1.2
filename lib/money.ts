// lib/money.ts
//
// Money lives in the database as integer minor units (cents), see the
// Stage 5 data-layer migration. This is the one place that converts
// between that and the display/input numbers a form or screen deals in.
// Never do this conversion ad hoc at a call site, that's exactly how
// floats crept back into a codebase that just spent a migration getting
// rid of them.
import type { Currency } from "./types";

/** Display amount (e.g. 50, "50.00" typed into a form) -> integer minor
 * units. Throws on anything that isn't a finite, non-negative number once
 * parsed, callers validate user input before this, it doesn't fail
 * gracefully on their behalf. */
export function toMinorUnits(amount: number | string): number {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return Math.round(n * 100);
}

export function fromMinorUnits(minor: number | null | undefined): number {
  if (minor === null || minor === undefined) return 0;
  return minor / 100;
}

const CURRENCY_LOCALE: Record<Currency, string> = { USD: "en-US", NGN: "en-NG" };

/** Minor units -> a formatted display string ("$50.00", "₦50.00"). */
export function formatMoney(minor: number | null | undefined, currency: Currency = "USD"): string {
  const amount = fromMinorUnits(minor);
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE[currency] ?? "en-US", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    // Intl.NumberFormat throws on an unrecognized currency code, fall
    // back to a plain number rather than crash a render over it.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** @deprecated Superseded by ORDER_PLATFORM_FEE_MINOR, the sourcer-claim
 * flow this fee applied to no longer exists as of the marketplace pivot.
 * The flat platform fee taken on every claimed request, in minor units.
 * Was a magic "+ 5.0" scattered across the client before Stage 5, now
 * one server-side constant, computed at claim time and stored on the
 * request row rather than recomputed (and implicitly trusted from the
 * client) on every subsequent read.
 */
export const PLATFORM_FEE_MINOR = 500; // $5.00

/** The flat platform fee on every order, in NGN minor units (kobo).
 * Same placeholder posture as PLATFORM_FEE_MINOR before it: a real,
 * possibly non-flat or percentage-based fee schedule is a genuine
 * business decision (design doc Section J), not something to default
 * silently on a hackathon timeline. ₦2,000 is a round placeholder
 * number, computed server-side at order-creation time and stored on
 * orders.platform_fee_minor, never re-derived from client input on a
 * later read, same discipline as the fee it replaces. */
export const ORDER_PLATFORM_FEE_MINOR = 200_000; // ₦2,000.00

/** The smallest order amount the platform will accept, in NGN minor
 * units. Exists because ORDER_PLATFORM_FEE_MINOR is flat, not
 * percentage-based: without a floor, an order smaller than the fee
 * produces a NEGATIVE supplier payout (amount - fee < 0), which
 * lib/ledger.ts's balance invariant correctly refuses to write (see the
 * "mandatory live verification call" describe block in
 * tests/orderService.test.ts for how that surfaced). ₦5,000 is a round
 * number comfortably above the ₦2,000 fee, enough that a supplier is
 * never left with a token payout, not a precise revenue-model number.
 * Enforced in createOrder() below, the single place orders are created. */
export const MIN_ORDER_AMOUNT_MINOR = 500_000; // ₦5,000.00

/** Feedback-layer rule: "Above a configurable threshold, require typed
 * confirmation (type the amount) rather than a single tap." A single round
 * number, not derived from anything else here, tune freely, nothing else
 * depends on this value. Applied to both funding and release confirmations
 * in OrderDetailsModal.tsx. */
export const TYPED_CONFIRMATION_THRESHOLD_MINOR = 100_000_000; // ₦1,000,000.00

/** Prompt 3, Decision 2: the disclosed non-refundable fee a buyer forfeits
 * cancelling a FUNDED order before the supplier submits proof, reuses
 * the existing platform fee rather than inventing a second number. Lives
 * here (not lib/orderService.ts, which pulls in Node's `crypto` and can't
 * be imported from a client component) so both the client-side
 * disclosure copy (OrderDetailsModal's Fund Order and Cancel dialogs) and
 * the server-side lib/orderService.ts (which re-exports this same value
 * as CANCELLATION_FEE_MINOR) read one shared number, never two. */
export const CANCELLATION_FEE_MINOR = ORDER_PLATFORM_FEE_MINOR;

/** Smallest wallet top-up the platform will accept, in NGN minor units.
 * Same "round placeholder, not a precise business number" posture as
 * MIN_ORDER_AMOUNT_MINOR. Below MIN_ORDER_AMOUNT_MINOR itself would be a
 * top-up that can never actually fund any order on its own, so this
 * matches that floor exactly rather than inventing a separate number.
 * Enforced in lib/walletService.ts's initiateWalletTopup(). */
export const MIN_WALLET_TOPUP_MINOR = MIN_ORDER_AMOUNT_MINOR;
