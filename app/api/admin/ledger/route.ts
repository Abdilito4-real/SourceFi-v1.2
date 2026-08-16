// app/api/admin/ledger/route.ts
//
// Read-only admin visibility into the double-entry ledger (design doc
// Section C.6) — nothing writes here, this route only reads. Returns the
// most recent entries (joined with order_code for context) plus a net
// balance per account+currency, computed by summing every entry ever
// written. That system-wide balance is the same property
// tests/ledger.test.ts's "full happy-path order... nets every touched
// account to zero" test checks in isolation — this is the live version
// of that check, for whatever data actually exists.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";

export async function GET(request: Request) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const limitParam = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500 ? limitParam : 100;

  const supabase = getSupabaseServerClient();

  const { data: entries, error } = await supabase
    .from("ledger_entries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const orderIds = Array.from(new Set((entries || []).map((e) => e.order_id)));
  const { data: orders } =
    orderIds.length > 0 ? await supabase.from("orders").select("id, order_code").in("id", orderIds) : { data: [] as { id: number; order_code: string }[] };
  const orderCodeById = new Map((orders || []).map((o) => [o.id, o.order_code]));

  const entriesWithOrder = (entries || []).map((e) => ({ ...e, order_code: orderCodeById.get(e.order_id) ?? null }));

  // Net balance per account+currency across EVERY entry ever written, not
  // just this page — the invariant worth watching isn't "do the last 100
  // rows balance", it's "does the whole ledger still balance."
  const { data: allEntries, error: allErr } = await supabase.from("ledger_entries").select("account, currency, direction, amount_minor");
  if (allErr) return Response.json({ error: allErr.message }, { status: 500 });

  const balances = new Map<string, { account: string; currency: string; net_minor: number }>();
  for (const e of allEntries || []) {
    const key = `${e.account}:${e.currency}`;
    const bucket = balances.get(key) ?? { account: e.account, currency: e.currency, net_minor: 0 };
    bucket.net_minor += e.direction === "debit" ? e.amount_minor : -e.amount_minor;
    balances.set(key, bucket);
  }

  return Response.json({
    entries: entriesWithOrder,
    balances: Array.from(balances.values()).sort((a, b) => a.account.localeCompare(b.account) || a.currency.localeCompare(b.currency)),
  });
}
