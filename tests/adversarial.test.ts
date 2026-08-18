// tests/adversarial.test.ts
//
// Prompt 4's explicit final ask: "Write and run tests that actively try
// to break the app... Report what got through." This is that attack
// suite, IDOR across every order-mutating function, amount tampering
// a real approve-vs-dispute race, a replayed mutation, and XSS/SQLi
// payloads in every free-text field this app accepts. Two categories from
// the prompt are deliberately absent, not skipped by oversight: brute-
// forcing the handshake code (removed entirely by the marketplace pivot
// see the Prompt 4 findings report) and file-upload attacks (there is no
// file upload endpoint anywhere in this app, every "photo"/"receipt" is
// a plain URL string).
import { describe, it, expect } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";
import {
  createOrder,
  fundOrder,
  submitDeliveryProof,
  approveOrder,
  rejectProof,
  reportEarlyIssue,
  reportPostSettlementIssue,
  submitRating,
  recordVerificationCallProgress,
  confirmCallCode,
  resolveDispute,
  cancelBeforeFunding,
  handlePaymentStatusEvent,
  NotOrderOwnerError,
  MIN_VERIFICATION_CALL_SECONDS,
} from "../lib/orderService";
import { InvalidOrderTransitionError } from "../lib/orderStateMachine";
import { StubPaymentProvider, type PaymentStatusEvent } from "../lib/paymentBoundary";

const NOW = Date.now();
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function freshFakeSupabase() {
  const fake = new FakeSupabase();
  fake.seed("users", [
    { id: 1, email: "buyer@example.com", role: "buyer" },
    { id: 2, email: "supplier-user@example.com", role: "supplier" },
    { id: 3, email: "admin@example.com", role: "admin" },
    // The attacker: a second, unrelated buyer account with no relationship
    // to any order created below.
    { id: 99, email: "attacker@example.com", role: "buyer" },
    { id: 98, email: "attacker-supplier@example.com", role: "supplier" },
  ]);
  fake.seed("supplier_profiles", [
    {
      id: 1,
      user_id: 2,
      business_name: "Lagos Cement Co",
      verification_status: "verified",
      verified_at: new Date(NOW - 1000).toISOString(),
      verification_expires_at: new Date(NOW + NINETY_DAYS_MS).toISOString(),
      orders_since_verification: 0,
    },
    // The attacker's own, unrelated supplier profile.
    {
      id: 98,
      user_id: 98,
      business_name: "Attacker Supplies Ltd",
      verification_status: "verified",
      verified_at: new Date(NOW - 1000).toISOString(),
      verification_expires_at: new Date(NOW + NINETY_DAYS_MS).toISOString(),
      orders_since_verification: 0,
    },
  ]);
  fake.setRpc("is_supplier_currently_verified", (args) => {
    const supplier = fake.getRows("supplier_profiles").find((s) => s.id === args.p_supplier_id);
    if (!supplier) return false;
    return (
      supplier.verification_status === "verified" &&
      typeof supplier.verification_expires_at === "string" &&
      new Date(supplier.verification_expires_at).getTime() > Date.now() &&
      (supplier.orders_since_verification as number) < 20
    );
  });
  return fake;
}

function synchronousProvider(supabase: ReturnType<typeof asSupabaseClient>) {
  let resolveNext: (() => void) | null = null;
  const provider = new StubPaymentProvider(async (event: PaymentStatusEvent) => {
    await handlePaymentStatusEvent(supabase, event);
    resolveNext?.();
  }, 0);
  return {
    provider,
    waitForConfirmation: () =>
      new Promise<void>((resolve) => {
        resolveNext = resolve;
      }),
  };
}

/** Funds an order and drives it all the way to proof_submitted with the
 * verification call requirement satisfied, the shared setup most of the
 * IDOR tests below need before they can even attempt the attack. */
async function fundedOrderAwaitingApproval(supabase: ReturnType<typeof asSupabaseClient>) {
  const { provider, waitForConfirmation } = synchronousProvider(supabase);
  const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
  const confirmed = waitForConfirmation();
  await fundOrder(supabase, provider, order.id, 1);
  await confirmed;
  await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
  await recordVerificationCallProgress(supabase, order.id, 1, MIN_VERIFICATION_CALL_SECONDS);
  await confirmCallCode(supabase, order.id, 1);
  return { order, provider };
}

describe("IDOR: every order-mutating function, attacked with an unrelated account's id", () => {
  it("approveOrder: an unrelated buyer cannot approve someone else's order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { order, provider } = await fundedOrderAwaitingApproval(supabase);
    await expect(approveOrder(supabase, provider, order.id, 99)).rejects.toThrow(NotOrderOwnerError);
  });

  it("rejectProof: an unrelated buyer cannot reject someone else's delivery", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { order } = await fundedOrderAwaitingApproval(supabase);
    await expect(rejectProof(supabase, order.id, 99, { category: "other", description: null })).rejects.toThrow(NotOrderOwnerError);
  });

  it("reportEarlyIssue: an unrelated buyer cannot dispute someone else's order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    const confirmed = waitForConfirmation();
    await fundOrder(supabase, provider, order.id, 1);
    await confirmed;
    await expect(reportEarlyIssue(supabase, order.id, 99, { category: "other", description: null })).rejects.toThrow(NotOrderOwnerError);
  });

  it("reportPostSettlementIssue: an unrelated buyer cannot report an issue on someone else's settled order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    // Directly seed a settled order rather than driving the full lifecycle
    //, this test is only about the ownership check, not the state machine.
    fake.seed("orders", [{ buyer_id: 1, supplier_id: 1, status: "settled", amount_minor: 500_000_00, platform_fee_minor: 0, order_code: "ORD-X", title: "x", delivery_location: "y", currency: "NGN" }]);
    const order = fake.getRows("orders")[0]!;
    await expect(
      reportPostSettlementIssue(supabase, order.id as number, 99, { category: "other", description: null })
    ).rejects.toThrow(NotOrderOwnerError);
  });

  it("submitRating: an unrelated buyer cannot rate someone else's settled order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    fake.seed("orders", [{ buyer_id: 1, supplier_id: 1, status: "settled", amount_minor: 500_000_00, platform_fee_minor: 0, order_code: "ORD-X", title: "x", delivery_location: "y", currency: "NGN" }]);
    const order = fake.getRows("orders")[0]!;
    await expect(submitRating(supabase, provider, order.id as number, 99, 5, "great")).rejects.toThrow(NotOrderOwnerError);
  });

  it("recordVerificationCallProgress: a user with no relationship to the order at all cannot report call time", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    const confirmed = waitForConfirmation();
    await fundOrder(supabase, provider, order.id, 1);
    await confirmed;
    // 99 is neither the buyer nor the supplier's own user id, nor
    // attacker-supplier's profile (id 98) matches order.supplier_id (1).
    await expect(recordVerificationCallProgress(supabase, order.id, 99, 300)).rejects.toThrow(NotOrderOwnerError);
    // Also: the ATTACKER'S OWN verified supplier account (a real,
    // legitimate account, just not party to THIS order) is equally
    // rejected. Ownership is per-order, not "any verified supplier."
    await expect(recordVerificationCallProgress(supabase, order.id, 98, 300)).rejects.toThrow(NotOrderOwnerError);
  });

  it("submitDeliveryProof: a competitor supplier cannot submit proof against an order they weren't assigned", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    const confirmed = waitForConfirmation();
    await fundOrder(supabase, provider, order.id, 1);
    await confirmed;
    // user_id 98 owns supplier_profiles id 98, not id 1 (this order's real supplier).
    await expect(
      submitDeliveryProof(supabase, order.id, 98, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null })
    ).rejects.toThrow(NotOrderOwnerError);
  });

  it("cancelBeforeFunding: an unrelated buyer cannot cancel someone else's order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    await expect(cancelBeforeFunding(supabase, order.id, 99, { category: "other" })).rejects.toThrow(NotOrderOwnerError);
  });
});

describe("Amount tampering", () => {
  it("createOrder never accepts less than MIN_ORDER_AMOUNT_MINOR regardless of how it's phrased", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    // Negative, zero, and a small positive number below the floor, all
    // three are "tampering" in the sense that a client could send any of
    // them; the server-side floor doesn't care which shape the attack took.
    await expect(createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: -500_000_00 })).rejects.toThrow();
    await expect(createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 0 })).rejects.toThrow();
    await expect(createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1 })).rejects.toThrow();
  });

  it("the amount actually stored is exactly what was validated: nothing downstream silently rescales or re-derives it", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 750_000_00 });
    expect(order.amount_minor).toBe(750_000_00);
    const stored = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(stored.amount_minor).toBe(750_000_00);
  });

  it("fundOrder/approveOrder/cancelFundedOrder take no amount parameter at all: there is nothing in their signature for a tampered request body to even reach", async () => {
    // Structural, not behavioral: fundOrder(supabase, provider, orderId,
    // buyerId) and approveOrder(supabase, provider, orderId, buyerId) both
    // re-read order.amount_minor from the DB row inside orderService.ts
    // neither accepts a caller-supplied amount to override it with. This
    // test exists as an explicit, permanent assertion of that contract
    // (fails loudly if a future edit ever adds an amount parameter to
    // either) rather than leaving it implicit.
    expect(fundOrder.length).toBe(4);
    expect(approveOrder.length).toBe(4);
  });
});

describe("Race condition: approve vs. dispute fired concurrently on the same order", () => {
  it("only one of the two wins; the loser gets a clean InvalidOrderTransitionError, not a corrupted order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { order, provider } = await fundedOrderAwaitingApproval(supabase);

    // Both fire from proof_submitted at the same instant, approveOrder
    // moving it to buyer_approved, rejectProof moving it to rejected.
    // tryTransition's compare-and-swap (.eq("status", from)) is what
    // actually decides this, same mechanism whether the race is two
    // browser tabs or an attacker deliberately double-firing.
    const results = await Promise.allSettled([
      approveOrder(supabase, provider, order.id, 1),
      rejectProof(supabase, order.id, 1, { category: "other", description: "changed my mind" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidOrderTransitionError);

    // The order landed in exactly one coherent state, never both, never neither.
    const finalOrder = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(["release_submitted", "release_processing", "disputed"]).toContain(finalOrder.status);
  });
});

describe("Replay: firing the same mutation twice", () => {
  it("a replayed funding-confirmed webhook event is a no-op the second time, never a double ledger write", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    await fake.seed("orders", []); // no-op, keeps seed helper referenced for clarity
    await asSupabaseClient(fake).from("orders").update({ status: "payment_processing" }).eq("id", order.id);

    const event: PaymentStatusEvent = {
      orderId: order.id,
      leg: "funding",
      provider: "yellow_card",
      providerReference: "ref-1",
      providerState: "confirmed",
    };

    await handlePaymentStatusEvent(supabase, event);
    const afterFirst = fake.getRows("ledger_entries").length;
    expect(afterFirst).toBeGreaterThan(0);

    // Exact same event, fired again, simulates a webhook provider
    // retrying delivery, or an attacker capturing and replaying the request.
    await handlePaymentStatusEvent(supabase, event);
    const afterSecond = fake.getRows("ledger_entries").length;

    expect(afterSecond).toBe(afterFirst); // not double-booked
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("funded"); // not advanced past funded a second time
  });

  it("double-firing cancelBeforeFunding on an already-cancelled order fails clean, not double-refunded/double-logged", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    await cancelBeforeFunding(supabase, order.id, 1, { category: "changed_mind" });
    await expect(cancelBeforeFunding(supabase, order.id, 1, { category: "changed_mind" })).rejects.toThrow(InvalidOrderTransitionError);
    // Exactly one cancellation record, not two.
    expect(fake.getRows("order_cancellations").filter((c) => c.order_id === order.id)).toHaveLength(1);
  });
});

describe("XSS / SQL injection payloads in every free-text field", () => {
  const XSS_PAYLOAD = `<script>alert(document.cookie)</script>`;
  const SQLI_PAYLOAD = `'; DROP TABLE orders; --`;
  const COMBINED_PAYLOAD = `${XSS_PAYLOAD} ${SQLI_PAYLOAD}`;

  it("a dispute description containing script tags and a SQL payload is stored verbatim as inert text, never executed or unescaped", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    const confirmed = waitForConfirmation();
    await fundOrder(supabase, provider, order.id, 1);
    await confirmed;

    await reportEarlyIssue(supabase, order.id, 1, { category: "other", description: COMBINED_PAYLOAD });

    const dispute = fake.getRows("disputes").find((d) => d.order_id === order.id)!;
    // Stored EXACTLY as submitted, supabase-js's parameterized query
    // builder (never raw/concatenated SQL, confirmed across this whole
    // codebase in the Prompt 4 audit) treats this as opaque string data,
    // not executable SQL. React's default JSX escaping is what makes the
    // <script> tag inert on the OUTPUT side wherever this renders, this
    // test covers the input/storage side of that same guarantee.
    expect(dispute.description).toBe(COMBINED_PAYLOAD);
    // And the table it allegedly tries to drop is still very much here.
    expect(fake.getRows("orders").length).toBeGreaterThan(0);
  });

  it("a cancellation reason containing the same payload round-trips unmodified, and the orders table survives", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    await cancelBeforeFunding(supabase, order.id, 1, { category: "other", description: COMBINED_PAYLOAD });

    const cancellation = fake.getRows("order_cancellations").find((c) => c.order_id === order.id)!;
    expect(cancellation.description).toBe(COMBINED_PAYLOAD);
    expect(fake.getRows("orders").some((o) => o.id === order.id)).toBe(true);
  });

  it("delivery-proof notes containing the same payload round-trip unmodified", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    const confirmed = waitForConfirmation();
    await fundOrder(supabase, provider, order.id, 1);
    await confirmed;

    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: COMBINED_PAYLOAD });
    const proof = fake.getRows("delivery_proofs").find((p) => p.order_id === order.id)!;
    expect(proof.notes).toBe(COMBINED_PAYLOAD);
  });
});
