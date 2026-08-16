// tests/testUtils/fakeSupabase.ts
//
// A minimal in-memory stand-in for the exact subset of supabase-js's
// query builder lib/orderService.ts, lib/ledger.ts, and
// lib/supplierVerification.ts actually use: .from(table).select().eq()/
// .in().maybeSingle()/.single(), .insert(row|rows) (awaitable directly,
// AND chainable with .select().single()/.maybeSingle()), .update(patch)
// with the same two shapes, and .rpc(name, args). Not a general
// supabase-js mock — just faithful enough to this codebase's actual call
// patterns to let lib/orderService.ts run against something real without
// a live database.
type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[] = [];
  nextId = 1;
}

type Filter = (row: Row) => boolean;

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Filter[] = [];
  private pendingInsert: Row[] | null = null;
  private pendingUpdatePatch: Row | null = null;
  private wantsSelect = false;

  constructor(private readonly table: FakeTable, private readonly kind: "select" | "insert" | "update", payload?: Row | Row[]) {
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

  lt(key: string, value: unknown): this {
    this.filters.push((row) => (row[key] as number) < (value as number));
    return this;
  }

  is(key: string, value: null): this {
    this.filters.push((row) => (row[key] ?? null) === value);
    return this;
  }

  select(_cols?: string): this {
    this.wantsSelect = true;
    return this;
  }

  order(): this {
    return this;
  }

  private matches(): Row[] {
    return this.table.rows.filter((row) => this.filters.every((f) => f(row)));
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

  private runSelect(): { data: Row[]; error: null } {
    return { data: this.matches().map((r) => ({ ...r })), error: null };
  }

  private run(): { data: Row[]; error: null } {
    if (this.kind === "insert") return this.runInsert();
    if (this.kind === "update") return this.runUpdate();
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
  // like real supabase-js — resolving directly to {data, error} without
  // needing an explicit .then() call site.
  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
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

  setRpc(name: string, handler: (args: Record<string, unknown>) => unknown): this {
    this.rpcHandlers.set(name, handler);
    return this;
  }

  from(name: string) {
    const table = this.table(name);
    return {
      select: (cols?: string) => new FakeQueryBuilder(table, "select").select(cols),
      insert: (payload: Row | Row[]) => new FakeQueryBuilder(table, "insert", payload),
      update: (payload: Row) => new FakeQueryBuilder(table, "update", payload),
    };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
    const handler = this.rpcHandlers.get(name);
    return { data: handler ? handler(args) : null, error: null };
  }
}

/** Cast-to-SupabaseClient escape hatch — this fake deliberately doesn't
 * implement the full supabase-js surface, only what this codebase uses.
 * Returns the real SupabaseClient type (not `never`) so call sites can
 * both pass it to functions typed against SupabaseClient AND call
 * `.from()`/`.rpc()` on it directly within a test. */
export function asSupabaseClient(fake: FakeSupabase): import("@supabase/supabase-js").SupabaseClient {
  return fake as unknown as import("@supabase/supabase-js").SupabaseClient;
}
