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
import { describe, it, expect, vi } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";
import { CircleEscrowProvider } from "../lib/circleEscrowProvider";
import type { PaymentStatusEvent } from "../lib/paymentBoundary";

function makeProvider() {
  const events: PaymentStatusEvent[] = [];
  const onStatusUpdate = vi.fn((event: PaymentStatusEvent) => {
    events.push(event);
  });
  const provider = new CircleEscrowProvider(asSupabaseClient(new FakeSupabase()), onStatusUpdate, {
    apiKey: "test-key",
    entitySecret: "00".repeat(32),
    escrowWalletId: "test-wallet",
  });
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
