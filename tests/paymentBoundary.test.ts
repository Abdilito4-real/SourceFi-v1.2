// tests/paymentBoundary.test.ts
//
// StubPaymentProvider exists so routes can be built and tested against
// the design doc's Section E boundary before Yellow Card/Circle
// credentials exist — this proves the stub actually honors that
// contract's shape (always reports "processing" first, txHash only ever
// present on the Circle leg, ratings never auto-confirm).
import { describe, it, expect, vi } from "vitest";
import { StubPaymentProvider, type PaymentStatusEvent } from "../lib/paymentBoundary";

function collectEvents() {
  const events: PaymentStatusEvent[] = [];
  const onStatusUpdate = vi.fn((event: PaymentStatusEvent) => {
    events.push(event);
  });
  return { events, onStatusUpdate };
}

describe("StubPaymentProvider — initiateOrderFunding", () => {
  it("returns 'processing' immediately, never 'confirmed' synchronously", async () => {
    const { onStatusUpdate } = collectEvents();
    const provider = new StubPaymentProvider(onStatusUpdate, 5);
    const result = await provider.initiateOrderFunding(1);
    expect(result.status).toBe("processing");
    expect(result.paymentReference).toBeTruthy();
  });

  it("eventually reports a confirmed funding event via the callback", async () => {
    const { events, onStatusUpdate } = collectEvents();
    const provider = new StubPaymentProvider(onStatusUpdate, 5);
    await provider.initiateOrderFunding(7);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(events).toHaveLength(1);
    const event = events[0]!; // length just asserted above
    expect(event.orderId).toBe(7);
    expect(event.leg).toBe("funding");
    expect(event.provider).toBe("yellow_card");
    // The funding leg's confirmation comes from Yellow Card, not Circle —
    // no on-chain txHash belongs on this event.
    expect(event.txHash).toBeUndefined();
  });
});

describe("StubPaymentProvider — initiateEscrowRelease (the Circle leg)", () => {
  it("only the release leg ever carries a txHash, and only once confirmed", async () => {
    const { events, onStatusUpdate } = collectEvents();
    const provider = new StubPaymentProvider(onStatusUpdate, 5);
    const result = await provider.initiateEscrowRelease(3);
    expect(result.status).toBe("processing");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toHaveLength(1);
    const event = events[0]!; // length just asserted above
    expect(event.leg).toBe("release");
    expect(event.provider).toBe("circle");
    expect(event.providerState).toBe("CONFIRMED");
    expect(event.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("StubPaymentProvider — submitRatingOnChain", () => {
  it("never returns 'confirmed' or a txHash (Open Question 10 — no real contract wired yet)", async () => {
    const { onStatusUpdate } = collectEvents();
    const provider = new StubPaymentProvider(onStatusUpdate, 5);
    const result = await provider.submitRatingOnChain(1, 5, 5, "Great supplier");
    expect(result.status).toBe("submitted");
    expect(result.txHash).toBeNull();
  });
});

describe("StubPaymentProvider — reference uniqueness", () => {
  it("never issues the same reference twice across calls", async () => {
    const { onStatusUpdate } = collectEvents();
    const provider = new StubPaymentProvider(onStatusUpdate, 5);
    const a = await provider.initiateOrderFunding(1);
    const b = await provider.initiateOrderFunding(1);
    expect(a.paymentReference).not.toBe(b.paymentReference);
  });
});
