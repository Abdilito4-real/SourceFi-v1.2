// tests/orderService.test.ts
//
// lib/orderService.ts is the highest-risk, newest file in this rewrite
// it's where every other tested primitive (state machine, ledger,
// verification check, payment boundary) actually gets wired together
// against real(-ish) Supabase calls. This exercises it against
// tests/testUtils/fakeSupabase.ts rather than relying solely on the
// primitives' own unit tests being individually correct.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeSupabase, asSupabaseClient, wireWalletRpcs } from "./testUtils/fakeSupabase";
import {
  createOrder,
  fundOrder,
  handlePaymentStatusEvent,
  submitDeliveryProof,
  approveOrder,
  rejectProof,
  resolveDispute,
  submitRating,
  recordVerificationCallProgress,
  confirmCallCode,
  CallCodeNotConfirmedError,
  computeUsdcSplit,
  setCallPresence,
  applyJaasWebhookPresence,
  ensureCallRoomId,
  MIN_VERIFICATION_CALL_SECONDS,
  SupplierNotCurrentlyVerifiedError,
  InsufficientWalletBalanceError,
  NotOrderOwnerError,
  VerificationCallIncompleteError,
  InvalidOrderAmountError,
  ReleaseAlreadyConfirmedError,
} from "../lib/orderService";
import { InvalidOrderTransitionError } from "../lib/orderStateMachine";
import { StubPaymentProvider, type PaymentStatusEvent } from "../lib/paymentBoundary";
import { MIN_ORDER_AMOUNT_MINOR } from "../lib/money";

const NOW = Date.now();
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function freshFakeSupabase(opts: { withWalletBalance?: number } = {}) {
  // A generous default (₦100,000,000.00), not a precise number: fundOrder
  // is wallet-first as of migration 0020, seeded by default so every
  // existing fundOrder-touching test keeps passing without individually
  // knowing about it — pass { withWalletBalance: 0 } for the dedicated
  // insufficient-balance test instead. buyer_kyc_profiles is no longer
  // seeded here at all: KYC now gates initiateWalletTopup, not fundOrder
  // (see tests/walletService.test.ts for that gate's own test).
  const { withWalletBalance = 10_000_000_00 } = opts;
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
  if (withWalletBalance > 0) {
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: withWalletBalance, currency: "NGN" }]);
  }
  wireWalletRpcs(fake);
  // Mirrors the real is_supplier_currently_verified() Postgres function
  // (migration 0004), evaluated against the fake's live table state so
  // it reflects whatever a test mutates mid-run.
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

/** A payment provider whose confirmations fire SYNCHRONOUSLY (delay 0)
 * and are awaited before the initiate* call returns, so tests don't need
 * arbitrary sleeps to observe the follow-up state change. Still goes
 * through the exact same StubPaymentProvider -> handlePaymentStatusEvent
 * path production code uses. */
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

beforeEach(() => {
  vi.useRealTimers();
});

/** Both parties independently report the same corroborated window,
 * satisfying recordVerificationCallProgress's cross-party overlap
 * requirement (lib/callVerification.ts) — the realistic "buyer and
 * supplier really were on the call together" case most tests below just
 * need to clear this gate to test something else, same role
 * `MIN_VERIFICATION_CALL_SECONDS` played before the corroboration fix.
 * The +3s buffer over the threshold absorbs the few milliseconds of real
 * wall-clock jitter between the two sequential calls (each segment's
 * start is computed as "now minus duration" at the moment IT specifically
 * is reported, so two reports a few ms apart don't overlap by quite the
 * full duration either side claimed) — comfortably enough to still clear
 * MIN_VERIFICATION_CALL_SECONDS even so. */
async function satisfyCallRequirement(
  supabase: ReturnType<typeof asSupabaseClient>,
  orderId: number,
  buyerUserId: number,
  supplierUserId: number,
  seconds = MIN_VERIFICATION_CALL_SECONDS + 3
) {
  await recordVerificationCallProgress(supabase, orderId, buyerUserId, seconds);
  return recordVerificationCallProgress(supabase, orderId, supplierUserId, seconds);
}

describe("createOrder: the live verification gate", () => {
  it("creates an order against a currently-verified supplier", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, {
      supplierId: 1,
      title: "50 bags LC3 cement",
      deliveryLocation: "Lekki, Lagos",
      amountMinor: 50_000_00,
    });
    expect(order.status).toBe("pending_payment");
    expect(order.buyer_id).toBe(1);
    expect(order.supplier_id).toBe(1);
    // The call room name must never be derivable from anything
    // user-visible, order_code is a guessable 6-digit string; the room
    // id is a real random UUID and must differ from it.
    expect(order.verification_call_room_id).toBeTruthy();
    expect(order.verification_call_room_id).not.toBe(order.order_code);
    expect(order.platform_fee_minor).toBeGreaterThan(0);
  });

  it("refuses to create an order against an EXPIRED supplier, even though verification_status column still says 'verified'", async () => {
    const fake = freshFakeSupabase();
    // Simulate the exact staleness scenario design doc Section D.2 warns
    // about: the cached column hasn't been swept yet, but the expiry
    // date has passed, the live RPC check must still catch it.
    const supplier = fake.getRows("supplier_profiles")[0]!;
    await asSupabaseClient(fake)
      .from("supplier_profiles")
      .update({ verification_expires_at: new Date(NOW - 1000).toISOString() })
      .eq("id", supplier.id);

    const supabase = asSupabaseClient(fake);
    await expect(
      createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1000 })
    ).rejects.toThrow(SupplierNotCurrentlyVerifiedError);
  });

  it("refuses to create an order against a supplier who has hit the 20-order cap", async () => {
    const fake = freshFakeSupabase();
    await asSupabaseClient(fake).from("supplier_profiles").update({ orders_since_verification: 20 }).eq("id", 1);
    const supabase = asSupabaseClient(fake);
    await expect(
      createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1000 })
    ).rejects.toThrow(SupplierNotCurrentlyVerifiedError);
  });
});

describe("the full happy-path lifecycle: create -> fund -> proof -> approve -> settle -> rate", () => {
  it("walks every state in order and ends with a balanced ledger", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);

    const created = await createOrder(supabase, 1, {
      supplierId: 1,
      title: "50 bags LC3 cement",
      deliveryLocation: "Lekki, Lagos",
      amountMinor: 500_000_00, // NGN 500,000.00
    });
    expect(created.status).toBe("pending_payment");

    // Wallet-first funding (migration 0020) is fully synchronous: by the
    // time fundOrder returns, the debit AND the confirmation walk
    // (payment_processing -> converting -> escrow_depositing -> funded)
    // have already completed, no separate wait needed like the old
    // provider-mediated path required.
    const funded = await fundOrder(supabase, created.id, 1);
    expect(funded.order.status).toBe("funded");

    const afterFunding = fake.getRows("orders").find((o) => o.id === created.id)!;
    expect(afterFunding.status).toBe("funded");
    // orders_since_verification incremented (design doc Section D.2).
    expect(fake.getRows("supplier_profiles").find((s) => s.id === 1)!.orders_since_verification).toBe(1);

    const proofSubmitted = await submitDeliveryProof(supabase, created.id, 2, {
      photoUrls: ["https://example.com/photo1.jpg"],
      receiptUrl: null,
      notes: "Delivered to site.",
    });
    expect(proofSubmitted.status).toBe("proof_submitted");

    // Mandatory live verification call, approveOrder rejects below the
    // threshold (a separate test covers that directly); satisfy it here
    // so the rest of the happy path can proceed. Also the order-code
    // liveness confirmation, a second, independent gate.
    await satisfyCallRequirement(supabase, created.id, 1, 2);
    await confirmCallCode(supabase, created.id, 1);

    let confirmed = waitForConfirmation();
    const approved = await approveOrder(supabase, provider, created.id, 1);
    expect(approved.status).toBe("release_submitted");
    await confirmed;

    // handleReleaseConfirmed auto-advances into settlement_processing but
    // does NOT auto-settle, that needs its own, separate confirmation
    // (design doc Section D.0's whole point, applied to the settlement
    // leg too).
    const afterRelease = fake.getRows("orders").find((o) => o.id === created.id)!;
    expect(afterRelease.status).toBe("settlement_processing");

    // The stub chains a settlement confirmation after release on its own
    // (lib/paymentBoundary.ts, otherwise every order would hang in
    // settlement_processing forever, since nothing else would ever
    // report that leg in the stub world). Wait for THAT second event
    // rather than fabricating one, this is what the real callback chain
    // production code goes through actually produces.
    confirmed = waitForConfirmation();
    await confirmed;

    const settled = fake.getRows("orders").find((o) => o.id === created.id)!;
    expect(settled.status).toBe("settled");

    const rating = await submitRating(supabase, provider, created.id, 1, 5, "Great supplier");
    expect(rating.confirmed).toBe(false); // stub never auto-confirms ratings, Open Question 10

    // The ledger invariant, checked end to end: every account touched
    // across the whole lifecycle nets to zero except the two legitimate
    // permanent external flows (buyer's NGN out, supplier's NGN in) and
    // the platform's fee revenue.
    const entries = fake.getRows("ledger_entries");
    const byAccount = new Map<string, number>();
    for (const e of entries) {
      const key = `${e.account}:${e.currency}`;
      const signed = e.direction === "debit" ? (e.amount_minor as number) : -(e.amount_minor as number);
      byAccount.set(key, (byAccount.get(key) ?? 0) + signed);
    }
    expect(byAccount.get("ESCROW_WALLET_USDC:USDC")).toBe(0);
    expect(byAccount.get("SUPPLIER_PAYABLE:USDC")).toBe(0);
  });
});

describe("fundOrder: ownership and re-verification at funding time", () => {
  it("rejects funding an order that isn't the caller's own", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });
    await expect(fundOrder(supabase, order.id, 999)).rejects.toThrow(NotOrderOwnerError);
  });

  it("rejects funding if the supplier's verification expired between order-creation and funding", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });

    // Verification expires AFTER the order was created but BEFORE funding.
    await supabase.from("supplier_profiles").update({ verification_expires_at: new Date(NOW - 1000).toISOString() }).eq("id", 1);

    await expect(fundOrder(supabase, order.id, 1)).rejects.toThrow(SupplierNotCurrentlyVerifiedError);
  });

  it("rejects funding when the buyer's wallet balance doesn't cover the order (migration 0020, wallet-first funding)", async () => {
    const fake = freshFakeSupabase({ withWalletBalance: 0 });
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });
    const err = await fundOrder(supabase, order.id, 1).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientWalletBalanceError);
    expect((err as InsufficientWalletBalanceError).shortfallMinor).toBe(500_000);
    // Never even reached payment_processing, the order stays put, and
    // nothing was debited (there was nothing to debit).
    const { data: unchanged } = await supabase.from("orders").select("status").eq("id", order.id).maybeSingle();
    expect((unchanged as { status: string } | null)?.status).toBe("pending_payment");
    const { data: wallet } = await supabase.from("buyer_wallets").select("balance_minor").eq("user_id", 1).maybeSingle();
    expect((wallet as { balance_minor: number } | null)?.balance_minor ?? 0).toBe(0);
  });

  it("funds an order instantly from a sufficient wallet balance, debiting exactly the order amount", async () => {
    const fake = freshFakeSupabase({ withWalletBalance: 750_000 });
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });
    const { order: funded } = await fundOrder(supabase, order.id, 1);
    expect(funded.status).toBe("funded");
    const { data: wallet } = await supabase.from("buyer_wallets").select("balance_minor").eq("user_id", 1).maybeSingle();
    expect((wallet as { balance_minor: number } | null)?.balance_minor).toBe(250_000);
  });
});

describe("handlePaymentStatusEvent: idempotency", () => {
  it("a duplicate/replayed funding confirmation is a no-op, not a double-write", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 320_000_00 });

    await fundOrder(supabase, order.id, 1);

    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("funded");
    expect(fake.getRows("ledger_entries").filter((e) => e.order_id === order.id)).toHaveLength(4);
    expect(fake.getRows("supplier_profiles").find((s) => s.id === 1)!.orders_since_verification).toBe(1);

    // Replay the exact same confirmation event a second time (simulating
    // a retried webhook or a duplicate poll tick).
    await handlePaymentStatusEvent(supabase, {
      orderId: order.id,
      leg: "funding",
      provider: "yellow_card",
      providerReference: "replay",
      providerState: "confirmed",
    });

    // Status unchanged, ledger NOT written a second time, counter NOT
    // incremented a second time.
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("funded");
    expect(fake.getRows("ledger_entries").filter((e) => e.order_id === order.id)).toHaveLength(4);
    expect(fake.getRows("supplier_profiles").find((s) => s.id === 1)!.orders_since_verification).toBe(1);
  });
});

describe("rejectProof -> disputed -> resolveDispute (pre-release refund path)", () => {
  it("a buyer-ruled dispute on a funded-but-not-yet-released order triggers an automatic refund", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 200_000_00 });

    await fundOrder(supabase, order.id, 1);

    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });

    const rejected = await rejectProof(supabase, order.id, 1, { category: "item_not_as_described", description: "Wrong grade" });
    expect(rejected.status).toBe("disputed");

    const dispute = fake.getRows("disputes").find((d) => d.order_id === order.id)!;
    expect(dispute.dispute_type).toBe("pre_approval_rejection");

    // The order was funded from the wallet, so resolveDispute's refund
    // branch routes straight to the wallet-credit event path (migration
    // 0020) — synchronous, no separate wait needed, same as fundOrder
    // above.
    const result = await resolveDispute(supabase, provider, dispute.id as number, 3, "buyer", "Confirmed wrong grade delivered.");
    expect(result.autoActionTaken).toBe("refund_initiated");

    const finalOrder = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(finalOrder.status).toBe("refunded");

    // Credited back to the wallet, not lost: the buyer paid 200,000.00
    // from the wallet to fund this order, and gets it all back.
    const wallet = fake.getRows("buyer_wallets").find((w) => w.user_id === 1)!;
    expect(wallet.balance_minor).toBe(10_000_000_00);
  });

  it("a supplier-ruled dispute proceeds through the normal release path instead", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 200_000_00 });

    await fundOrder(supabase, order.id, 1);

    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    const rejected = await rejectProof(supabase, order.id, 1, { category: "other", description: "buyer changed their mind" });
    const dispute = fake.getRows("disputes").find((d) => d.order_id === order.id)!;

    // This ruling still goes through the real release path (Circle stub),
    // genuinely async, unlike the wallet-funding/refund paths above.
    let confirmed = waitForConfirmation();
    const result = await resolveDispute(supabase, provider, dispute.id as number, 3, "supplier", "Proof was valid, releasing.");
    expect(result.autoActionTaken).toBe("release_initiated");
    await confirmed;

    // Release confirmed -> escrow_released -> settlement_processing,
    // same as the normal approval path (Section D.0's states apply
    // uniformly, not just on the happy path).
    const finalOrder = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(finalOrder.status).toBe("settlement_processing");
    void rejected;

    // Drain the stub's chained settlement confirmation before the test
    // ends, rather than leaving it to fire after teardown.
    confirmed = waitForConfirmation();
    await confirmed;
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("settled");
  });

  // No live code path today can actually put an order into "disputed"
  // once its release has already confirmed (every real dispute-opening
  // caller only fires at funded/fulfilling/proof_submitted/rejected —
  // see ReleaseAlreadyConfirmedError's own doc comment), so this
  // simulates the guarded scenario directly by seeding the
  // release_confirmed payment_event a real Circle release would have
  // written, rather than by trying to reach it through the normal flow.
  it("resolveDispute refuses to auto-refund a buyer-ruled dispute if the release already confirmed, even though that's unreachable through any live flow today", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 200_000_00 });

    await fundOrder(supabase, order.id, 1);

    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    await rejectProof(supabase, order.id, 1, { category: "item_not_as_described", description: "Wrong grade" });
    const dispute = fake.getRows("disputes").find((d) => d.order_id === order.id)!;

    // Simulate a real Circle release having already confirmed for this
    // order — same row shape lib/circleEscrowProvider.ts's reportOutcome
    // writes on a real "confirmed" outcome.
    await supabase.from("payment_events").insert({
      order_id: order.id,
      leg: "release",
      provider: "circle",
      provider_reference: "circle-txn-already-confirmed",
      event_type: "release_confirmed",
      provider_state: "COMPLETE",
      tx_hash: "0xalreadyconfirmed",
    });

    await expect(resolveDispute(supabase, provider, dispute.id as number, 3, "buyer", "Trying to refund after release.")).rejects.toThrow(
      ReleaseAlreadyConfirmedError
    );

    // Refused before ever touching order status or initiating a refund.
    const finalOrder = fake.getRows("orders").find((o) => o.id === order.id)!;
    expect(finalOrder.status).toBe("disputed");
  });
});

describe("InvalidOrderTransitionError surfaces from orderService, not just orderStateMachine directly", () => {
  it("rejects approving an order that hasn't had proof submitted yet", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });
    await expect(approveOrder(supabase, provider, order.id, 1)).rejects.toThrow(InvalidOrderTransitionError);
  });
});

describe("ensureCallRoomId: backfill for orders that predate migration 0008", () => {
  it("returns the existing room id untouched when already set", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });
    const roomId = await ensureCallRoomId(supabase, order);
    expect(roomId).toBe(order.verification_call_room_id);
  });

  it("generates and persists a fresh room id for a legacy order missing one", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 500_000 });
    // Simulate a pre-migration-0008 row.
    await supabase.from("orders").update({ verification_call_room_id: null }).eq("id", order.id);

    const roomId = await ensureCallRoomId(supabase, { ...order, verification_call_room_id: null });
    expect(roomId).toBeTruthy();
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.verification_call_room_id).toBe(roomId);
  });
});

describe("createOrder: minimum order amount", () => {
  it("rejects an order below MIN_ORDER_AMOUNT_MINOR, since the flat platform fee would leave the supplier a negative payout", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    await expect(
      createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1000 })
    ).rejects.toThrow(InvalidOrderAmountError);
  });

  it("accepts an order right at the minimum", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, {
      supplierId: 1,
      title: "x",
      deliveryLocation: "y",
      amountMinor: MIN_ORDER_AMOUNT_MINOR,
    });
    expect(order.amount_minor).toBe(MIN_ORDER_AMOUNT_MINOR);
  });
});

describe("mandatory live verification call before approval", () => {
  async function orderAtProofSubmitted(fake: FakeSupabase) {
    const supabase = asSupabaseClient(fake);
    // A realistic amount, not the trivial 1000 (NGN 10) other tests in
    // this file use, several tests below call approveOrder/resolveDispute
    // which (since the StubPaymentProvider fix) now chains a REAL
    // settlement confirmation afterward, which needs a sane (non-negative)
    // supplier/fee split. createOrder() now enforces MIN_ORDER_AMOUNT_MINOR
    // itself (see "rejects an order below the minimum amount" below), so
    // this amount just needs to clear that floor, it's not sidestepping
    // anything anymore.
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1_000_000 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    return order;
  }

  it("rejects approval with zero recorded call time", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);
    await expect(approveOrder(supabase, provider, order.id, 1)).rejects.toThrow(VerificationCallIncompleteError);
  });

  it("rejects approval below the 5-minute threshold, even by one second", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);
    // Overlap can never exceed either side's own reported duration (see
    // computeOverlapSeconds), so both parties reporting exactly one
    // second under the threshold guarantees the corroborated total stays
    // under it too, no buffer needed for a "must stay below" assertion.
    await recordVerificationCallProgress(supabase, order.id, 1, MIN_VERIFICATION_CALL_SECONDS - 1);
    await recordVerificationCallProgress(supabase, order.id, 2, MIN_VERIFICATION_CALL_SECONDS - 1);
    await expect(approveOrder(supabase, provider, order.id, 1)).rejects.toThrow(VerificationCallIncompleteError);
  });

  it("rejects approval when only ONE party reports call time, even a long one, no corroboration means no credit", async () => {
    // The exact gap a security audit of this flow found and this test
    // now pins down as fixed: a single party alone used to be able to
    // satisfy the whole requirement with one report.
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);
    const afterBuyerAlone = await recordVerificationCallProgress(supabase, order.id, 1, MIN_VERIFICATION_CALL_SECONDS);
    expect(afterBuyerAlone.verification_call_seconds).toBe(0);
    await expect(approveOrder(supabase, provider, order.id, 1)).rejects.toThrow(VerificationCallIncompleteError);
  });

  it("allows approval once the threshold is met and the order code is confirmed", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);
    await satisfyCallRequirement(supabase, order.id, 1, 2);
    await confirmCallCode(supabase, order.id, 1);
    const approved = await approveOrder(supabase, provider, order.id, 1);
    expect(approved.status).toBe("release_submitted");
  });

  it("rejects approval with enough call time but no order-code confirmation, a long call isn't the same claim as a proven one", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);
    await satisfyCallRequirement(supabase, order.id, 1, 2);
    await expect(approveOrder(supabase, provider, order.id, 1)).rejects.toThrow(CallCodeNotConfirmedError);
  });

  it("confirmCallCode: only the buyer can confirm, not the supplier or an unrelated user", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);
    // Ownership is checked before the (new) call-time gate, so this
    // rejects for the right reason even with zero call time recorded.
    await expect(confirmCallCode(supabase, order.id, 2)).rejects.toThrow(NotOrderOwnerError);
    await expect(confirmCallCode(supabase, order.id, 99)).rejects.toThrow(NotOrderOwnerError);
  });

  it("confirmCallCode rejects the buyer's own attestation until the corroborated call time actually clears the threshold", async () => {
    // The other half of the same gap as "rejects approval when only ONE
    // party reports": confirmCallCode used to be reachable the instant
    // an order was funded, with no call ever having happened at all.
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);
    await expect(confirmCallCode(supabase, order.id, 1)).rejects.toThrow(VerificationCallIncompleteError);

    await recordVerificationCallProgress(supabase, order.id, 1, MIN_VERIFICATION_CALL_SECONDS);
    // Buyer alone still isn't enough, same corroboration rule as approval.
    await expect(confirmCallCode(supabase, order.id, 1)).rejects.toThrow(VerificationCallIncompleteError);

    await satisfyCallRequirement(supabase, order.id, 1, 2);
    const confirmed = await confirmCallCode(supabase, order.id, 1);
    expect(confirmed.call_code_confirmed_at).not.toBeNull();
  });

  it("accumulates across multiple genuinely disjoint segments reported by both parties (call dropped and rejoined)", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);

    // Fake timers make each segment's reported window exact (no real
    // wall-clock jitter between the buyer's and supplier's calls), and
    // let a genuine gap be simulated between segments so the second
    // segment doesn't just get merged into the first as one long
    // overlapping report from the SAME party (see mergeIntervals).
    vi.useFakeTimers();
    const start = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);

    // First segment: both parties on the call together for 120s.
    await recordVerificationCallProgress(supabase, order.id, 1, 120);
    let current = await recordVerificationCallProgress(supabase, order.id, 2, 120);
    expect(current.verification_call_seconds).toBe(120);
    await expect(approveOrder(supabase, provider, order.id, 1)).rejects.toThrow(VerificationCallIncompleteError);

    // The call drops. Ten minutes pass with nobody connected, then both
    // reconnect and stay on for another 185s together, a genuinely
    // separate, disjoint segment from the first.
    vi.setSystemTime(new Date(start.getTime() + 10 * 60 * 1000));
    await recordVerificationCallProgress(supabase, order.id, 1, 185);
    current = await recordVerificationCallProgress(supabase, order.id, 2, 185);
    expect(current.verification_call_seconds).toBe(120 + 185);

    await confirmCallCode(supabase, order.id, 1);
    const approved = await approveOrder(supabase, provider, order.id, 1);
    expect(approved.status).toBe("release_submitted");
  });

  it("either the buyer or the assigned supplier can call this, but alone it earns zero credit; an unrelated user can't call it at all", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);

    // The assigned supplier (user_id 2) reports it, not the buyer: this
    // doesn't throw NotOrderOwnerError (they ARE a party to the order),
    // but earns zero corroborated seconds alone, the buyer never having
    // reported anything overlapping.
    const afterSupplierReport = await recordVerificationCallProgress(supabase, order.id, 2, MIN_VERIFICATION_CALL_SECONDS);
    expect(afterSupplierReport.verification_call_seconds).toBe(0);

    // The buyer then reports the same window: now both parties have
    // corroborated it, and it counts.
    const afterBuyerReport = await recordVerificationCallProgress(supabase, order.id, 1, MIN_VERIFICATION_CALL_SECONDS);
    expect(afterBuyerReport.verification_call_seconds).toBeGreaterThan(0);

    // An unrelated user (admin, id 3, not a party to this order) can't
    // call this at all, ownership is checked before anything else.
    await expect(recordVerificationCallProgress(supabase, order.id, 3, 60)).rejects.toThrow(NotOrderOwnerError);
  });

  it("caps a single reported segment at 2 hours per party, rather than trusting an unbounded client-supplied number", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    await recordVerificationCallProgress(supabase, order.id, 1, 999_999);
    const result = await recordVerificationCallProgress(supabase, order.id, 2, 999_999);
    // Both segments are capped at 2h before the overlap step, and (fake
    // timers holding time still) reported at the identical instant, so
    // the corroborated overlap is exactly the cap, not the raw number.
    expect(result.verification_call_seconds).toBe(2 * 60 * 60);
  });

  it("rejects recordVerificationCallProgress on an order that isn't funded yet, no padding time before there's anything to verify", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1_000_000 });
    await expect(recordVerificationCallProgress(supabase, order.id, 1, 60)).rejects.toThrow(InvalidOrderTransitionError);
  });

  it("a dispute resolved for the supplier bypasses this requirement entirely: it's an admin ruling, not the buyer's own approval", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider } = synchronousProvider(supabase);
    const order = await orderAtProofSubmitted(fake);

    const rejected = await rejectProof(supabase, order.id, 1, { category: "other", description: "changed my mind" });
    expect(rejected.status).toBe("disputed");
    const dispute = fake.getRows("disputes").find((d) => d.order_id === order.id)!;

    // No call time recorded at all, the admin ruling still proceeds
    // because resolveDispute's supplier-ruling path calls
    // initiateEscrowRelease directly, not through approveOrder.
    const result = await resolveDispute(supabase, provider, dispute.id as number, 3, "supplier", "Proof was valid.");
    expect(result.autoActionTaken).toBe("release_initiated");
  });

  it("setCallPresence stamps the correct party's column and clears it again on leave", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);

    await setCallPresence(supabase, order.id, 1, true); // buyer (id 1) joins
    let current = await recordVerificationCallProgress(supabase, order.id, 1, 1);
    expect(current.buyer_call_active_since).not.toBeNull();
    expect(current.supplier_call_active_since).toBeFalsy(); // never touched yet, null in real Postgres

    await setCallPresence(supabase, order.id, 2, true); // supplier (id 2) joins
    current = await recordVerificationCallProgress(supabase, order.id, 1, 1);
    expect(current.supplier_call_active_since).not.toBeNull();

    await setCallPresence(supabase, order.id, 1, false); // buyer leaves
    current = await recordVerificationCallProgress(supabase, order.id, 1, 1);
    expect(current.buyer_call_active_since).toBeNull();
    expect(current.supplier_call_active_since).not.toBeNull(); // untouched by the buyer's own leave
  });

  it("setCallPresence rejects a user who is neither the buyer nor the assigned supplier", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);

    await expect(setCallPresence(supabase, order.id, 3, true)).rejects.toThrow(NotOrderOwnerError);
  });
});

describe("applyJaasWebhookPresence: the real, webhook-driven fix for the collusion gap client-reported corroboration alone can't close", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function orderAtProofSubmitted(fake: FakeSupabase) {
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1_000_000 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    return order;
  }

  it("credits the overlap between a real JOINED/LEFT pair for each party, computed from JaaS's own event timestamps", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    await applyJaasWebhookPresence(supabase, order.id, "buyer", true, new Date(t0).toISOString());
    await applyJaasWebhookPresence(supabase, order.id, "supplier", true, new Date(t0 + 5_000).toISOString()); // supplier joins 5s later
    await applyJaasWebhookPresence(supabase, order.id, "buyer", false, new Date(t0 + 305_000).toISOString());
    const afterSupplierLeft = await applyJaasWebhookPresenceAndFetch(
      supabase,
      order.id,
      "supplier",
      false,
      new Date(t0 + 310_000).toISOString()
    );
    // Buyer: [0,305], supplier: [5,310] -> overlap [5,305] = 300s.
    expect(afterSupplierLeft.verification_call_seconds).toBe(300);
  });

  it("a LEFT with nothing open (no matching JOINED, or already processed) is a safe no-op, not a fabricated segment", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);

    // No JOINED ever recorded for either party: a no-op LEFT never even
    // reaches the .update() call, so the column stays exactly as
    // createOrder left it (unset in this fixture, `not null default 0`
    // in real Postgres, see migration 0007) rather than being written
    // as an explicit 0 — same distinction the app's own `?? 0` reads
    // everywhere already account for.
    await applyJaasWebhookPresence(supabase, order.id, "buyer", false, new Date().toISOString());
    const orders = fake.getRows("orders");
    expect(orders.find((o) => o.id === order.id)!.verification_call_seconds ?? 0).toBe(0);
  });

  it("a duplicate/retried LEFT webhook is idempotent: the segment is only credited once", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);

    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    await applyJaasWebhookPresence(supabase, order.id, "buyer", true, new Date(t0).toISOString());
    await applyJaasWebhookPresence(supabase, order.id, "supplier", true, new Date(t0).toISOString());
    await applyJaasWebhookPresence(supabase, order.id, "buyer", false, new Date(t0 + 300_000).toISOString());
    const first = await applyJaasWebhookPresenceAndFetch(supabase, order.id, "supplier", false, new Date(t0 + 300_000).toISOString());
    expect(first.verification_call_seconds).toBe(300);

    // JaaS retries the exact same supplier LEFT event (network blip, no
    // 2xx received the first time) — buyer_call_active_since/
    // supplier_call_active_since is already null from the first pass, so
    // this must NOT insert a second segment or double the total.
    const retried = await applyJaasWebhookPresenceAndFetch(supabase, order.id, "supplier", false, new Date(t0 + 300_000).toISOString());
    expect(retried.verification_call_seconds).toBe(300);
    expect(fake.getRows("call_segments").filter((s) => s.order_id === order.id)).toHaveLength(2); // one per party, not three
  });

  it("recordVerificationCallProgress becomes a harmless no-op once JAAS_WEBHOOK_SECRET is set — it never inserts a client-reported segment", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);
    process.env.JAAS_WEBHOOK_SECRET = "whsec_test";

    const result = await recordVerificationCallProgress(supabase, order.id, 1, MIN_VERIFICATION_CALL_SECONDS);
    expect(result.verification_call_seconds ?? 0).toBe(0); // early-returns the fetched order untouched, see the comment above
    expect(fake.getRows("call_segments").filter((s) => s.order_id === order.id)).toHaveLength(0);
  });

  it("setCallPresence becomes a harmless no-op once JAAS_WEBHOOK_SECRET is set — it never writes buyer/supplier_call_active_since", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await orderAtProofSubmitted(fake);
    process.env.JAAS_WEBHOOK_SECRET = "whsec_test";

    await setCallPresence(supabase, order.id, 1, true);
    expect(fake.getRows("orders").find((o) => o.id === order.id)!.buyer_call_active_since).toBeFalsy();
  });

  /** applyJaasWebhookPresence returns void (route-driven), unlike
   * recordVerificationCallProgress; these tests need the resulting
   * order row, so this small wrapper calls it and re-fetches. */
  async function applyJaasWebhookPresenceAndFetch(
    supabase: ReturnType<typeof asSupabaseClient>,
    orderId: number,
    party: "buyer" | "supplier",
    joined: boolean,
    atIso: string
  ) {
    await applyJaasWebhookPresence(supabase, orderId, party, joined, atIso);
    const { data } = await supabase.from("orders").select("*").eq("id", orderId).single();
    return data as { verification_call_seconds: number };
  }
});

describe("approveOrder: a real payment provider's initiateEscrowRelease can throw (CircleEscrowProvider can, the stub never does)", () => {
  /** Release leg always fails, like a real CircleEscrowProvider would if
   * the supplier has no wallet_address or the escrow wallet has no USDC. */
  function alwaysFailingReleaseProvider() {
    return {
      initiateOrderFunding: async (orderId: number) => ({ paymentReference: `fund-${orderId}`, status: "processing" as const }),
      initiateEscrowRelease: async () => {
        throw new Error("Supplier 1 has no wallet_address on file.");
      },
      initiateRefund: async (orderId: number) => ({ refundReference: `refund-${orderId}`, status: "processing" as const }),
      submitRatingOnChain: async () => ({ txHash: null, status: "submitted" as const }),
    };
  }

  it("re-throws the failure and does NOT silently report success", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1_000_000 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    await satisfyCallRequirement(supabase, order.id, 1, 2);
    await confirmCallCode(supabase, order.id, 1);

    await expect(approveOrder(supabase, alwaysFailingReleaseProvider(), order.id, 1)).rejects.toThrow(/wallet_address/);
  });

  it("leaves the order at release_submitted (the only state that matches reality) and records a release_failed payment_event instead of losing the failure", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1_000_000 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    await satisfyCallRequirement(supabase, order.id, 1, 2);
    await confirmCallCode(supabase, order.id, 1);

    await expect(approveOrder(supabase, alwaysFailingReleaseProvider(), order.id, 1)).rejects.toThrow();

    expect(fake.getRows("orders").find((o) => o.id === order.id)!.status).toBe("release_submitted");
    const events = fake.getRows("payment_events").filter((e) => e.order_id === order.id && e.leg === "release");
    expect(events.some((e) => e.event_type === "release_failed")).toBe(true);
  });
});

describe("computeUsdcSplit: live NGN/USD rate (lib/fxRate.ts), not a hardcoded constant", () => {
  it("computes the USDC total from whatever rate fetch() currently returns", async () => {
    // tests/testUtils/setupFetchStub.ts's default stub returns 1600.
    const split = await computeUsdcSplit({ amount_minor: 1_600_000, platform_fee_minor: 160_000 });
    expect(split.ngnPerUsd).toBe(1600);
    expect(split.totalUsdcMinor).toBe(1_000); // 1,600,000 minor NGN / 1600 = 1,000 minor USDC
    expect(split.platformFeeUsdcMinor).toBe(100); // same 10% proportion as the NGN fee
    expect(split.supplierUsdcMinor).toBe(900);
  });

  it("moves with the rate: a different fetch() response changes the computed split", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ rates: { NGN: 2000 } }), { status: 200 })));
    const split = await computeUsdcSplit({ amount_minor: 2_000_000, platform_fee_minor: 0 });
    expect(split.ngnPerUsd).toBe(2000);
    expect(split.totalUsdcMinor).toBe(1_000);
  });
});

describe("a release's USDC split, once persisted, is what gets booked to the ledger, never silently recomputed against a rate that's since moved", () => {
  it("handleReleaseConfirmed uses the split already on the order row, ignoring a since-changed live rate", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousProvider(supabase);
    const order = await createOrder(supabase, 1, { supplierId: 1, title: "x", deliveryLocation: "y", amountMinor: 1_000_000 });
    await fundOrder(supabase, order.id, 1);
    await submitDeliveryProof(supabase, order.id, 2, { photoUrls: ["p.jpg"], receiptUrl: null, notes: null });
    await satisfyCallRequirement(supabase, order.id, 1, 2);
    await confirmCallCode(supabase, order.id, 1);

    // Simulates what lib/circleEscrowProvider.ts persists immediately
    // after a REAL Circle transaction is accepted, at whatever the rate
    // was at that exact moment, this is deliberately NOT the rate the
    // fetch stub will return moments later below. getRows() returns
    // copies (a test-seeding convenience), a real update through the
    // fake client is what actually mutates stored state.
    await supabase
      .from("orders")
      .update({ release_usdc_total_minor: 555, release_usdc_platform_fee_minor: 55 })
      .eq("id", order.id);

    // The rate has since moved. If handleReleaseConfirmed recomputed
    // instead of reading the persisted split back, the ledger entry
    // below would reflect THIS rate, not the one actually used on-chain.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ rates: { NGN: 99999 } }), { status: 200 })));

    const confirmed = waitForConfirmation();
    await approveOrder(supabase, provider, order.id, 1);
    await confirmed;

    const releaseLegs = fake
      .getRows("ledger_entries")
      .filter((e) => e.order_id === order.id && (e.account === "SUPPLIER_PAYABLE" || e.account === "PLATFORM_REVENUE"));
    expect(releaseLegs.find((e) => e.account === "SUPPLIER_PAYABLE")!.amount_minor).toBe(500); // 555 - 55
    expect(releaseLegs.find((e) => e.account === "PLATFORM_REVENUE")!.amount_minor).toBe(55);
  });
});
