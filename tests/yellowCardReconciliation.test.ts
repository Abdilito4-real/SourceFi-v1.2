// tests/yellowCardReconciliation.test.ts
//
// lib/yellowCardReconciliation.ts's three per-leg sweeps, tested directly
// against a lightweight fake provider (not the real singleton wiring in
// lib/paymentProvider.ts) — proves the query construction (right status,
// right leg, past the staleness cutoff) and the resolved/stillPending/
// checked counting are correct, same posture tests/releaseReconciliation
// would take if one existed for the Circle sweep this mirrors.
import { describe, it, expect, vi } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";
import { reconcileRefunds, reconcileSettlements, reconcileTopups } from "../lib/yellowCardReconciliation";

const STALE = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // well past the 2-minute threshold
const FRESH = new Date().toISOString(); // well within it

describe("reconcileRefunds", () => {
  it("re-checks a stuck refund_processing order with a real Yellow Card reference, and reports resolved", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 1, status: "refund_processing", updated_at: STALE }]);
    fake.seed("payment_events", [
      { id: 1, order_id: 1, leg: "refund", provider: "yellow_card", provider_reference: "yc-refund-1", created_at: STALE },
    ]);
    const provider = { checkAndReportReceiveStatus: vi.fn().mockResolvedValue(true) };

    const result = await reconcileRefunds(asSupabaseClient(fake), provider as never);

    expect(result).toEqual({ checked: 1, resolved: 1, stillPending: 0 });
    expect(provider.checkAndReportReceiveStatus).toHaveBeenCalledWith(1, "yc-refund-1", "refund");
  });

  it("counts it as still pending when the provider reports no change yet", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 1, status: "refund_processing", updated_at: STALE }]);
    fake.seed("payment_events", [{ id: 1, order_id: 1, leg: "refund", provider: "yellow_card", provider_reference: "yc-refund-1", created_at: STALE }]);
    const provider = { checkAndReportReceiveStatus: vi.fn().mockResolvedValue(false) };

    const result = await reconcileRefunds(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 1, resolved: 0, stillPending: 1 });
  });

  it("a provider error counts as still pending, doesn't throw and abort the sweep", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 1, status: "refund_processing", updated_at: STALE }]);
    fake.seed("payment_events", [{ id: 1, order_id: 1, leg: "refund", provider: "yellow_card", provider_reference: "yc-refund-1", created_at: STALE }]);
    const provider = { checkAndReportReceiveStatus: vi.fn().mockRejectedValue(new Error("network drop")) };

    const result = await reconcileRefunds(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 1, resolved: 0, stillPending: 1 });
  });

  it("ignores an order that hasn't been stuck long enough yet", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 1, status: "refund_processing", updated_at: FRESH }]);
    const provider = { checkAndReportReceiveStatus: vi.fn() };

    const result = await reconcileRefunds(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 0, resolved: 0, stillPending: 0 });
    expect(provider.checkAndReportReceiveStatus).not.toHaveBeenCalled();
  });

  it("a wallet-funded refund (provider=wallet) is counted as checked but never re-fetched — it resolves synchronously, this is a defensive filter not a real case", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 1, status: "refund_processing", updated_at: STALE }]);
    fake.seed("payment_events", [{ id: 1, order_id: 1, leg: "refund", provider: "wallet", provider_reference: "wallet-refund-1", created_at: STALE }]);
    const provider = { checkAndReportReceiveStatus: vi.fn() };

    const result = await reconcileRefunds(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 1, resolved: 0, stillPending: 0 });
    expect(provider.checkAndReportReceiveStatus).not.toHaveBeenCalled();
  });

  it("ignores orders in any other status entirely", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 1, status: "funded", updated_at: STALE }]);
    const provider = { checkAndReportReceiveStatus: vi.fn() };

    const result = await reconcileRefunds(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 0, resolved: 0, stillPending: 0 });
  });
});

describe("reconcileSettlements", () => {
  it("re-checks a stuck settlement_processing order and reports resolved", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 7, status: "settlement_processing", updated_at: STALE }]);
    fake.seed("payment_events", [{ id: 1, order_id: 7, leg: "settlement", provider_reference: "send-42", created_at: STALE }]);
    const provider = { checkAndReportSettlementStatus: vi.fn().mockResolvedValue(true) };

    const result = await reconcileSettlements(asSupabaseClient(fake), provider as never);

    expect(result).toEqual({ checked: 1, resolved: 1, stillPending: 0 });
    expect(provider.checkAndReportSettlementStatus).toHaveBeenCalledWith(7, "send-42");
  });

  it("skips an order with no settlement reference on file yet", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 7, status: "settlement_processing", updated_at: STALE }]);
    const provider = { checkAndReportSettlementStatus: vi.fn() };

    const result = await reconcileSettlements(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 1, resolved: 0, stillPending: 0 });
    expect(provider.checkAndReportSettlementStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileTopups", () => {
  it("re-checks a stuck processing top-up and reports resolved", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { id: 1, user_id: 1, type: "topup", status: "processing", provider_reference: "yc-receive-9", created_at: STALE },
    ]);
    const provider = { checkAndReportTopupStatus: vi.fn().mockResolvedValue(true) };

    const result = await reconcileTopups(asSupabaseClient(fake), provider as never);

    expect(result).toEqual({ checked: 1, resolved: 1, stillPending: 0 });
    expect(provider.checkAndReportTopupStatus).toHaveBeenCalledWith("yc-receive-9");
  });

  it("ignores an already-confirmed top-up", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { id: 1, user_id: 1, type: "topup", status: "confirmed", provider_reference: "yc-receive-9", created_at: STALE },
    ]);
    const provider = { checkAndReportTopupStatus: vi.fn() };

    const result = await reconcileTopups(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 0, resolved: 0, stillPending: 0 });
  });

  it("ignores a fresh (not yet stuck) top-up", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { id: 1, user_id: 1, type: "topup", status: "processing", provider_reference: "yc-receive-9", created_at: FRESH },
    ]);
    const provider = { checkAndReportTopupStatus: vi.fn() };

    const result = await reconcileTopups(asSupabaseClient(fake), provider as never);
    expect(result).toEqual({ checked: 0, resolved: 0, stillPending: 0 });
  });
});
