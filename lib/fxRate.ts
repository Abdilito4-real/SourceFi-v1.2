// lib/fxRate.ts
//
// Live NGN/USD exchange rate, replacing the hardcoded placeholder that
// used to live in lib/orderService.ts (PLACEHOLDER_NGN_PER_USDC = 1600).
// USDC is treated as 1:1 with USD, true within a fraction of a cent in
// practice, so "NGN per USD" from a standard FX source is exactly the
// rate a real Circle release needs to convert an NGN order amount into
// a USDC transfer amount.
//
// Source: open.er-api.com, ExchangeRate-API's free, keyless, open-
// access endpoint. Updates once daily, no account/API key exists for a
// paid FX provider anywhere in this project, and this app has no
// Yellow Card integration yet either (that would be the more natural
// long-term source, once it exists). Deliberately does NOT silently
// fall back to a guessed/stale rate past CACHE_MAX_AGE_MS, this number
// determines how much real money moves, "fail loudly" beats "send the
// wrong amount confidently", same posture lib/circleEscrowProvider.ts
// already takes for missing wallets/insufficient balance.
import "server-only";

const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
// The source only refreshes once/day; serving a recently-cached value
// through a transient fetch failure is reasonable, serving a week-old
// one to compute a real release amount is not.
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 8000;

export class FxRateUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      `Could not get a current NGN/USD exchange rate, and no recent cached rate is available.${
        cause instanceof Error ? ` (${cause.message})` : ""
      }`
    );
    this.name = "FxRateUnavailableError";
  }
}

let cached: { ngnPerUsd: number; fetchedAt: number } | null = null;

/** NGN per 1 USD (see module comment for why this doubles as NGN per
 * USDC). Fetches fresh every call, no in-request memoization beyond
 * the transient-failure fallback below, a release is rare enough
 * (nowhere near this source's rate limit) that "always current" is
 * worth more here than saving a request. */
export async function getNgnPerUsd(): Promise<number> {
  try {
    const res = await fetch(FX_API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`FX API returned HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.NGN;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error("FX API response had no usable NGN rate.");
    }
    cached = { ngnPerUsd: rate, fetchedAt: Date.now() };
    return rate;
  } catch (err) {
    if (cached && Date.now() - cached.fetchedAt <= CACHE_MAX_AGE_MS) {
      return cached.ngnPerUsd;
    }
    throw new FxRateUnavailableError(err);
  }
}

/** Test-only: module-level cache would otherwise leak state between
 * test cases. Not used by any real code path. */
export function __resetFxRateCacheForTests(): void {
  cached = null;
}
