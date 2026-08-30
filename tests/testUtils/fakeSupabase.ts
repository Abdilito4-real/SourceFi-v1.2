// tests/testUtils/fakeSupabase.ts
//
// A minimal in-memory stand-in for the exact subset of supabase-js's
// query builder lib/orderService.ts, lib/ledger.ts, and
// lib/supplierVerification.ts actually use: .from(table).select().eq()/
// .in().maybeSingle()/.single(), .insert(row|rows) (awaitable directly,
// AND chainable with .select().single()/.maybeSingle()), .update(patch)
// with the same two shapes, and .rpc(name, args). Not a general
// supabase-js mock, just faithful enough to this codebase's actual call
// patterns to let lib/orderService.ts run against something real without
// a live database.
//
// Prompt 3 additions: .gte()/.order().limit() (getOrderTimeline,
// handleRefundConfirmed's "most recent cancellation" lookup) and
// .select(cols, {count, head}) (lib/notifications/dispatch.ts's rate
// limit check), same "extend as real call patterns grow" posture the
// header above already states.
export type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[] = [];
  nextId = 1;
}

type Filter = (row: Row) => boolean;

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: null; count?: number }> {
  private filters: Filter[] = [];
  private pendingInsert: Row[] | null = null;
  private pendingUpdatePatch: Row | null = null;
  private wantsSelect = false;
  private wantsCount = false;
  private isHeadOnly = false;
  private sortKey: string | null = null;
  private sortAscending = true;
  private limitN: number | null = null;

  constructor(private readonly table: FakeTable, private readonly kind: "select" | "insert" | "update" | "delete", payload?: Row | Row[]) {
    if (kind === "insert") this.pendingInsert = Array.isArray(payload) ? payload : [payload as Row];
    if (kind === "update") this.pendingUpdatePatch = payload as Row;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  in(key: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  gt(key: string, value: unknown): this {
    this.filters.push((row) => (row[key] as string) > (value as string));
    return this;
  }

  gte(key: string, value: unknown): this {
    this.filters.push((row) => (row[key] as string) >= (value as string));
    return this;
  }

  lt(key: string, value: unknown): this {
    this.filters.push((row) => (row[key] as number) < (value as number));
    return this;
  }

  not(key: string, operator: string, value: unknown): this {
    // Only the shape this codebase actually uses: .not(col, "is", null).
    if (operator === "is" && value === null) {
      this.filters.push((row) => (row[key] ?? null) !== null);
    }
    return this;
  }

  is(key: string, value: null): this {
    this.filters.push((row) => (row[key] ?? null) === value);
    return this;
  }

  select(_cols?: string, options?: { count?: "exact"; head?: boolean }): this {
    this.wantsSelect = true;
    if (options?.count) this.wantsCount = true;
    if (options?.head) this.isHeadOnly = true;
    return this;
  }

  order(key: string, options?: { ascending?: boolean }): this {
    this.sortKey = key;
    this.sortAscending = options?.ascending !== false;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private matches(): Row[] {
    let rows = this.table.rows.filter((row) => this.filters.every((f) => f(row)));
    if (this.sortKey) {
      const key = this.sortKey;
      rows = [...rows].sort((a, b) => {
        const av = a[key] as string | number;
        const bv = b[key] as string | number;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.sortAscending ? cmp : -cmp;
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return rows;
  }

  private runInsert(): { data: Row[]; error: null } {
    const inserted = (this.pendingInsert || []).map((r) => {
      const row: Row = { id: this.table.nextId++, ...r };
      this.table.rows.push(row);
      return { ...row };
    });
    return { data: inserted, error: null };
  }

  private runUpdate(): { data: Row[]; error: null } {
    const matched = this.matches();
    for (const row of matched) {
      Object.assign(row, this.pendingUpdatePatch);
    }
    return { data: matched.map((r) => ({ ...r })), error: null };
  }

  private runDelete(): { data: Row[]; error: null } {
    const matched = this.matches();
    const matchedIds = new Set(matched.map((r) => r.id));
    this.table.rows = this.table.rows.filter((r) => !matchedIds.has(r.id));
    return { data: matched.map((r) => ({ ...r })), error: null };
  }

  private runSelect(): { data: Row[]; error: null; count?: number } {
    const matched = this.matches();
    const result: { data: Row[]; error: null; count?: number } = {
      data: this.isHeadOnly ? [] : matched.map((r) => ({ ...r })),
      error: null,
    };
    if (this.wantsCount) result.count = matched.length;
    return result;
  }

  private run(): { data: Row[]; error: null; count?: number } {
    if (this.kind === "insert") return this.runInsert();
    if (this.kind === "update") return this.runUpdate();
    if (this.kind === "delete") return this.runDelete();
    return this.runSelect();
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const { data, error } = this.run();
    return { data: data[0] ?? null, error };
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    return this.maybeSingle();
  }

  // Makes `await supabase.from(x).insert(y)` (no .select()) work exactly
  // like real supabase-js, resolving directly to {data, error} without
  // needing an explicit .then() call site.
  then<TResult1 = { data: unknown; error: null; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const result = this.run();
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

export class FakeSupabase {
  private tables = new Map<string, FakeTable>();
  private rpcHandlers = new Map<string, (args: Record<string, unknown>) => unknown>();

  private table(name: string): FakeTable {
    if (!this.tables.has(name)) this.tables.set(name, new FakeTable());
    return this.tables.get(name)!;
  }

  /** Seed a table with rows for a test's starting state. Auto-increments
   * `id` for any row that doesn't specify one, matching Postgres identity
   * columns closely enough for these tests. */
  seed(name: string, rows: Row[]): this {
    const table = this.table(name);
    for (const r of rows) {
      const row = { id: table.nextId, ...r };
      table.nextId = Math.max(table.nextId + 1, (row.id as number) + 1);
      table.rows.push(row);
    }
    return this;
  }

  getRows(name: string): Row[] {
    return this.table(name).rows.map((r) => ({ ...r }));
  }

  /** Live (not copied) reference to a table's rows, for setRpc handlers
   * that need to atomically read-and-mutate current state synchronously.
   * getRows() above returns copies, deliberately, for the common
   * read-only case (e.g. is_supplier_currently_verified's mock); a
   * FakeQueryBuilder .update() can't be used from inside a handler
   * instead, since its actual row mutation only runs when something
   * awaits/thens it, and setRpc's handler signature is synchronous.
   * First real use: wireWalletRpcs below (migration 0020's wallet_credit/
   * wallet_debit). */
  getMutableRows(name: string): Row[] {
    return this.table(name).rows;
  }

  setRpc(name: string, handler: (args: Record<string, unknown>) => unknown): this {
    this.rpcHandlers.set(name, handler);
    return this;
  }

  from(name: string) {
    const table = this.table(name);
    return {
      select: (cols?: string, options?: { count?: "exact"; head?: boolean }) => new FakeQueryBuilder(table, "select").select(cols, options),
      insert: (payload: Row | Row[]) => new FakeQueryBuilder(table, "insert", payload),
      update: (payload: Row) => new FakeQueryBuilder(table, "update", payload),
      delete: () => new FakeQueryBuilder(table, "delete"),
    };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
    const handler = this.rpcHandlers.get(name);
    return { data: handler ? handler(args) : null, error: null };
  }
}

/** Wires wallet_credit/wallet_debit (migration 0020_buyer_wallet.sql)
 * against this fake's OWN buyer_wallets rows (via getMutableRows, so a
 * balance seeded with .seed("buyer_wallets", [...]) and a balance
 * mutated by these RPCs stay the same single source of truth) — a plain
 * JS mirror of the real Postgres functions' logic. Same honest
 * limitation tests/rateLimit.test.ts's own RPC mocks state: this proves
 * the call-shape contract and the application-level guard
 * (InsufficientWalletBalanceError), not that the real functions'
 * `select ... for update` row-locking is race-free under true
 * concurrent connections — that guarantee comes from Postgres itself.
 * wallet_debit signals insufficient balance by THROWING (matching the
 * real function's `raise exception`), which is also the only way this
 * fixture's own .rpc() can simulate an RPC failure at all, since it
 * never sets {error} itself (see FakeSupabase.rpc() above) — a thrown
 * handler exception is what propagates out of `await supabase.rpc(...)`
 * as a real JS exception instead. Shared across every test file that
 * exercises fundOrder/wallet flows (tests/walletService.test.ts,
 * tests/orderService.test.ts, tests/adversarial.test.ts,
 * tests/terminationFlows.test.ts) rather than four separate copies. */
export function wireWalletRpcs(fake: FakeSupabase) {
  function getOrCreateWalletRow(userId: number): Row {
    const rows = fake.getMutableRows("buyer_wallets");
    let row = rows.find((r) => r.user_id === userId);
    if (!row) {
      row = { user_id: userId, balance_minor: 0, currency: "NGN", updated_at: new Date().toISOString() };
      rows.push(row);
    }
    return row;
  }

  fake.setRpc("wallet_credit", (args) => {
    const row = getOrCreateWalletRow(args.p_user_id as number);
    row.balance_minor = (row.balance_minor as number) + (args.p_amount_minor as number);
    return row.balance_minor;
  });

  fake.setRpc("wallet_debit", (args) => {
    const row = getOrCreateWalletRow(args.p_user_id as number);
    const balance = row.balance_minor as number;
    const amount = args.p_amount_minor as number;
    if (balance < amount) {
      throw new Error(`insufficient_wallet_balance: balance ${balance} is less than requested debit ${amount}`);
    }
    row.balance_minor = balance - amount;
    return row.balance_minor;
  });
}

/** Cast-to-SupabaseClient escape hatch, this fake deliberately doesn't
 * implement the full supabase-js surface, only what this codebase uses.
 * Returns the real SupabaseClient type (not `never`) so call sites can
 * both pass it to functions typed against SupabaseClient AND call
 * `.from()`/`.rpc()` on it directly within a test. */
export function asSupabaseClient(fake: FakeSupabase): import("@supabase/supabase-js").SupabaseClient {
  return fake as unknown as import("@supabase/supabase-js").SupabaseClient;
}
