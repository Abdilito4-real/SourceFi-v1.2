// tests/ledger.test.ts
//
// The pack's explicit requirement: "the fundamental invariant should be
// for every ledger transaction, total debits must equal total credits...
// include tests that verify this invariant." This file does that at two
// levels — assertBalanced() directly (pure logic, every scenario in the
// design doc's Section I test plan), and writeLedgerTransaction() against
// a mocked Supabase client (proves the unbalanced case never reaches the
// database at all, and the balanced case sends exactly the rows it
// should, sharing one ledger_transaction_id).
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertBalanced,
  writeLedgerTransaction,
  recordFundingConfirmed,
  recordEscrowRelease,
  recordSettlement,
  recordRefundFromEscrow,
  UnbalancedLedgerTransactionError,
  type LedgerLeg,
} from "../lib/ledger";

/** Mimics supabase-js's .from().insert() chain closely enough for this
 * module's exact call shape, same pattern as tests/authz.test.ts's
 * mockSupabaseReturning(). Records every row actually sent so tests can
 * assert on them. */
function mockSupabaseInsert() {
  const insertedRows: unknown[][] = [];
  const builder = {
    from: vi.fn(() => builder),
    insert: vi.fn(async (rows: unknown[]) => {
      insertedRows.push(rows);
      return { error: null };
    }),
  };
  return { client: builder as never as import("@supabase/supabase-js").SupabaseClient, insertedRows };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertBalanced — the fundamental invariant", () => {
  it("accepts a simple balanced single-currency transaction", () => {
    const legs: LedgerLeg[] = [
      { account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 10000, currency: "USDC" },
      { account: "SUPPLIER_PAYABLE", accountRef: 5, direction: "credit", amountMinor: 10000, currency: "USDC" },
    ];
    expect(() => assertBalanced(legs)).not.toThrow();
  });

  it("accepts a multi-currency transaction where EACH currency nets to zero independently", () => {
    const legs: LedgerLeg[] = [
      { account: "FX_CLEARING", direction: "debit", amountMinor: 500000, currency: "NGN" },
      { account: "EXTERNAL_NGN_BUYER", direction: "credit", amountMinor: 500000, currency: "NGN" },
      { account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 32000, currency: "USDC" },
      { account: "FX_CLEARING", direction: "credit", amountMinor: 32000, currency: "USDC" },
    ];
    expect(() => assertBalanced(legs)).not.toThrow();
  });

  it("rejects a transaction where NGN debits and credits don't match, even if USDC balances", () => {
    const legs: LedgerLeg[] = [
      { account: "FX_CLEARING", direction: "debit", amountMinor: 500000, currency: "NGN" },
      { account: "EXTERNAL_NGN_BUYER", direction: "credit", amountMinor: 499000, currency: "NGN" }, // off by 1000
      { account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 32000, currency: "USDC" },
      { account: "FX_CLEARING", direction: "credit", amountMinor: 32000, currency: "USDC" },
    ];
    expect(() => assertBalanced(legs)).toThrow(UnbalancedLedgerTransactionError);
  });

  it("rejects a transaction that's short one leg entirely", () => {
    const legs: LedgerLeg[] = [{ account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 10000, currency: "USDC" }];
    expect(() => assertBalanced(legs)).toThrow(UnbalancedLedgerTransactionError);
  });

  it("rejects a non-positive leg amount", () => {
    const legs: LedgerLeg[] = [
      { account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 0, currency: "USDC" },
      { account: "SUPPLIER_PAYABLE", accountRef: 5, direction: "credit", amountMinor: 0, currency: "USDC" },
    ];
    expect(() => assertBalanced(legs)).toThrow();
  });

  it("rejects an empty transaction", () => {
    expect(() => assertBalanced([])).toThrow();
  });
});

describe("writeLedgerTransaction — the DB call never happens for unbalanced input", () => {
  it("throws before calling supabase.from().insert() at all", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    const legs: LedgerLeg[] = [{ account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 100, currency: "USDC" }];
    await expect(writeLedgerTransaction(client, 1, legs)).rejects.toThrow(UnbalancedLedgerTransactionError);
    expect(insertedRows).toHaveLength(0);
  });

  it("writes every leg under one shared ledger_transaction_id when balanced", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    const legs: LedgerLeg[] = [
      { account: "ESCROW_WALLET_USDC", direction: "debit", amountMinor: 10000, currency: "USDC" },
      { account: "SUPPLIER_PAYABLE", accountRef: 5, direction: "credit", amountMinor: 10000, currency: "USDC" },
    ];
    const txnId = await writeLedgerTransaction(client, 42, legs);

    expect(insertedRows).toHaveLength(1);
    const rows = insertedRows[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.ledger_transaction_id === txnId)).toBe(true);
    expect(rows.every((r) => r.order_id === 42)).toBe(true);
    expect(rows[1]!.account_ref).toBe(5); // length just asserted above
  });
});

describe("the four order-lifecycle ledger events — each balances on its own", () => {
  it("recordFundingConfirmed balances NGN-in against USDC-into-escrow", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    await recordFundingConfirmed(client, 1, 500000, 32000);
    const rows = insertedRows[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(4);
    // Same invariant the DB trigger enforces, re-checked here on the
    // actual rows this function produced.
    const ngn = rows.filter((r) => r.currency === "NGN");
    const usdc = rows.filter((r) => r.currency === "USDC");
    expect(sum(ngn, "debit")).toBe(sum(ngn, "credit"));
    expect(sum(usdc, "debit")).toBe(sum(usdc, "credit"));
  });

  it("recordEscrowRelease balances supplier payable + platform fee, USDC only", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    await recordEscrowRelease(client, 1, 5, 30000, 2000);
    const rows = insertedRows[0] as Array<Record<string, unknown>>;
    expect(rows.every((r) => r.currency === "USDC")).toBe(true);
    expect(sum(rows, "debit")).toBe(sum(rows, "credit"));
    expect(sum(rows, "debit")).toBe(32000);
  });

  it("recordSettlement balances the payable clearing against the NGN payout", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    await recordSettlement(client, 1, 5, 30000, 470000);
    const rows = insertedRows[0] as Array<Record<string, unknown>>;
    const ngn = rows.filter((r) => r.currency === "NGN");
    const usdc = rows.filter((r) => r.currency === "USDC");
    expect(sum(ngn, "debit")).toBe(sum(ngn, "credit"));
    expect(sum(usdc, "debit")).toBe(sum(usdc, "credit"));
  });

  it("recordRefundFromEscrow balances the full reversal of a pre-release funding leg", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    await recordRefundFromEscrow(client, 1, 500000, 32000);
    const rows = insertedRows[0] as Array<Record<string, unknown>>;
    const ngn = rows.filter((r) => r.currency === "NGN");
    const usdc = rows.filter((r) => r.currency === "USDC");
    expect(sum(ngn, "debit")).toBe(sum(ngn, "credit"));
    expect(sum(usdc, "debit")).toBe(sum(usdc, "credit"));
  });

  it("a full happy-path order (fund -> release -> settle), zero platform fee and no FX spread, nets every touched account to exactly zero", async () => {
    // Fee = 0 and matched rates isolate the property that should ALWAYS
    // hold regardless of fee/spread (see the two tests below for that):
    // every NGN/USDC unit that entered escrow/FX_CLEARING also left it.
    // With a nonzero fee, FX_CLEARING:NGN is EXPECTED to carry a residual
    // (the fee's un-off-ramped NGN-equivalent) — see recordSettlement's
    // doc comment in lib/ledger.ts. That's not tested here to keep this
    // test's expectations unambiguous; it's covered by the next test.
    const { client, insertedRows } = mockSupabaseInsert();
    await recordFundingConfirmed(client, 1, 500000, 32000);
    await recordEscrowRelease(client, 1, 5, 32000, 0);
    await recordSettlement(client, 1, 5, 32000, 500000);

    const byAccount = netByAccount(insertedRows);
    expect(byAccount.get("FX_CLEARING:NGN")).toBe(0);
    expect(byAccount.get("FX_CLEARING:USDC")).toBe(0);
    expect(byAccount.get("ESCROW_WALLET_USDC:USDC")).toBe(0);
    expect(byAccount.get("SUPPLIER_PAYABLE:USDC")).toBe(0);
  });

  it("ESCROW_WALLET_USDC and SUPPLIER_PAYABLE net to zero across the lifecycle EVEN WITH a nonzero platform fee", async () => {
    // These two hold unconditionally, by construction: recordEscrowRelease
    // always credits ESCROW_WALLET_USDC by exactly
    // (supplierAmount + platformFee), matching what recordFundingConfirmed
    // debited into it — the fee doesn't change that. Same for
    // SUPPLIER_PAYABLE: release debits it, settlement credits it back by
    // the same amount.
    const { client, insertedRows } = mockSupabaseInsert();
    await recordFundingConfirmed(client, 1, 500000, 32000);
    await recordEscrowRelease(client, 1, 5, 30000, 2000); // fee = 2000
    await recordSettlement(client, 1, 5, 30000, 470000);

    const byAccount = netByAccount(insertedRows);
    expect(byAccount.get("ESCROW_WALLET_USDC:USDC")).toBe(0);
    expect(byAccount.get("SUPPLIER_PAYABLE:USDC")).toBe(0);
    // The documented exception: FX_CLEARING:NGN carries the fee's
    // NGN-equivalent as a residual (500000 funded in, only 470000 paid
    // back out via settlement — the other 20000 corresponds to the
    // 2000 USDC fee never converted back to NGN).
    expect(byAccount.get("FX_CLEARING:NGN")).toBe(30000);
  });

  it("recordFundingConfirmed followed by a full recordRefundFromEscrow nets every touched account back to zero", async () => {
    const { client, insertedRows } = mockSupabaseInsert();
    await recordFundingConfirmed(client, 1, 500000, 32000);
    await recordRefundFromEscrow(client, 1, 500000, 32000);

    const byAccount = netByAccount(insertedRows);
    expect(byAccount.get("FX_CLEARING:NGN")).toBe(0);
    expect(byAccount.get("FX_CLEARING:USDC")).toBe(0);
    expect(byAccount.get("ESCROW_WALLET_USDC:USDC")).toBe(0);
    expect(byAccount.get("EXTERNAL_NGN_BUYER:NGN")).toBe(0);
  });
});

/** Cumulative (debit-positive, credit-negative) balance per account+currency
 * across every ledger transaction written so far — the system-wide version
 * of the invariant, distinct from the per-transaction one the DB trigger
 * checks. */
function netByAccount(insertedRows: unknown[][]): Map<string, number> {
  const allRows = insertedRows.flat() as Array<Record<string, unknown>>;
  const byAccount = new Map<string, number>();
  for (const row of allRows) {
    const key = `${row.account}:${row.currency}`;
    const signed = row.direction === "debit" ? Number(row.amount_minor) : -Number(row.amount_minor);
    byAccount.set(key, (byAccount.get(key) ?? 0) + signed);
  }
  return byAccount;
}

function sum(rows: Array<Record<string, unknown>>, direction: "debit" | "credit"): number {
  return rows.filter((r) => r.direction === direction).reduce((total, r) => total + Number(r.amount_minor), 0);
}
