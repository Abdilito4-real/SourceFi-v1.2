// app/api/admin/ledger/route.ts
//
// Read-only admin visibility into the double-entry ledger (design doc
// Section C.6), nothing writes here, this route only reads. Returns the
// most recent entries (joined with order_code for context) plus a net
// balance per account+currency, computed by summing every entry ever
// written. That system-wide balance is the same property
// tests/ledger.test.ts's "full happy-path order... nets every touched
// account to zero" test checks in isolation, this is the live version
// of that check, for whatever data actually exists.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";
import { dbErrorResponse } from "../../../../lib/dbErrorResponse";

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
  if (error) return dbErrorResponse("GET admin/ledger entries", error);

  const orderIds = Array.from(new Set((entries || []).map((e) => e.order_id)));
  const { data: orders } =
    orderIds.length > 0 ? await supabase.from("orders").select("id, order_code").in("id", orderIds) : { data: [] as { id: number; order_code: string }[] };
  const orderCodeById = new Map((orders || []).map((o) => [o.id, o.order_code]));

  const entriesWithOrder = (entries || []).map((e) => ({ ...e, order_code: orderCodeById.get(e.order_id) ?? null }));

  // Surfaced so an admin sees "this release failed and why" without
  // digging through server logs — reportOutcome (lib/circleEscrowProvider.ts)
  // used to only console.error a terminal FAILED/CANCELLED/DENIED
  // outcome, this is the queryable trail that fix now leaves behind.
  const { data: failedReleaseEvents, error: failedErr } = await supabase
    .from("payment_events")
    .select("order_id, provider_state, raw_payload, created_at")
    .eq("leg", "release")
    .eq("event_type", "release_failed")
    .order("created_at", { ascending: false })
    .limit(20);
  if (failedErr) return dbErrorResponse("GET admin/ledger failed releases", failedErr);

  const failedOrderIds = Array.from(new Set((failedReleaseEvents || []).map((e) => e.order_id)));
  const { data: failedOrders } =
    failedOrderIds.length > 0
      ? await supabase.from("orders").select("id, order_code, status").in("id", failedOrderIds)
      : { data: [] as { id: number; order_code: string; status: string }[] };
  const failedOrderById = new Map((failedOrders || []).map((o) => [o.id, o]));

  const failedReleases = (failedReleaseEvents || []).map((e) => {
    const order = failedOrderById.get(e.order_id);
    const payload = e.raw_payload as { errorReason?: string | null } | null;
    return {
      orderId: e.order_id,
      orderCode: order?.order_code ?? null,
      // Whether this one still needs a retry, or a later attempt already
      // moved the order past release_submitted/release_processing.
      stillStuck: order?.status === "release_submitted" || order?.status === "release_processing",
      providerState: e.provider_state,
      errorReason: payload?.errorReason ?? null,
      createdAt: e.created_at,
    };
  });

  // Net balance per account+currency across EVERY entry ever written, not
  // just this page, the invariant worth watching isn't "do the last 100
  // rows balance", it's "does the whole ledger still balance."
  const { data: allEntries, error: allErr } = await supabase.from("ledger_entries").select("account, currency, direction, amount_minor");
  if (allErr) return dbErrorResponse("GET admin/ledger balances", allErr);

  const balances = new Map<string, { account: string; currency: string; net_minor: number }>();
  for (const e of allEntries || []) {
    const key = `${e.account}:${e.currency}`;
    const bucket = balances.get(key) ?? { account: e.account, currency: e.currency, net_minor: 0 };
    bucket.net_minor += e.direction === "debit" ? e.amount_minor : -e.amount_minor;
    balances.set(key, bucket);
  }

  // NGN legs (Yellow Card, bank-transfer only) go real once both its env
  // vars are set. USDC escrow release only goes live once all three
  // Circle env vars are set. Same checks getPaymentProvider() uses,
  // duplicated here rather than imported since that module also
  // constructs a singleton client this read-only route has no reason to
  // touch.
  const circleConfigured = Boolean(process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET && process.env.ESCROW_WALLET_ID);
  const yellowCardConfigured = Boolean(process.env.YELLOW_CARD_API_KEY && process.env.YELLOW_CARD_SECRET_KEY);

  return Response.json({
    entries: entriesWithOrder,
    balances: Array.from(balances.values()).sort((a, b) => a.account.localeCompare(b.account) || a.currency.localeCompare(b.currency)),
    paymentMode: { ngnLive: yellowCardConfigured, usdcLive: circleConfigured },
    failedReleases,
  });
}
