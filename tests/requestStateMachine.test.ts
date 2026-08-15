// tests/requestStateMachine.test.ts
//
// Stage 5's explicit ask: "no free-form status writes from the client." A
// route can only advance a request from A to B if this module says so —
// this proves the map itself is right, not just that some route happens
// to call it correctly.
import { describe, it, expect } from "vitest";
import { assertTransition, InvalidTransitionError } from "../lib/requestStateMachine";
import type { RequestStatus } from "../lib/types";

const ALL_STATUSES: RequestStatus[] = [
  "open",
  "claimed",
  "escrow",
  "verified",
  "escrow_released",
  "disputed",
  "cancelled",
  "expired",
];

describe("assertTransition — the happy path the app actually drives", () => {
  it("allows every transition the current escrow route relies on", () => {
    expect(() => assertTransition("open", "claimed")).not.toThrow();
    expect(() => assertTransition("claimed", "escrow")).not.toThrow();
    expect(() => assertTransition("escrow", "verified")).not.toThrow();
    expect(() => assertTransition("verified", "escrow_released")).not.toThrow();
  });
});

describe("assertTransition — terminal states have no way out", () => {
  it.each(["escrow_released", "disputed", "cancelled", "expired"] as RequestStatus[])(
    "rejects every transition out of terminal state %s",
    (from) => {
      for (const to of ALL_STATUSES) {
        expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
  );
});

describe("assertTransition — no skipping a step", () => {
  it("rejects going straight from open to verified", () => {
    expect(() => assertTransition("open", "verified")).toThrow(InvalidTransitionError);
  });

  it("rejects going straight from open to escrow_released", () => {
    expect(() => assertTransition("open", "escrow_released")).toThrow(InvalidTransitionError);
  });

  it("rejects moving backwards from escrow to claimed", () => {
    expect(() => assertTransition("escrow", "claimed")).toThrow(InvalidTransitionError);
  });

  it("rejects a no-op transition (same state to itself)", () => {
    expect(() => assertTransition("open", "open")).toThrow(InvalidTransitionError);
  });
});

describe("assertTransition — error identifies what was attempted", () => {
  it("names both the from and to state in the thrown error", () => {
    try {
      assertTransition("escrow_released", "open");
      throw new Error("expected assertTransition to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect((err as Error).message).toContain("escrow_released");
      expect((err as Error).message).toContain("open");
    }
  });
});
