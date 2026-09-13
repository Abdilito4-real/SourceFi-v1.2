// tests/yellowCardWalletTopupProvider.test.ts
//
// Real Yellow Card wallet top-up. Same pattern as
// tests/yellowCardProvider.test.ts: vi.stubGlobal("fetch", ...) per
// test, FakeSupabase seeding, the exact request body inspected (a wrong
// field name fails silently against a real API otherwise). Covers the
// money-relevant surface: the KYC guard, the idempotency key -> sequenceId
// derivation, API-error propagation, and checkAndReportTopupStatus's
// three outcomes (confirmed, failed, still pending).
import { describe, it, expect, vi } from "vitest";
import { FakeSupabase, asSupabaseClient, wireWalletRpcs } from "./testUtils/fakeSupabase";
import { YellowCardWalletTopupProvider } from "../lib/yellowCardWalletTopupProvider";
import { MissingBuyerKycError, YellowCardApiError } from "../lib/yellowCardProvider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeProvider(fake: FakeSupabase) {
  return new YellowCardWalletTopupProvider(asSupabaseClient(fake), {
    apiKey: "test-api-key",
    secretKey: "test-secret-key",
    environment: "sandbox",
  });
}

function seedKycBuyer(fake: FakeSupabase, userId: number) {
  fake.seed("users", [{ id: userId, email: "ada@example.com" }]);
  fake.seed("buyer_kyc_profiles", [
    {
      user_id: userId,
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
}

describe("YellowCardWalletTopupProvider.initiateTopup", () => {
  it("throws MissingBuyerKycError when the buyer has no KYC profile on file, never calls the API", async () => {
    const fake = new FakeSupabase();
    fake.seed("users", [{ id: 9, email: "ada@example.com" }]);
    const provider = makeProvider(fake);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(provider.initiateTopup(9, 500_000_00, "idem-1")).rejects.toThrow(MissingBuyerKycError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds a bank-transfer-only request with the KYC recipient fields and reports processing", async () => {
    const fake = new FakeSupabase();
    seedKycBuyer(fake, 9);
    const provider = makeProvider(fake);

    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({ id: "receive-topup-1", bankInfo: { bankName: "GTBank", accountNumber: "0123456789", accountName: "SourceFi Wallet" } });
      })
    );

    const result = await provider.initiateTopup(9, 500_000, "idem-1");

    expect(result.status).toBe("processing");
    expect(result.reference).toBe("receive-topup-1");
    expect(result.paymentInstructions).toEqual({ bankName: "GTBank", accountNumber: "0123456789", accountName: "SourceFi Wallet" });

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

  it("the same idempotencyKey always gets the same sequenceId, a different key gets a different one", async () => {
    const fake = new FakeSupabase();
    seedKycBuyer(fake, 9);
    const provider = makeProvider(fake);

    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ id: "receive-1" });
      })
    );

    await provider.initiateTopup(9, 500_000_00, "attempt-a");
    await provider.initiateTopup(9, 500_000_00, "attempt-a"); // a retry of the SAME logical attempt
    await provider.initiateTopup(9, 500_000_00, "attempt-b");

    const seqIds = bodies.map((b) => b.sequenceId);
    expect(seqIds[0]).toBe(seqIds[1]); // same key, same sequenceId
    expect(seqIds[0]).not.toBe(seqIds[2]); // different key, different sequenceId
  });

  it("throws YellowCardApiError on a non-OK response, doesn't fabricate a result", async () => {
    const fake = new FakeSupabase();
    seedKycBuyer(fake, 9);
    const provider = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: "INVALID_REQUEST", message: "bad" }, 400)));

    await expect(provider.initiateTopup(9, 500_000_00, "idem-1")).rejects.toThrow(YellowCardApiError);
  });
});

describe("YellowCardWalletTopupProvider.checkAndReportTopupStatus", () => {
  it("returns false for a receive id it has no wallet_transactions row for at all (not a top-up this class knows about)", async () => {
    const fake = new FakeSupabase();
    const provider = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn());

    expect(await provider.checkAndReportTopupStatus("unknown-ref")).toBe(false);
  });

  it("still pending: leaves the row untouched, returns false, credits nothing", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { user_id: 1, type: "topup", amount_minor: 500_000_00, order_id: null, provider_reference: "ref-pending", status: "processing" },
    ]);
    const provider = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "pending" })));

    expect(await provider.checkAndReportTopupStatus("ref-pending")).toBe(false);
    expect(fake.getRows("buyer_wallets")).toHaveLength(0);
  });

  it("confirmed: credits the wallet and marks the transaction confirmed", async () => {
    const fake = new FakeSupabase();
    wireWalletRpcs(fake);
    fake.seed("wallet_transactions", [
      { user_id: 1, type: "topup", amount_minor: 500_000_00, order_id: null, provider_reference: "ref-ok", status: "processing" },
    ]);
    const provider = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "complete" })));

    expect(await provider.checkAndReportTopupStatus("ref-ok")).toBe(true);
    const wallet = fake.getRows("buyer_wallets").find((w) => w.user_id === 1);
    expect(wallet?.balance_minor).toBe(500_000_00);
    const txn = fake.getRows("wallet_transactions").find((t) => t.provider_reference === "ref-ok")!;
    expect(txn.status).toBe("confirmed");
  });

  it("failed: marks the transaction failed, credits nothing", async () => {
    const fake = new FakeSupabase();
    fake.seed("wallet_transactions", [
      { user_id: 1, type: "topup", amount_minor: 500_000_00, order_id: null, provider_reference: "ref-failed", status: "processing" },
    ]);
    const provider = makeProvider(fake);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "expired" })));

    expect(await provider.checkAndReportTopupStatus("ref-failed")).toBe(true);
    expect(fake.getRows("buyer_wallets")).toHaveLength(0);
    const txn = fake.getRows("wallet_transactions").find((t) => t.provider_reference === "ref-failed")!;
    expect(txn.status).toBe("failed");
  });
});
