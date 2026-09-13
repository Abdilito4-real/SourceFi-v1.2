// tests/yellowCardProvider.test.ts
//
// Real Yellow Card integration. tests/testUtils/setupFetchStub.ts stubs
// global.fetch for every other test file in this suite (fails loudly on
// an unrecognized URL); this file overrides it per-test for Yellow
// Card's sandbox host, same pattern tests/fxRate.test.ts already uses,
// relies on the setup file's own afterEach to restore the default stub
// afterward.
//
// The delegated legs (release, rating) and the two legs this class
// throws/refuses on (funding without KYC, a partial refund) are the
// money-relevant surface worth testing directly; the exact request
// body sent to Yellow Card is inspected too, since a wrong field name
// there fails silently against a real API otherwise.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";
import {
  YellowCardProvider,
  MissingBuyerKycError,
  MissingSupplierPayoutProfileError,
  YellowCardPartialRefundUnsupportedError,
  NoFundingReferenceOnFileError,
  YellowCardApiError,
  createSettlementSend,
} from "../lib/yellowCardProvider";
import type { PaymentStatusEvent } from "../lib/paymentBoundary";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeProvider(fake: FakeSupabase) {
  const events: PaymentStatusEvent[] = [];
  const onStatusUpdate = vi.fn((event: PaymentStatusEvent) => {
    events.push(event);
  });
  const provider = new YellowCardProvider(asSupabaseClient(fake), onStatusUpdate, {
    apiKey: "test-api-key",
    secretKey: "test-secret-key",
    environment: "sandbox",
  });
  return { provider, events };
}

function seedFundedOrder(fake: FakeSupabase, overrides: Partial<{ amount_minor: number; buyer_id: number }> = {}) {
  fake.seed("orders", [{ id: 1, amount_minor: overrides.amount_minor ?? 500000, buyer_id: overrides.buyer_id ?? 9 }]);
}

describe("YellowCardProvider.initiateOrderFunding", () => {
  it("throws MissingBuyerKycError when the buyer has no KYC profile on file, never calls the API", async () => {
    const fake = new FakeSupabase();
    seedFundedOrder(fake);
    const { provider } = makeProvider(fake);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(provider.initiateOrderFunding(1)).rejects.toThrow(MissingBuyerKycError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds a bank-transfer-only request with the KYC recipient fields and reports processing", async () => {
    const fake = new FakeSupabase();
    seedFundedOrder(fake, { amount_minor: 500000, buyer_id: 9 });
    fake.seed("buyer_kyc_profiles", [
      {
        user_id: 9,
        first_name: "Ada",
        last_name: "Obi",
        phone: "+2348012345678",
        date_of_birth: "1990-01-01",
        id_type: "nin",
        id_number: "12345678901",
        address: "1 Marina Rd, Lagos",
        country: "NG",
      },
    ]);
    fake.seed("users", [{ id: 9, email: "ada@example.com" }]);
    const { provider } = makeProvider(fake);

    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "receive-abc123", bankInfo: { bankName: "GTBank", accountNumber: "0123456789", accountName: "SourceFi Escrow" } });
      })
    );

    const result = await provider.initiateOrderFunding(1);

    expect(result.status).toBe("processing");
    expect(result.paymentReference).toBe("receive-abc123");
    expect(result.paymentInstructions).toEqual({ bankName: "GTBank", accountNumber: "0123456789", accountName: "SourceFi Escrow" });

    expect(capturedBody).toMatchObject({
      channelType: "bank",
      country: "NG",
      currency: "NGN",
      localAmount: 5000, // 500000 kobo -> 5000 naira
      customerType: "retail",
      customerUID: "9",
      forceAccept: true,
      recipient: {
        name: "Ada Obi",
        phone: "+2348012345678",
        email: "ada@example.com",
        idNumber: "12345678901",
        idType: "nin",
      },
    });
    expect(typeof (capturedBody as unknown as { sequenceId: string }).sequenceId).toBe("string");
  });

  it("the same order always gets the same sequenceId (idempotency), a different order gets a different one", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [
      { id: 1, amount_minor: 500000, buyer_id: 9 },
      { id: 2, amount_minor: 500000, buyer_id: 9 },
    ]);
    fake.seed("buyer_kyc_profiles", [
      { user_id: 9, first_name: "A", last_name: "B", phone: "1", date_of_birth: "1990-01-01", id_type: "nin", id_number: "1", address: "x", country: "NG" },
    ]);
    fake.seed("users", [{ id: 9, email: "a@example.com" }]);
    const { provider } = makeProvider(fake);

    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ id: "receive-1" });
      })
    );

    await provider.initiateOrderFunding(1);
    await provider.initiateOrderFunding(1); // a retry of the SAME order
    await provider.initiateOrderFunding(2);

    const seqIds = bodies.map((b) => b.sequenceId);
    expect(seqIds[0]).toBe(seqIds[1]); // same order, same key
    expect(seqIds[0]).not.toBe(seqIds[2]); // different order, different key
  });

  it("throws YellowCardApiError on a non-OK response, doesn't fabricate a result", async () => {
    const fake = new FakeSupabase();
    seedFundedOrder(fake, { buyer_id: 9 });
    fake.seed("buyer_kyc_profiles", [
      { user_id: 9, first_name: "A", last_name: "B", phone: "1", date_of_birth: "1990-01-01", id_type: "nin", id_number: "1", address: "x", country: "NG" },
    ]);
    fake.seed("users", [{ id: 9, email: "a@example.com" }]);
    const { provider } = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: "INVALID_REQUEST", message: "bad" }, 400)));

    await expect(provider.initiateOrderFunding(1)).rejects.toThrow(YellowCardApiError);
  });
});

describe("YellowCardProvider.initiateRefund", () => {
  it("refuses a partial refund rather than silently sending a full one", async () => {
    const fake = new FakeSupabase();
    seedFundedOrder(fake, { amount_minor: 500000 });
    const { provider } = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn());

    await expect(provider.initiateRefund(1, 300000)).rejects.toThrow(YellowCardPartialRefundUnsupportedError);
  });

  it("throws NoFundingReferenceOnFileError when there's no funding-leg payment_events row", async () => {
    const fake = new FakeSupabase();
    seedFundedOrder(fake, { amount_minor: 500000 });
    const { provider } = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn());

    await expect(provider.initiateRefund(1, 500000)).rejects.toThrow(NoFundingReferenceOnFileError);
  });

  it("a full refund posts to /business/receive/{id}/refund using the original funding reference", async () => {
    const fake = new FakeSupabase();
    seedFundedOrder(fake, { amount_minor: 500000 });
    fake.seed("payment_events", [{ order_id: 1, leg: "funding", provider_reference: "receive-xyz", created_at: new Date().toISOString() }]);
    const { provider } = makeProvider(fake);

    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return jsonResponse({});
      })
    );

    const result = await provider.initiateRefund(1, 500000);
    expect(requestedUrl).toContain("/business/receive/receive-xyz/refund");
    expect(result.refundReference).toBe("receive-xyz");
    expect(result.status).toBe("processing");
  });
});

describe("YellowCardProvider: legs it delegates (release, rating)", () => {
  it("initiateEscrowRelease behaves exactly like the stub it delegates to", async () => {
    const fake = new FakeSupabase();
    const { provider, events } = makeProvider(fake);
    const result = await provider.initiateEscrowRelease(3);
    expect(result.status).toBe("processing");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((e) => e.leg === "release" && e.provider === "circle")).toBe(true);
  });

  it("submitRatingOnChain never auto-confirms, same as the stub", async () => {
    const fake = new FakeSupabase();
    const { provider } = makeProvider(fake);
    const result = await provider.submitRatingOnChain(1, 5, 5, "Great supplier");
    expect(result.status).toBe("submitted");
    expect(result.txHash).toBeNull();
  });
});

const YC_CONFIG = { apiKey: "test-api-key", secretKey: "test-secret-key", environment: "sandbox" as const };

function seedSupplierWithPayout(fake: FakeSupabase, overrides: Partial<{ userId: number; profileId: number }> = {}) {
  const userId = overrides.userId ?? 20;
  const profileId = overrides.profileId ?? 5;
  fake.seed("supplier_profiles", [{ id: profileId, user_id: userId }]);
  fake.seed("supplier_payout_profiles", [
    { user_id: userId, bank_name: "GTBank", account_number: "0123456789", account_name: "Lagos Cement Co", bank_network_id: "yc-network-1" },
  ]);
  return { userId, profileId };
}

describe("createSettlementSend: real supplier payout via Yellow Card's Send API", () => {
  beforeEach(() => {
    process.env.YELLOW_CARD_ESCROW_CRYPTO_NETWORK = "ETH";
  });
  afterEach(() => {
    delete process.env.YELLOW_CARD_ESCROW_CRYPTO_NETWORK;
  });

  it("throws MissingSupplierPayoutProfileError when the supplier has no payout bank details on file, never calls the API", async () => {
    const fake = new FakeSupabase();
    fake.seed("supplier_profiles", [{ id: 5, user_id: 20 }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 1, supplierProfileId: 5, ngnAmountMinor: 500_000 })
    ).rejects.toThrow(MissingSupplierPayoutProfileError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws when YELLOW_CARD_ESCROW_CRYPTO_NETWORK isn't set, never calls the API — refuses to guess the chain", async () => {
    delete process.env.YELLOW_CARD_ESCROW_CRYPTO_NETWORK;
    const fake = new FakeSupabase();
    seedSupplierWithPayout(fake);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 1, supplierProfileId: 5, ngnAmountMinor: 500_000 })
    ).rejects.toThrow(/YELLOW_CARD_ESCROW_CRYPTO_NETWORK/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds a directSettlement Send request from the supplier's payout profile and returns the deposit address", async () => {
    const fake = new FakeSupabase();
    seedSupplierWithPayout(fake);

    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ id: "send-abc123", cryptoDepositAddress: "0xDEPOSIT" }), { status: 200 });
      })
    );

    const result = await createSettlementSend(asSupabaseClient(fake), YC_CONFIG, {
      orderId: 7,
      supplierProfileId: 5,
      ngnAmountMinor: 500_000, // 5,000 naira
    });

    expect(result).toEqual({ sendReference: "send-abc123", cryptoDepositAddress: "0xDEPOSIT" });
    expect(capturedBody).toMatchObject({
      channelType: "bank",
      country: "NG",
      currency: "NGN",
      localAmount: 5000,
      directSettlement: true,
      settlementInfo: { cryptoCurrency: "USDC", cryptoNetwork: "ETH" },
      reason: "other",
      destination: {
        accountType: "bank",
        accountBank: "GTBank",
        accountName: "Lagos Cement Co",
        accountNumber: "0123456789",
        networkId: "yc-network-1",
      },
    });
    expect(typeof (capturedBody as unknown as { sequenceId: string }).sequenceId).toBe("string");
  });

  it("the same order always gets the same sequenceId (idempotency), a different order gets a different one", async () => {
    const fake = new FakeSupabase();
    seedSupplierWithPayout(fake);
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ id: "send-1", cryptoDepositAddress: "0xDEPOSIT" }), { status: 200 });
      })
    );

    await createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 1, supplierProfileId: 5, ngnAmountMinor: 500_000 });
    await createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 1, supplierProfileId: 5, ngnAmountMinor: 500_000 }); // a retry
    await createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 2, supplierProfileId: 5, ngnAmountMinor: 500_000 });

    const seqIds = bodies.map((b) => b.sequenceId);
    expect(seqIds[0]).toBe(seqIds[1]);
    expect(seqIds[0]).not.toBe(seqIds[2]);
  });

  it("throws if Yellow Card's response has no crypto deposit address in any expected field, doesn't fabricate one", async () => {
    const fake = new FakeSupabase();
    seedSupplierWithPayout(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "send-no-address" }), { status: 200 })));

    await expect(
      createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 1, supplierProfileId: 5, ngnAmountMinor: 500_000 })
    ).rejects.toThrow(/deposit address/);
  });

  it("throws YellowCardApiError on a non-OK response, doesn't fabricate a result", async () => {
    const fake = new FakeSupabase();
    seedSupplierWithPayout(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "INVALID_REQUEST" }), { status: 400 })));

    await expect(
      createSettlementSend(asSupabaseClient(fake), YC_CONFIG, { orderId: 1, supplierProfileId: 5, ngnAmountMinor: 500_000 })
    ).rejects.toThrow(YellowCardApiError);
  });
});

describe("YellowCardProvider.checkAndReportSettlementStatus", () => {
  it("still pending: returns false, reports nothing", async () => {
    const fake = new FakeSupabase();
    const { provider, events } = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "pending" }), { status: 200 })));

    expect(await provider.checkAndReportSettlementStatus(7, "send-pending")).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("confirmed: reports a settlement leg event for handleSettlementConfirmed to pick up", async () => {
    const fake = new FakeSupabase();
    const { provider, events } = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "complete" }), { status: 200 })));

    expect(await provider.checkAndReportSettlementStatus(7, "send-ok")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orderId: 7, leg: "settlement", provider: "yellow_card", providerReference: "send-ok" });
  });

  it("failed: reports true (handled) but never calls onStatusUpdate, no fabricated success", async () => {
    const fake = new FakeSupabase();
    const { provider, events } = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "failed" }), { status: 200 })));

    expect(await provider.checkAndReportSettlementStatus(7, "send-failed")).toBe(true);
    expect(events).toHaveLength(0);
  });
});
