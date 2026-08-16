// tests/supplierVerification.test.ts
//
// design doc Section D.2: 90 days OR 20 orders, whichever comes first,
// and the authorization check is always live (delegated to Postgres),
// never the cached column alone. This file tests the two pieces that
// live in application code: the expiry-date arithmetic, and that the
// live-check wrapper actually calls the DB function rather than reading
// any cached value itself.
import { describe, it, expect, vi } from "vitest";
import { computeVerificationExpiry, isSupplierCurrentlyVerified, SUPPLIER_VERIFICATION_ORDER_LIMIT } from "../lib/supplierVerification";

describe("computeVerificationExpiry", () => {
  it("is exactly 90 days after the approval timestamp", () => {
    const approvedAt = new Date("2026-08-16T00:00:00.000Z");
    const expiry = computeVerificationExpiry(approvedAt);
    const diffDays = (expiry.getTime() - approvedAt.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(90);
  });

  it("defaults to now() when no approval timestamp is given", () => {
    const before = Date.now();
    const expiry = computeVerificationExpiry();
    const after = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + ninetyDaysMs);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + ninetyDaysMs);
  });

  it("the order limit constant matches the design doc's 20-order threshold", () => {
    expect(SUPPLIER_VERIFICATION_ORDER_LIMIT).toBe(20);
  });
});

describe("isSupplierCurrentlyVerified — always delegates to the live DB function", () => {
  function mockSupabaseRpc(returnValue: boolean, error: unknown = null) {
    const rpc = vi.fn(async () => ({ data: returnValue, error }));
    return { rpc } as never as import("@supabase/supabase-js").SupabaseClient;
  }

  it("returns true only when the RPC call reports true", async () => {
    const client = mockSupabaseRpc(true);
    await expect(isSupplierCurrentlyVerified(client, 5)).resolves.toBe(true);
    expect((client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "is_supplier_currently_verified",
      { p_supplier_id: 5 }
    );
  });

  it("returns false when the RPC call reports false (expired or never verified)", async () => {
    const client = mockSupabaseRpc(false);
    await expect(isSupplierCurrentlyVerified(client, 5)).resolves.toBe(false);
  });

  it("propagates a DB error rather than silently treating it as unverified", async () => {
    const client = mockSupabaseRpc(false, new Error("connection reset"));
    await expect(isSupplierCurrentlyVerified(client, 5)).rejects.toThrow("connection reset");
  });
});
