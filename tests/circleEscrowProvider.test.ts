// tests/circleEscrowProvider.test.ts
//
// Covers CircleEscrowProvider.reportWebhookNotification/reportOutcome,
// the money-moving logic added when the webhook payload shape was
// confirmed against Circle's own docs (see app/api/webhooks/circle's
// header comment): reporting directly from a verified notification
// body's state/txHash/errorReason instead of re-fetching via
// client.getTransaction(), with a fallback to that re-fetch when the
// body doesn't carry a usable state. No network call happens in this
// file, the SDK client constructs without one (confirmed locally), and
// the fallback path stubs client.getTransaction directly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";
import { CircleEscrowProvider, MissingYellowCardConfigError } from "../lib/circleEscrowProvider";
import { MissingSupplierPayoutProfileError } from "../lib/yellowCardProvider";
import type { PaymentStatusEvent } from "../lib/paymentBoundary";

function makeProvider() {
  const events: PaymentStatusEvent[] = [];
  const onStatusUpdate = vi.fn((event: PaymentStatusEvent) => {
    events.push(event);
  });
  const provider = new CircleEscrowProvider(
    asSupabaseClient(new FakeSupabase()),
    onStatusUpdate,
    {
      apiKey: "test-key",
      entitySecret: "00".repeat(32),
      escrowWalletId: "test-wallet",
    },
    null // this file only covers reportWebhookNotification/reportOutcome, not initiateEscrowRelease
  );
  return { provider, events };
}

describe("CircleEscrowProvider.reportWebhookNotification: reports directly from the body", () => {
  it("a CONFIRMED notification reports the release confirmed, with its txHash", async () => {
    const { provider, events } = makeProvider();
    const reported = await provider.reportWebhookNotification(7, "txn-1", {
      id: "txn-1",
      state: "CONFIRMED",
      txHash: "0xabc123",
    });
    expect(reported).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ orderId: 7, leg: "release", provider: "circle", providerReference: "txn-1", providerState: "CONFIRMED", txHash: "0xabc123" });
  });

  it("a COMPLETE notification also reports confirmed (both are terminal-success states)", async () => {
    const { provider, events } = makeProvider();
    const reported = await provider.reportWebhookNotification(9, "txn-2", { id: "txn-2", state: "COMPLETE", txHash: "0xdef456" });
    expect(reported).toBe(true);
    expect(events[0]?.providerState).toBe("COMPLETE");
  });

  it("a FAILED notification reports true (handled) but never calls onStatusUpdate, no fabricated success", async () => {
    const { provider, events } = makeProvider();
    const reported = await provider.reportWebhookNotification(3, "txn-3", { id: "txn-3", state: "FAILED", errorReason: "INSUFFICIENT_FUNDS" });
    expect(reported).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("a pending notification (QUEUED/SENT) returns false, nothing to report yet", async () => {
    const { provider, events } = makeProvider();
    const reported = await provider.reportWebhookNotification(4, "txn-4", { id: "txn-4", state: "QUEUED" });
    expect(reported).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("only trusts state/txHash/errorReason from the body, ignores any other injected field", async () => {
    const { provider, events } = makeProvider();
    // A malicious or malformed body can't smuggle extra fields into the
    // reported PaymentStatusEvent, only the fields resolveCircleTransactionOutcome
    // actually reads are used.
    await provider.reportWebhookNotification(1, "txn-5", {
      id: "txn-5",
      state: "CONFIRMED",
      txHash: "0x1",
      amountMinor: 999999999, // not a real field on the notification, must be ignored
    });
    expect(events[0]).not.toHaveProperty("amountMinor");
  });
});

describe("CircleEscrowProvider.reportWebhookNotification: falls back to a real re-fetch", () => {
  it("when the body has no usable `state`, falls back to checkAndReportReleaseStatus", async () => {
    const { provider, events } = makeProvider();
    const fakeGetTransaction = vi.fn().mockResolvedValue({ data: { transaction: { state: "CONFIRMED", txHash: "0xrefetched" } } });
    // client is private; this is the one place a test reaches past that
    // to stub the network boundary, same posture other tests in this
    // suite take toward mocking an external SDK client.
    (provider as unknown as { client: { getTransaction: typeof fakeGetTransaction } }).client.getTransaction = fakeGetTransaction;

    const reported = await provider.reportWebhookNotification(2, "txn-6", { id: "txn-6" /* no state field */ });
    expect(reported).toBe(true);
    expect(fakeGetTransaction).toHaveBeenCalledWith({ id: "txn-6" });
    expect(events[0]?.txHash).toBe("0xrefetched");
  });

  it("falls back the same way when the notification argument isn't an object at all", async () => {
    const { provider } = makeProvider();
    const fakeGetTransaction = vi.fn().mockResolvedValue({ data: { transaction: { state: "QUEUED" } } });
    (provider as unknown as { client: { getTransaction: typeof fakeGetTransaction } }).client.getTransaction = fakeGetTransaction;

    const reported = await provider.reportWebhookNotification(2, "txn-7", null);
    expect(reported).toBe(false);
    expect(fakeGetTransaction).toHaveBeenCalledWith({ id: "txn-7" });
  });
});

const YC_CONFIG = { apiKey: "test-yc-key", secretKey: "test-yc-secret", environment: "sandbox" as const };

/** initiateEscrowRelease's real network surface: the Circle SDK client
 * (getWalletTokenBalance/createTransaction, stubbed directly by
 * reaching past the private `client` field, same posture the fallback
 * webhook test above already takes) and global fetch (fxRate.ts's live
 * rate lookup AND createSettlementSend's real Yellow Card call,
 * lib/yellowCardProvider.ts) — routed by URL so both are served from
 * one stub. */
function stubReleaseNetwork(provider: CircleEscrowProvider, opts: { sendId?: string; depositAddress?: string } = {}) {
  const createTransaction = vi.fn().mockResolvedValue({ data: { id: "circle-txn-1" } });
  const getWalletTokenBalance = vi.fn().mockResolvedValue({ data: { tokenBalances: [{ token: { symbol: "USDC", id: "usdc-token-id" }, amount: "1000000" }] } });
  (provider as unknown as { client: { createTransaction: typeof createTransaction; getWalletTokenBalance: typeof getWalletTokenBalance } }).client = {
    createTransaction,
    getWalletTokenBalance,
  } as never;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("open.er-api.com")) {
        return new Response(JSON.stringify({ rates: { NGN: 1600 } }), { status: 200 });
      }
      if (url.includes("/business/send")) {
        return new Response(
          JSON.stringify({ id: opts.sendId ?? "send-settlement-1", cryptoDepositAddress: opts.depositAddress ?? "0xYELLOWCARD_DEPOSIT" }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch() in this test: ${url} ${init?.method ?? ""}`);
    })
  );

  return { createTransaction, getWalletTokenBalance };
}

function seedReleasableOrder(fake: FakeSupabase) {
  fake.seed("orders", [{ id: 7, amount_minor: 500_000_00, platform_fee_minor: 20_000_00, supplier_id: 5 }]);
  fake.seed("supplier_profiles", [{ id: 5, user_id: 20, wallet_address: "0xSUPPLIER_OWN_WALLET_SHOULD_NOT_BE_USED" }]);
  fake.seed("supplier_payout_profiles", [
    { user_id: 20, bank_name: "GTBank", account_number: "0123456789", account_name: "Lagos Cement Co", bank_network_id: "yc-network-1" },
  ]);
}

describe("CircleEscrowProvider.initiateEscrowRelease: real settlement, not the supplier's own wallet", () => {
  beforeEach(() => {
    process.env.YELLOW_CARD_ESCROW_CRYPTO_NETWORK = "ETH";
  });
  afterEach(() => {
    delete process.env.YELLOW_CARD_ESCROW_CRYPTO_NETWORK;
  });

  it("throws MissingYellowCardConfigError when constructed without Yellow Card config, never calls Circle", async () => {
    const fake = new FakeSupabase();
    seedReleasableOrder(fake);
    const provider = new CircleEscrowProvider(
      asSupabaseClient(fake),
      vi.fn(),
      { apiKey: "k", entitySecret: "00".repeat(32), escrowWalletId: "w" },
      null
    );
    const { createTransaction } = stubReleaseNetwork(provider);

    await expect(provider.initiateEscrowRelease(7)).rejects.toThrow(MissingYellowCardConfigError);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("throws MissingSupplierPayoutProfileError when the supplier has no payout bank details on file, never calls Circle", async () => {
    const fake = new FakeSupabase();
    fake.seed("orders", [{ id: 7, amount_minor: 500_000_00, platform_fee_minor: 20_000_00, supplier_id: 5 }]);
    fake.seed("supplier_profiles", [{ id: 5, user_id: 20 }]);
    // no supplier_payout_profiles row
    const provider = new CircleEscrowProvider(
      asSupabaseClient(fake),
      vi.fn(),
      { apiKey: "k", entitySecret: "00".repeat(32), escrowWalletId: "w" },
      YC_CONFIG
    );
    const { createTransaction } = stubReleaseNetwork(provider);

    await expect(provider.initiateEscrowRelease(7)).rejects.toThrow(MissingSupplierPayoutProfileError);
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("sends the USDC to Yellow Card's returned deposit address, NOT the supplier's own wallet_address, and records the settlement payment_event", async () => {
    const fake = new FakeSupabase();
    seedReleasableOrder(fake);
    const provider = new CircleEscrowProvider(
      asSupabaseClient(fake),
      vi.fn(),
      { apiKey: "k", entitySecret: "00".repeat(32), escrowWalletId: "w" },
      YC_CONFIG
    );
    const { createTransaction } = stubReleaseNetwork(provider, { sendId: "send-42", depositAddress: "0xREAL_DEPOSIT_ADDR" });

    const result = await provider.initiateEscrowRelease(7);

    expect(result.status).toBe("processing");
    expect(createTransaction).toHaveBeenCalledTimes(1);
    const call = createTransaction.mock.calls[0]![0] as { destinationAddress: string };
    expect(call.destinationAddress).toBe("0xREAL_DEPOSIT_ADDR");
    expect(call.destinationAddress).not.toBe("0xSUPPLIER_OWN_WALLET_SHOULD_NOT_BE_USED");

    const settlementEvent = fake.getRows("payment_events").find((e) => e.leg === "settlement");
    expect(settlementEvent).toBeTruthy();
    expect(settlementEvent!.provider_reference).toBe("send-42");
    expect(settlementEvent!.order_id).toBe(7);
  });
});
