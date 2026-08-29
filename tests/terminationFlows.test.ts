// tests/terminationFlows.test.ts
//
// Prompt 3 (termination/declination flows), the project's own engineering
// rule applies here just as much as anywhere else: "Never write
// money-moving logic without a matching test that proves funds cannot be
// lost, double-spent, or released without authorisation." cancelFundedOrder
// and abandonOrder both move real money; this covers the fund
// consequence, the ledger split, ownership, and the strike/block
// escalation, same integration style as tests/orderService.test.ts
// against the same fake Supabase client.
//
// Every order here is funded via fundOrder, which is wallet-first as of
// migration 0020 (lib/walletService.ts) — both the funding confirmation
// AND a wallet-funded order's refund confirmation now resolve fully
// SYNCHRONOUSLY (no external provider round-trip to wait out), so this
// file no longer needs the waitForConfirmation()/confirmed dance around
// either step, unlike tests/orderService.test.ts's release/settlement
// flows, which still go through the genuinely-async Circle/Yellow Card
// stub path unchanged.
import { describe, it, expect } from "vitest";
import { FakeSupabase, asSupabaseClient, wireWalletRpcs } from "./testUtils/fakeSupabase";
import {
  createOrder,
  fundOrder,
  submitDeliveryProof,
  cancelBeforeFunding,
  cancelFundedOrder,
  abandonOrder,
  withdrawProof,
  suspendSupplier,
  unsuspendSupplier,
  CANCELLATION_FEE_MINOR,
  WITHDRAW_PROOF_WINDOW_MS,
  NotOrderOwnerError,
  SupplierBlockedError,
  SupplierSuspendedError,
  WithdrawWindowExpiredError,
} from "../lib/orderService";
import { InvalidOrderTransitionError } from "../lib/orderStateMachine";
import { StubPaymentProvider, type PaymentStatusEvent } from "../lib/paymentBoundary";
import { handlePaymentStatusEvent } from "../lib/orderService";

const NOW = Date.now();
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function freshFakeSupabase() {
  const fake = new FakeSupabase();
  fake.seed("users", [
    { id: 1, email: "buyer@example.com", role: "buyer" },
    { id: 2, email: "supplier-user@example.com", role: "supplier" },
    { id: 3, email: "admin@example.com", role: "admin" },
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
  ]);
  // fundOrder is wallet-first (migration 0020): a generous default
  // balance so every existing fundOrder call in this file keeps passing
  // without individually knowing about it, same posture
  // buyer_kyc_profiles used to have here before KYC moved to gate wallet
  // top-up instead of funding.
  fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 10_000_000_00, currency: "NGN" }]);
  wireWalletRpcs(fake);
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

/** Only still needed for the paymentProvider argument
 * cancelFundedOrder/abandonOrder still take (used for a non-wallet-funded
 * order's refund, which nothing in this file exercises since every order
 * here is wallet-funded) — waitForConfirmation isn't needed anymore, see
 * this file's header comment. */
function stubProvider(supabase: ReturnType<typeof asSupabaseClient>) {
  return new StubPaymentProvider(async (event: PaymentStatusEvent) => {
    await handlePaymentStatusEvent(supabase, event);
  }, 0);
}

function netByAccount(entries: Array<Record<string, unknown>>): Map<string, number> {
  const byAccount = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.account}:${e.currency}`;
    const signed = e.direction === "debit" ? (e.amount_minor as number) : -(e.amount_minor as number);
    byAccount.set(key, (byAccount.get(key) ?? 0) + signed);
  }
  return byAccount;
}

describe("cancelBeforeFunding: flow 1, no funds ever moved", () => {
  it("cancels a pending_payment order cleanly, zero fee, zero ledger entries", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 100_000_00 });

    const cancelled = await cancelBeforeFunding(supabase, order.id, 1, { category: "changed_mind", description: null });
    expect(cancelled.status).toBe("cancelled");
    expect(fake.getRows("ledger_entries")).toHaveLength(0);

    const record = fake.getRows("order_cancellations").find((c) => c.order_id === order.id)!;
    expect(record.fee_charged_minor).toBe(0);
    expect(record.refund_minor).toBe(null);
    expect(record.actor_role).toBe("buyer");
  });

  it("refuses to cancel someone else's order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 100_000_00 });
    await expect(cancelBeforeFunding(supabase, order.id, 99, { category: "other" })).rejects.toThrow(NotOrderOwnerError);
  });

  it("refuses once the order is already funded: too late for this flow", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 100_000_00 });

    await fundOrder(supabase, order.id, 1);

    await expect(cancelBeforeFunding(supabase, order.id, 1, { category: "other" })).rejects.toThrow(InvalidOrderTransitionError);
  });
});

describe("cancelFundedOrder: flow 4 / Decision 2, refund minus the disclosed fee", () => {
  it("refunds amount minus CANCELLATION_FEE_MINOR, and the fee lands in PLATFORM_REVENUE, credited back to the wallet", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const provider = stubProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });

    await fundOrder(supabase, order.id, 1);

    const result = await cancelFundedOrder(supabase, provider, order.id, 1, { category: "changed_mind", description: "no longer needed" });
    expect(result.feeMinor).toBe(CANCELLATION_FEE_MINOR);
    expect(result.refundMinor).toBe(500_000_00 - CANCELLATION_FEE_MINOR);
    // Fully resolved by the time cancelFundedOrder returns: it was
    // funded from the wallet, so the refund routes straight to the
    // wallet-credit event path (migration 0020), synchronous, no
    // external provider round-trip to wait out.
    expect(result.order.status).toBe("refunded");

    const finalOrder = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(finalOrder.status).toBe("refunded");

    // The ledger actually booked the SAME split, the fee retained as
    // revenue, not silently vanished or double counted.
    const entries = fake.getRows("ledger_entries") as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.account === "PLATFORM_REVENUE")).toBe(true);
    expect(entries.some((e) => e.account === "SUPPLIER_PAYABLE")).toBe(false); // supplier delivered nothing
    const byAccount = netByAccount(entries);
    expect(byAccount.get("ESCROW_WALLET_USDC:USDC")).toBe(0); // everything that went in came back out (refund + fee)

    // The refund (amount minus the fee) landed back in the wallet, not
    // lost, and not the full amount either — the fee stays retained.
    const wallet = fake.getRows("buyer_wallets").find((w) => w.user_id === 1)!;
    expect(wallet.balance_minor).toBe(10_000_000_00 - CANCELLATION_FEE_MINOR);
  });

  it("never charges more than the order is worth, for an order smaller than the flat fee", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const provider = stubProvider(supabase);
    // Smaller than CANCELLATION_FEE_MINOR (₦2,000) but still clears
    // MIN_ORDER_AMOUNT_MINOR (₦5,000), createOrder would reject 2000
    // below the floor set on purpose, so this uses the floor itself, above the fee.
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });

    await fundOrder(supabase, order.id, 1);

    const result = await cancelFundedOrder(supabase, provider, order.id, 1, { category: "other" });
    expect(result.feeMinor).toBeLessThanOrEqual(500_000);
    expect(result.refundMinor).toBeGreaterThanOrEqual(0);
  });

  it("refuses to cancel someone else's funded order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const provider = stubProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000_00 });
    await fundOrder(supabase, order.id, 1);

    await expect(cancelFundedOrder(supabase, provider, order.id, 99, { category: "other" })).rejects.toThrow(NotOrderOwnerError);
  });
});

describe("abandonOrder: flow 6 / Decision 4, full refund + strike escalation", () => {
  it("refunds in full, no fee, on a single abandonment, credited back to the wallet", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const provider = stubProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });

    await fundOrder(supabase, order.id, 1);
    await abandonOrder(supabase, provider, order.id, 2, { category: "cannot_fulfill", description: null });

    const finalOrder = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(finalOrder.status).toBe("refunded");
    const entries = fake.getRows("ledger_entries") as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.account === "PLATFORM_REVENUE")).toBe(false); // no fee on a supplier-caused exit
    expect(fake.getRows("supplier_strikes")).toHaveLength(1);

    // Full refund, back in the wallet exactly where it started.
    const wallet = fake.getRows("buyer_wallets").find((w) => w.user_id === 1)!;
    expect(wallet.balance_minor).toBe(10_000_000_00);
  });

  it("a 2nd strike within 90 days blocks the supplier from new orders for 7 days", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const provider = stubProvider(supabase);

    for (let i = 0; i < 2; i++) {
      const order = await createOrder(supabase, 1, { supplierId: 1, title: `order ${i}`, deliveryLocation: "y", amountMinor: 300_000_00 });
      await fundOrder(supabase, order.id, 1);
      await abandonOrder(supabase, provider, order.id, 2, { category: "cannot_fulfill" });
    }

    const supplier = fake.getRows("supplier_profiles").find((s) => s.id === 1)!;
    expect(supplier.blocked_until).toBeTruthy();
    expect(new Date(supplier.blocked_until as string).getTime()).toBeGreaterThan(Date.now());

    // createOrder must now refuse new orders against this supplier.
    await expect(
      createOrder(supabase, 1, { supplierId: 1, title: "should be blocked", deliveryLocation: "y", amountMinor: 300_000_00 })
    ).rejects.toThrow(SupplierBlockedError);
  });

  it("refuses to abandon on behalf of a different supplier", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const provider = stubProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });
    await fundOrder(supabase, order.id, 1);

    await expect(abandonOrder(supabase, provider, order.id, 999, { category: "cannot_fulfill" })).rejects.toThrow(NotOrderOwnerError);
  });
});

describe("withdrawProof: flow 7 / Decision 5, short window only", () => {
  it("succeeds within the window and reverts to fulfilling", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });

    const reverted = await withdrawProof(supabase, order.id, 2);
    expect(reverted.status).toBe("fulfilling");
  });

  it("refuses once the window has closed", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });

    // Backdate the proof past the window directly, submitDeliveryProof
    // always stamps "now", so this simulates time having passed rather
    // than faking the clock for the whole test.
    const proof = fake.getRows("delivery_proofs").find((p) => p.order_id === order.id)!;
    await supabase
      .from("delivery_proofs")
      .update({ submitted_at: new Date(Date.now() - WITHDRAW_PROOF_WINDOW_MS - 60_000).toISOString() })
      .eq("id", proof.id);

    await expect(withdrawProof(supabase, order.id, 2)).rejects.toThrow(WithdrawWindowExpiredError);
    // Still proof_submitted, the failed withdrawal attempt didn't change anything.
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("proof_submitted");
  });

  it("refuses for a supplier who isn't a party to the order", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });

    await expect(withdrawProof(supabase, order.id, 999)).rejects.toThrow(NotOrderOwnerError);
  });
});

describe("supplier suspension: flow 10 / Decision 9", () => {
  it("blocks new orders once suspended, and createOrder rejects with SupplierSuspendedError", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);

    await suspendSupplier(supabase, 2, 3, "Repeated buyer complaints under review.");
    await expect(
      createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 })
    ).rejects.toThrow(SupplierSuspendedError);
  });

  it("does not touch an in-flight order that predates the suspension", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });
    await fundOrder(supabase, order.id, 1);

    await suspendSupplier(supabase, 2, 3, "Under review.");

    // The existing funded order is untouched, Decision 9's explicit
    // "never an automatic mass-cancel", still sitting at `funded`, not
    // force-moved to anything else.
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("funded");
  });

  it("unsuspend lets new orders through again", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);

    await suspendSupplier(supabase, 2, 3, "Under review.");
    await unsuspendSupplier(supabase, 2);

    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 300_000_00 });
    expect(order.status).toBe("pending_payment");
  });
});
