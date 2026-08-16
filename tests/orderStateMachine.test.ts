// tests/orderStateMachine.test.ts
//
// Same discipline as tests/requestStateMachine.test.ts: proves the
// transition MAP is right, not just that some route happens to call it
// correctly. The two tests under "the Circle finding" are the actual
// regression tests for the bug docs/marketplace-payments-design.md
// Section D.0 verified against the installed Circle SDK, buyer approval
// and a confirmed on-chain release must never be reachable in one step.
import { describe, it, expect } from "vitest";
import { assertTransition, InvalidOrderTransitionError, TERMINAL_ORDER_STATUSES } from "../lib/orderStateMachine";
import type { OrderStatus } from "../lib/types";

const ALL_STATUSES: OrderStatus[] = [
  "pending_payment",
  "payment_processing",
  "payment_failed",
  "converting",
  "escrow_depositing",
  "funded",
  "fulfilling",
  "proof_submitted",
  "buyer_approved",
  "release_submitted",
  "release_processing",
  "escrow_released",
  "settlement_processing",
  "settled",
  "rejected",
  "disputed",
  "refund_processing",
  "refunded",
  "cancelled",
  "expired",
];

describe("assertTransition: the happy path, full order lifecycle", () => {
  it("allows every transition from order creation through settlement", () => {
    expect(() => assertTransition("pending_payment", "payment_processing")).not.toThrow();
    expect(() => assertTransition("payment_processing", "converting")).not.toThrow();
    expect(() => assertTransition("converting", "escrow_depositing")).not.toThrow();
    expect(() => assertTransition("escrow_depositing", "funded")).not.toThrow();
    expect(() => assertTransition("funded", "proof_submitted")).not.toThrow();
    expect(() => assertTransition("proof_submitted", "buyer_approved")).not.toThrow();
    expect(() => assertTransition("buyer_approved", "release_submitted")).not.toThrow();
    expect(() => assertTransition("release_submitted", "release_processing")).not.toThrow();
    expect(() => assertTransition("release_processing", "escrow_released")).not.toThrow();
    expect(() => assertTransition("escrow_released", "settlement_processing")).not.toThrow();
    expect(() => assertTransition("settlement_processing", "settled")).not.toThrow();
  });

  it("allows the optional `fulfilling` waypoint between funded and proof_submitted", () => {
    expect(() => assertTransition("funded", "fulfilling")).not.toThrow();
    expect(() => assertTransition("fulfilling", "proof_submitted")).not.toThrow();
  });

  it("allows a buyer to dispute before any delivery proof exists, from either funded or fulfilling", () => {
    expect(() => assertTransition("funded", "disputed")).not.toThrow();
    expect(() => assertTransition("fulfilling", "disputed")).not.toThrow();
  });

  it("allows a failed payment to be retried", () => {
    expect(() => assertTransition("payment_processing", "payment_failed")).not.toThrow();
    expect(() => assertTransition("payment_failed", "payment_processing")).not.toThrow();
  });
});

describe("assertTransition: the Circle finding (Section D.0), enforced structurally", () => {
  it("rejects buyer_approved -> escrow_released directly (the exact bug being fixed)", () => {
    expect(() => assertTransition("buyer_approved", "escrow_released")).toThrow(InvalidOrderTransitionError);
  });

  it("rejects buyer_approved -> release_processing (skipping the submitted step)", () => {
    expect(() => assertTransition("buyer_approved", "release_processing")).toThrow(InvalidOrderTransitionError);
  });

  it("rejects release_submitted -> escrow_released directly (skipping the processing/confirmation step)", () => {
    expect(() => assertTransition("release_submitted", "escrow_released")).toThrow(InvalidOrderTransitionError);
  });

  it("rejects escrow_released -> settled directly (skipping the NGN settlement leg)", () => {
    expect(() => assertTransition("escrow_released", "settled")).toThrow(InvalidOrderTransitionError);
  });
});

describe("assertTransition: settled vs. a post-settlement dispute (Section D.1 nuance)", () => {
  it("rejects settled -> disputed as an order status transition", () => {
    // A post-settlement report is a NEW disputes row (dispute_type =
    // 'post_settlement_report'); it must never mutate orders.status.
    // If this test starts failing because someone added the edge back
    // to TRANSITIONS, that's the regression, not the test.
    expect(() => assertTransition("settled", "disputed")).toThrow(InvalidOrderTransitionError);
  });

  it("settled has no legal outgoing transition at all", () => {
    for (const to of ALL_STATUSES) {
      expect(() => assertTransition("settled", to)).toThrow(InvalidOrderTransitionError);
    }
  });
});

describe("assertTransition: terminal states have no way out", () => {
  it.each(["settled", "refunded", "cancelled", "expired"] as OrderStatus[])(
    "rejects every transition out of terminal state %s",
    (from) => {
      for (const to of ALL_STATUSES) {
        expect(() => assertTransition(from, to)).toThrow(InvalidOrderTransitionError);
      }
    }
  );

  it("TERMINAL_ORDER_STATUSES matches exactly the four true terminal states", () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(["cancelled", "expired", "refunded", "settled"].sort());
  });
});

describe("assertTransition: disputes route to a real resolution, not a dead end", () => {
  it("allows disputed -> refund_processing (admin rules for buyer)", () => {
    expect(() => assertTransition("disputed", "refund_processing")).not.toThrow();
  });

  it("allows disputed -> release_submitted (admin rules for supplier, release proceeds normally)", () => {
    expect(() => assertTransition("disputed", "release_submitted")).not.toThrow();
  });

  it("rejects disputed -> settled directly (a ruling must go through release or refund first)", () => {
    expect(() => assertTransition("disputed", "settled")).toThrow(InvalidOrderTransitionError);
  });

  it("a rejected proof always routes through disputed, never straight back to buyer_approved", () => {
    expect(() => assertTransition("rejected", "disputed")).not.toThrow();
    expect(() => assertTransition("rejected", "buyer_approved")).toThrow(InvalidOrderTransitionError);
  });
});

describe("assertTransition: no skipping a step, no moving backwards, no no-ops", () => {
  it("rejects going straight from pending_payment to funded", () => {
    expect(() => assertTransition("pending_payment", "funded")).toThrow(InvalidOrderTransitionError);
  });

  it("rejects moving backwards from funded to converting", () => {
    expect(() => assertTransition("funded", "converting")).toThrow(InvalidOrderTransitionError);
  });

  it("rejects a no-op transition (same state to itself)", () => {
    expect(() => assertTransition("funded", "funded")).toThrow(InvalidOrderTransitionError);
  });
});

describe("assertTransition: error identifies what was attempted", () => {
  it("names both the from and to state in the thrown error", () => {
    try {
      assertTransition("settled", "pending_payment");
      throw new Error("expected assertTransition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidOrderTransitionError);
      expect((err as Error).message).toContain("settled");
      expect((err as Error).message).toContain("pending_payment");
    }
  });
});
