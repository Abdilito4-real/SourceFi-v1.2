// tests/receiptService.test.ts
//
// lib/receiptService.ts is a pure read over data other services already
// write (orders, payment_events, wallet_transactions) — no new table,
// so these tests seed exactly what handleFundingConfirmed/
// handleSettlementConfirmed/confirmWalletTopup already leave behind
// and assert the receipt reconstructs it correctly, plus the "hasn't
// happened yet" not-found cases.
import { describe, it, expect } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";
import { getFundingReceipt, getSettlementReceipt, getTopupReceipt, ReceiptNotFoundError } from "../lib/receiptService";

function seedOrder(fake: FakeSupabase) {
  fake.seed("users", [
    { id: 1, email: "buyer@example.com", role: "buyer" },
    { id: 2, email: "supplier-owner@example.com", role: "supplier" },
  ]);
  fake.seed("supplier_profiles", [{ id: 10, user_id: 2, business_name: "Lagos BuildCo" }]);
  fake.seed("orders", [
    {
      id: 7,
      order_code: "ORD-000007",
      title: "500 units BubbleDeck Slabs",
      buyer_id: 1,
      supplier_id: 10,
      amount_minor: 500_000_00,
      platform_fee_minor: 20_000_00,
    },
  ]);
}

describe("getFundingReceipt", () => {
  it("reconstructs gross/fee/net from the order row and the funding_confirmed event", async () => {
    const fake = new FakeSupabase();
    seedOrder(fake);
    fake.seed("payment_events", [
      {
        id: 1,
        order_id: 7,
        leg: "funding",
        event_type: "funding_confirmed",
        provider: "wallet",
        provider_reference: "wallet-fund-7",
        tx_hash: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const receipt = await getFundingReceipt(asSupabaseClient(fake), 7);
    expect(receipt).toMatchObject({
      kind: "funding",
      orderId: 7,
      orderCode: "ORD-000007",
      grossAmountMinor: 500_000_00,
      platformFeeMinor: 20_000_00,
      netAmountMinor: 480_000_00,
      buyerEmail: "buyer@example.com",
      supplierBusinessName: "Lagos BuildCo",
      provider: "wallet",
      providerReference: "wallet-fund-7",
      confirmedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("throws ReceiptNotFoundError when the order hasn't funded yet (no funding_confirmed event)", async () => {
    const fake = new FakeSupabase();
    seedOrder(fake);
    await expect(getFundingReceipt(asSupabaseClient(fake), 7)).rejects.toThrow(ReceiptNotFoundError);
  });

  it("throws ReceiptNotFoundError for a nonexistent order", async () => {
    const fake = new FakeSupabase();
    await expect(getFundingReceipt(asSupabaseClient(fake), 999)).rejects.toThrow(ReceiptNotFoundError);
  });
});

describe("getSettlementReceipt", () => {
  it("reconstructs gross/fee/net from the order row and the settlement_confirmed event, with the real tx hash", async () => {
    const fake = new FakeSupabase();
    seedOrder(fake);
    fake.seed("payment_events", [
      {
        id: 2,
        order_id: 7,
        leg: "settlement",
        event_type: "settlement_confirmed",
        provider: "yellow_card",
        provider_reference: "send-42",
        tx_hash: "0xrealtxhash",
        created_at: "2026-01-05T00:00:00.000Z",
      },
    ]);

    const receipt = await getSettlementReceipt(asSupabaseClient(fake), 7);
    expect(receipt).toMatchObject({
      kind: "settlement",
      netAmountMinor: 480_000_00,
      provider: "yellow_card",
      providerReference: "send-42",
      txHash: "0xrealtxhash",
    });
  });

  it("throws ReceiptNotFoundError before settlement confirms", async () => {
    const fake = new FakeSupabase();
    seedOrder(fake);
    await expect(getSettlementReceipt(asSupabaseClient(fake), 7)).rejects.toThrow(ReceiptNotFoundError);
  });
});

describe("getTopupReceipt", () => {
  it("returns a confirmed top-up's receipt", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { id: 1, user_id: 1, type: "topup", amount_minor: 75_000_00, provider_reference: "yc-receive-1", status: "confirmed", created_at: "2026-01-01T00:00:00.000Z" },
    ]);

    const receipt = await getTopupReceipt(asSupabaseClient(fake), 1, "yc-receive-1");
    expect(receipt).toMatchObject({ kind: "topup", reference: "yc-receive-1", amountMinor: 75_000_00, provider: "yellow_card" });
  });

  it("throws ReceiptNotFoundError for a still-processing top-up (not confirmed yet)", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { id: 1, user_id: 1, type: "topup", amount_minor: 75_000_00, provider_reference: "yc-receive-1", status: "processing", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(getTopupReceipt(asSupabaseClient(fake), 1, "yc-receive-1")).rejects.toThrow(ReceiptNotFoundError);
  });

  it("throws ReceiptNotFoundError for another user's reference — self-only", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { id: 1, user_id: 2, type: "topup", amount_minor: 75_000_00, provider_reference: "yc-receive-1", status: "confirmed", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
    await expect(getTopupReceipt(asSupabaseClient(fake), 1, "yc-receive-1")).rejects.toThrow(ReceiptNotFoundError);
  });
});
