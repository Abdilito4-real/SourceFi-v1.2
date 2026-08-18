// tests/fxRate.test.ts
//
// lib/fxRate.ts decides exactly how much real USDC a real Circle
// release sends, worth pinning down its failure/caching behavior
// directly rather than only indirectly through orderService tests.
// tests/testUtils/setupFetchStub.ts stubs global.fetch for every OTHER
// test file in this suite; this file overrides that stub per-test to
// exercise fxRate's own success/failure/cache paths, then relies on the
// setup file's own afterEach to restore the default stub for whatever
// test file runs next.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getNgnPerUsd, FxRateUnavailableError, __resetFxRateCacheForTests } from "../lib/fxRate";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  __resetFxRateCacheForTests();
  vi.useRealTimers();
});

describe("getNgnPerUsd", () => {
  it("returns the rate from a successful fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rates: { NGN: 1500 } })));
    expect(await getNgnPerUsd()).toBe(1500);
  });

  it("throws FxRateUnavailableError on a network failure with no prior cache, rather than guessing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(getNgnPerUsd()).rejects.toThrow(FxRateUnavailableError);
  });

  it("throws FxRateUnavailableError when the response has no usable NGN rate", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rates: { USD: 1 } })));
    await expect(getNgnPerUsd()).rejects.toThrow(FxRateUnavailableError);
  });

  it("throws FxRateUnavailableError on a non-OK HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    await expect(getNgnPerUsd()).rejects.toThrow(FxRateUnavailableError);
  });

  it("falls back to a recently-cached rate when a later fetch fails transiently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rates: { NGN: 1620 } })));
    expect(await getNgnPerUsd()).toBe(1620);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await getNgnPerUsd()).toBe(1620);
  });

  it("does NOT fall back to a cached rate once it's older than the cache's max age, fails loudly instead of guessing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rates: { NGN: 1620 } })));
    expect(await getNgnPerUsd()).toBe(1620);

    // 7 hours later, past the 6-hour cache ceiling.
    vi.setSystemTime(new Date("2026-01-01T07:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("still down")));
    await expect(getNgnPerUsd()).rejects.toThrow(FxRateUnavailableError);
  });
});
