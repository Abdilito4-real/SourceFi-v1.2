// tests/supplierTrust.test.ts
//
// computeSupplierTier is pure and it's the one place that decides what
// badge a buyer sees before sending money to a supplier, worth pinning
// down exactly, boundary values included, same rigor as
// lib/supplierVerification.ts's computeVerificationExpiry tests.
import { describe, it, expect } from "vitest";
import { computeSupplierTier, type SupplierTrustSignals } from "../lib/supplierTrust";

function signals(overrides: Partial<SupplierTrustSignals> = {}): SupplierTrustSignals {
  return {
    currentlyVerified: true,
    completedOrderCount: 0,
    ratingAverage: null,
    ratingCount: 0,
    ...overrides,
  };
}

describe("computeSupplierTier", () => {
  it("returns null for a supplier who isn't currently verified, regardless of how good their other numbers are", () => {
    const tier = computeSupplierTier(
      signals({ currentlyVerified: false, completedOrderCount: 999, ratingAverage: 5, ratingCount: 999 })
    );
    expect(tier).toBeNull();
  });

  it("a freshly verified supplier with no orders or ratings yet is just 'verified'", () => {
    expect(computeSupplierTier(signals())).toBe("verified");
  });

  it("does not promote to verified_pro on order count alone, without enough ratings", () => {
    expect(computeSupplierTier(signals({ completedOrderCount: 50, ratingAverage: null, ratingCount: 0 }))).toBe("verified");
  });

  it("does not promote to verified_pro below the rating average threshold, even with enough orders and rating count", () => {
    expect(computeSupplierTier(signals({ completedOrderCount: 10, ratingAverage: 3.9, ratingCount: 5 }))).toBe("verified");
  });

  it("promotes to verified_pro exactly at all three thresholds", () => {
    expect(computeSupplierTier(signals({ completedOrderCount: 10, ratingAverage: 4.0, ratingCount: 5 }))).toBe("verified_pro");
  });

  it("does not promote to elite one order short of the threshold", () => {
    expect(computeSupplierTier(signals({ completedOrderCount: 29, ratingAverage: 4.9, ratingCount: 20 }))).toBe("verified_pro");
  });

  it("promotes to elite exactly at all three thresholds", () => {
    expect(computeSupplierTier(signals({ completedOrderCount: 30, ratingAverage: 4.7, ratingCount: 15 }))).toBe("elite");
  });

  it("a huge order count with a mediocre rating stays at verified_pro, not elite: volume alone can't buy the top tier", () => {
    expect(computeSupplierTier(signals({ completedOrderCount: 500, ratingAverage: 4.5, ratingCount: 200 }))).toBe("verified_pro");
  });
});
