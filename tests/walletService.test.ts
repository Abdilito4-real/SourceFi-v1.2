// tests/walletService.test.ts
//
// lib/walletService.ts's own primitives (migration 0020_buyer_wallet.sql):
// balance reads, top-up (the KYC gate, the provider hand-off, the
// confirmation credit), and the atomic debit/credit that gates order
// funding and routes a wallet-funded order's refund. Same integration
// style as tests/orderService.test.ts against the same FakeSupabase
// fixture; wireWalletRpcs (tests/testUtils/fakeSupabase.ts) is the JS
// mirror of migration 0020's wallet_credit/wallet_debit Postgres
// functions — same honest limitation tests/rateLimit.test.ts states for
// its own RPC mocks: this proves the call-shape contract and the
// application-level guard (InsufficientWalletBalanceError), not that the
// real functions' `select ... for update` row-locking is race-free under
// true concurrent connections, that guarantee comes from Postgres itself.
import { describe, it, expect } from "vitest";
import { FakeSupabase, asSupabaseClient, wireWalletRpcs } from "./testUtils/fakeSupabase";
import {
  getWalletBalance,
  initiateWalletTopup,
  confirmWalletTopup,
  debitWalletForOrder,
  creditWalletForRefund,
  wasOrderFundedFromWallet,
  InsufficientWalletBalanceError,
  InvalidTopupAmountError,
  BuyerKycRequiredError,
  StubWalletTopupProvider,
  type WalletTopupProvider,
} from "../lib/walletService";
import { MIN_WALLET_TOPUP_MINOR } from "../lib/money";

function freshFakeSupabase(opts: { withBuyerKyc?: boolean } = {}) {
  const { withBuyerKyc = true } = opts;
  const fake = new FakeSupabase();
  fake.seed("users", [{ id: 1, email: "buyer@example.com", role: "buyer" }]);
  if (withBuyerKyc) {
    fake.seed("buyer_kyc_profiles", [
      {
        user_id: 1,
        first_name: "Test",
        last_name: "Buyer",
        phone: "+2348000000000",
        date_of_birth: "1990-01-01",
        id_type: "nin",
        id_number: "00000000000",
        address: "1 Test Street, Lagos",
        country: "NG",
      },
    ]);
  }
  wireWalletRpcs(fake);
  return fake;
}

/** StubWalletTopupProvider.initiateTopup fires its confirmation
 * fire-and-forget (`void this.scheduleConfirmation(...)`, same shape as
 * StubPaymentProvider), it does NOT await it before returning — even at
 * simulatedDelayMs=0, a `setTimeout` still schedules a macrotask for the
 * next tick. This mirrors tests/orderService.test.ts's own
 * synchronousProvider helper: a separate awaitable that resolves once
 * the confirmation callback actually runs, so a test can wait for it
 * explicitly instead of assuming `await initiateWalletTopup(...)` alone
 * covers it. */
function synchronousTopupProvider(supabase: ReturnType<typeof asSupabaseClient>) {
  let resolveNext: (() => void) | null = null;
  const provider = new StubWalletTopupProvider(async (userId, amountMinor, reference) => {
    await confirmWalletTopup(supabase, userId, amountMinor, reference);
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

describe("getWalletBalance", () => {
  it("returns 0 for a buyer with no wallet row yet, not an error", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(0);
  });

  it("returns the seeded balance once one exists", async () => {
    const fake = freshFakeSupabase();
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 500_000_00, currency: "NGN" }]);
    const supabase = asSupabaseClient(fake);
    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(500_000_00);
  });
});

describe("initiateWalletTopup", () => {
  it("rejects an amount below MIN_WALLET_TOPUP_MINOR before ever calling the provider", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    let providerCalled = false;
    const provider: WalletTopupProvider = {
      initiateTopup: async () => {
        providerCalled = true;
        return { reference: "should-not-be-called", status: "processing" };
      },
    };
    await expect(initiateWalletTopup(supabase, provider, 1, MIN_WALLET_TOPUP_MINOR - 1, "idem-1")).rejects.toThrow(InvalidTopupAmountError);
    expect(providerCalled).toBe(false);
  });

  it("rejects when the buyer has no KYC profile on file, before ever calling the provider", async () => {
    const fake = freshFakeSupabase({ withBuyerKyc: false });
    const supabase = asSupabaseClient(fake);
    let providerCalled = false;
    const provider: WalletTopupProvider = {
      initiateTopup: async () => {
        providerCalled = true;
        return { reference: "should-not-be-called", status: "processing" };
      },
    };
    await expect(initiateWalletTopup(supabase, provider, 1, MIN_WALLET_TOPUP_MINOR, "idem-1")).rejects.toThrow(BuyerKycRequiredError);
    expect(providerCalled).toBe(false);
  });

  it("hands off to the provider and records a processing wallet_transactions row up front", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    // A provider that never confirms, so the row is still "processing"
    // by the time this assertion runs.
    const provider: WalletTopupProvider = { initiateTopup: async () => ({ reference: "ref-1", status: "processing" }) };
    await initiateWalletTopup(supabase, provider, 1, 500_000_00, "idem-1");

    const txn = fake.getRows("wallet_transactions").find((t) => t.provider_reference === "ref-1")!;
    expect(txn.type).toBe("topup");
    expect(txn.order_id).toBeNull();
    expect(txn.amount_minor).toBe(500_000_00);
    expect(txn.status).toBe("processing");
    // Not credited yet, only the confirmation callback does that.
    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(0);
  });

  it("end to end with StubWalletTopupProvider: the balance is credited and the transaction marked confirmed once the (simulated) provider confirms", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    const { provider, waitForConfirmation } = synchronousTopupProvider(supabase);
    const confirmed = waitForConfirmation();
    await initiateWalletTopup(supabase, provider, 1, 750_000_00, "idem-1");
    await confirmed;

    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(750_000_00);
    const txn = fake.getRows("wallet_transactions").find((t) => t.type === "topup")!;
    expect(txn.status).toBe("confirmed");
  });
});

describe("confirmWalletTopup: idempotent against a redelivered confirmation", () => {
  it("crediting twice for the same provider reference only credits the wallet once", async () => {
    const fake = freshFakeSupabase();
    const supabase = asSupabaseClient(fake);
    fake.seed("wallet_transactions", [
      { user_id: 1, type: "topup", amount_minor: 500_000_00, order_id: null, provider_reference: "ref-dup", status: "processing" },
    ]);

    await confirmWalletTopup(supabase, 1, 500_000_00, "ref-dup");
    const { balanceMinor: afterFirst } = await getWalletBalance(supabase, 1);
    expect(afterFirst).toBe(500_000_00);

    // Simulates a real Yellow Card webhook redelivering the exact same
    // notification — this codebase's own webhook handling already
    // assumes at-least-once delivery, so this MUST be a no-op, not a
    // second credit.
    await confirmWalletTopup(supabase, 1, 500_000_00, "ref-dup");
    const { balanceMinor: afterSecond } = await getWalletBalance(supabase, 1);
    expect(afterSecond).toBe(500_000_00); // unchanged, not 1,000,000.00

    const txns = fake.getRows("wallet_transactions").filter((t) => t.provider_reference === "ref-dup");
    expect(txns).toHaveLength(1);
    expect(txns[0]!.status).toBe("confirmed");
  });
});

describe("debitWalletForOrder: gates order funding, migration 0020's core money-safety guarantee", () => {
  it("debits exactly the requested amount and records an order_funding transaction", async () => {
    const fake = freshFakeSupabase();
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 1_000_000_00, currency: "NGN" }]);
    const supabase = asSupabaseClient(fake);

    await debitWalletForOrder(supabase, 1, 42, 400_000_00);

    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(600_000_00);
    const txn = fake.getRows("wallet_transactions").find((t) => t.order_id === 42)!;
    expect(txn.type).toBe("order_funding");
    expect(txn.amount_minor).toBe(400_000_00);
    expect(txn.status).toBe("confirmed");
  });

  it("throws InsufficientWalletBalanceError with the exact shortfall, and debits NOTHING, when the balance falls short", async () => {
    const fake = freshFakeSupabase();
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 100_000_00, currency: "NGN" }]);
    const supabase = asSupabaseClient(fake);

    const err = await debitWalletForOrder(supabase, 1, 42, 400_000_00).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientWalletBalanceError);
    expect((err as InsufficientWalletBalanceError).shortfallMinor).toBe(300_000_00);

    // Balance untouched, no partial debit, and no transaction row for a
    // debit that never actually happened.
    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(100_000_00);
    expect(fake.getRows("wallet_transactions").filter((t) => t.order_id === 42)).toHaveLength(0);
  });

  it("never lets the balance go negative across two debits that individually fit but together don't", async () => {
    const fake = freshFakeSupabase();
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 500_000_00, currency: "NGN" }]);
    const supabase = asSupabaseClient(fake);

    await debitWalletForOrder(supabase, 1, 1, 400_000_00);
    const err = await debitWalletForOrder(supabase, 1, 2, 400_000_00).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientWalletBalanceError);

    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(100_000_00); // only the first debit went through
  });
});

describe("creditWalletForRefund and wasOrderFundedFromWallet", () => {
  it("credits the wallet and records a refund_to_wallet transaction tied to the order", async () => {
    const fake = freshFakeSupabase();
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 300_000_00, currency: "NGN" }]);
    const supabase = asSupabaseClient(fake);
    await debitWalletForOrder(supabase, 1, 42, 300_000_00);

    await creditWalletForRefund(supabase, 1, 42, 300_000_00);

    const { balanceMinor } = await getWalletBalance(supabase, 1);
    expect(balanceMinor).toBe(300_000_00); // debited to 0, then refunded the same amount back
    const refundTxn = fake.getRows("wallet_transactions").find((t) => t.type === "refund_to_wallet")!;
    expect(refundTxn.order_id).toBe(42);
    expect(refundTxn.amount_minor).toBe(300_000_00);
  });

  it("wasOrderFundedFromWallet is true only after a real order_funding transaction exists for that order", async () => {
    const fake = freshFakeSupabase();
    fake.seed("buyer_wallets", [{ user_id: 1, balance_minor: 300_000_00, currency: "NGN" }]);
    const supabase = asSupabaseClient(fake);
    expect(await wasOrderFundedFromWallet(supabase, 42)).toBe(false);

    await debitWalletForOrder(supabase, 1, 42, 300_000_00);
    expect(await wasOrderFundedFromWallet(supabase, 42)).toBe(true);
    // A different, never-funded-from-wallet order stays false.
    expect(await wasOrderFundedFromWallet(supabase, 43)).toBe(false);
  });
});
