// tests/callVerification.test.ts
//
// computeOverlapSeconds is the fix for the sharpest gap a security audit
// of the live-verification-call flow found: a bare running total let
// either party alone satisfy the whole call-duration requirement with
// one fabricated report, zero corroboration the other party was ever
// connected. This pins down that the overlap math actually only credits
// time BOTH parties independently reported, not either side alone —
// same rigor as tests/supplierTrust.test.ts gives computeSupplierTier,
// the other pure trust-signal function in this codebase.
import { describe, it, expect } from "vitest";
import { computeOverlapSeconds, mergeIntervals, type CallInterval } from "../lib/callVerification";

// Small helper: intervals expressed in whole seconds from an arbitrary
// epoch, converted to the ms the real functions operate on, so test
// cases read as plain numbers instead of Date arithmetic.
function iv(startSec: number, endSec: number): CallInterval {
  return { startedAt: startSec * 1000, endedAt: endSec * 1000 };
}

describe("computeOverlapSeconds", () => {
  it("credits zero when only one party has ever reported anything, no matter how long", () => {
    // The exact attack a security audit found: one party spamming
    // fabricated segments alone, nobody on the other side ever reporting
    // anything overlapping.
    expect(computeOverlapSeconds([iv(0, 7200)], [])).toBe(0);
    expect(computeOverlapSeconds([], [iv(0, 7200)])).toBe(0);
  });

  it("credits the full overlap when both parties report the same window", () => {
    expect(computeOverlapSeconds([iv(0, 300)], [iv(0, 300)])).toBe(300);
  });

  it("credits only the intersection when the two parties' windows partially overlap", () => {
    // Buyer on the call 0-200s, supplier joins late at 100s and stays to
    // 300s: only the 100-200s window is corroborated by both.
    expect(computeOverlapSeconds([iv(0, 200)], [iv(100, 300)])).toBe(100);
  });

  it("credits zero when the two parties' windows don't overlap at all", () => {
    // Buyer's call ended before the supplier's ever started, e.g. two
    // entirely separate unilateral fabricated reports with no real call
    // connecting them.
    expect(computeOverlapSeconds([iv(0, 100)], [iv(200, 300)])).toBe(0);
  });

  it("sums overlap across multiple disjoint segments from a real call that dropped and reconnected", () => {
    // Both parties reconnect together twice: 0-60s and 120-180s, 60s of
    // real overlap each time.
    expect(computeOverlapSeconds([iv(0, 60), iv(120, 180)], [iv(0, 60), iv(120, 180)])).toBe(120);
  });

  it("does not let a single party's own duplicated/overlapping segment reports inflate the total", () => {
    // A flaky-network resend reporting the same 0-300s window twice from
    // the SAME party (buyer) must not count as 600s of buyer time before
    // intersecting with the supplier's single genuine 0-300s segment —
    // mergeIntervals is what prevents this.
    expect(computeOverlapSeconds([iv(0, 300), iv(0, 300)], [iv(0, 300)])).toBe(300);
  });

  it("handles a segment fully contained inside the other party's longer segment", () => {
    expect(computeOverlapSeconds([iv(0, 1000)], [iv(400, 500)])).toBe(100);
  });

  it("is symmetric: swapping which list is 'buyer' and which is 'supplier' doesn't change the result", () => {
    const a = [iv(0, 200), iv(500, 700)];
    const b = [iv(150, 600)];
    expect(computeOverlapSeconds(a, b)).toBe(computeOverlapSeconds(b, a));
  });

  it("returns 0 for two empty lists", () => {
    expect(computeOverlapSeconds([], [])).toBe(0);
  });
});

describe("mergeIntervals", () => {
  it("returns an empty array for no intervals", () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it("merges touching/overlapping intervals into one", () => {
    expect(mergeIntervals([iv(0, 100), iv(100, 200)])).toEqual([iv(0, 200)]);
    expect(mergeIntervals([iv(0, 150), iv(100, 200)])).toEqual([iv(0, 200)]);
  });

  it("keeps genuinely disjoint (non-touching) intervals separate", () => {
    expect(mergeIntervals([iv(0, 100), iv(200, 300)])).toEqual([iv(0, 100), iv(200, 300)]);
  });

  it("sorts before merging, order of input doesn't matter", () => {
    expect(mergeIntervals([iv(200, 300), iv(0, 100)])).toEqual([iv(0, 100), iv(200, 300)]);
  });

  it("merges an interval fully contained inside an earlier, longer one without shrinking it", () => {
    expect(mergeIntervals([iv(0, 500), iv(100, 200)])).toEqual([iv(0, 500)]);
  });
});
