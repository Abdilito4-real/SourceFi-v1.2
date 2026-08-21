// app/api/orders/route.ts
//
// Supersedes app/api/requests/route.ts. POST creates an order directly
// against a specific, currently-verified supplier, no claim/fee-naming
// step (design doc Section 0). GET lists orders scoped by role: buyers
// see their own, suppliers see orders assigned to them, admins see
// everything, same row-level-visibility-in-application-code posture
// requests/route.ts already used (RLS is a default-deny backstop, not
// the real gate, since this app always talks to Supabase as
// service_role).
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { getUserScopedOrFallbackClient } from "../../../lib/supabaseUserClient";
import { requireSession, requireRole } from "../../../lib/authz";
import { toMinorUnits, MIN_ORDER_AMOUNT_MINOR, formatMoney } from "../../../lib/money";
import { createOrder, SupplierNotCurrentlyVerifiedError, InvalidOrderAmountError } from "../../../lib/orderService";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";
import type { OrderRow } from "../../../lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Joins buyer_email/supplier_business_name in server-side, same pattern
 * app/api/requests/route.ts used for buyer_email/sourcer_email. */
async function attachJoins(supabase: SupabaseClient, rows: OrderRow[]): Promise<OrderRow[]> {
  if (rows.length === 0) return rows;

  const buyerIds = Array.from(new Set(rows.map((r) => r.buyer_id)));
  const supplierIds = Array.from(new Set(rows.map((r) => r.supplier_id)));

  const [{ data: buyers }, { data: suppliers }] = await Promise.all([
    supabase.from("users").select("id, email").in("id", buyerIds),
    supabase.from("supplier_profiles").select("id, business_name").in("id", supplierIds),
  ]);

  const emailByBuyerId = new Map((buyers || []).map((u) => [u.id, u.email]));
  const nameBySupplierId = new Map((suppliers || []).map((s) => [s.id, s.business_name]));

  return rows.map((r) => ({
    ...r,
    buyer_email: emailByBuyerId.get(r.buyer_id) ?? null,
    supplier_business_name: nameBySupplierId.get(r.supplier_id) ?? null,
  }));
}

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = getSupabaseServerClient();
  // Real RLS pilot (migration 0017_orders_rls_pilot.sql): buyer/supplier
  // reads run through a genuine `authenticated`-role client so the DB's
  // own orders_select_own policy is a second, independent layer behind
  // the .eq() filter below, not just a schema decoration — see
  // lib/supabaseUserClient.ts. The .eq() filters STAY, deliberately
  // redundant, same "two independent layers" posture as
  // lib/ledger.ts's assertBalanced + its DB trigger. Admin keeps using
  // the plain service-role client, unchanged: admin's "no filter, full
  // oversight" is an intentional design choice, not something RLS
  // should also gate.
  const readClient = auth.user.role === "admin" ? supabase : await getUserScopedOrFallbackClient(auth.user.id);
  let query = readClient.from("orders").select("*").order("created_at", { ascending: false });

  if (auth.user.role === "buyer") {
    query = query.eq("buyer_id", auth.user.id);
  } else if (auth.user.role === "supplier") {
    const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
    query = query.eq("supplier_id", profile?.id ?? -1);
  }
  // admin: no filter, full oversight, per design doc Section G.

  const { data, error } = await query;
  if (error) return dbErrorResponse("GET orders", error);

  // attachJoins always uses the service-role client, not readClient:
  // it reads `users`/`supplier_profiles` for display fields only, and
  // this pilot's new supplier_profiles_select_own policy is self-only,
  // it would not return another party's business_name/email under the
  // authenticated client. Those joins were never the security boundary
  // here, `orders` itself is, so keeping them on service-role is
  // correct, not a gap.
  let orders = await attachJoins(supabase, (data || []) as OrderRow[]);
  // The verification call is a private, two-party conversation, admin's
  // full-oversight view of every order (no row filter above) should not
  // include the real room id for orders admin isn't a party to. Buyers
  // and suppliers are already scoped to their own orders by the query
  // above, so this only ever redacts something for admin.
  if (auth.user.role === "admin") {
    orders = orders.map((o) => ({ ...o, verification_call_room_id: null }));
  }
  return Response.json({ orders });
}

export async function POST(request: Request) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  const supplierId = Number(body?.supplierId);
  const supplierListingId = body?.supplierListingId != null ? Number(body.supplierListingId) : null;
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const quantity = typeof body?.quantity === "string" ? body.quantity.trim() || null : null;
  const deliveryLocation = typeof body?.deliveryLocation === "string" ? body.deliveryLocation.trim() : "";

  if (!Number.isInteger(supplierId)) {
    return Response.json({ error: "A valid supplierId is required." }, { status: 400 });
  }
  if (!title || !deliveryLocation) {
    return Response.json({ error: "Title and delivery location are required." }, { status: 400 });
  }

  let amountMinor: number;
  try {
    amountMinor = toMinorUnits(body?.amount);
  } catch {
    return Response.json({ error: "A valid, non-negative order amount is required." }, { status: 400 });
  }
  if (amountMinor <= 0) {
    return Response.json({ error: "Order amount must be greater than zero." }, { status: 400 });
  }
  if (amountMinor < MIN_ORDER_AMOUNT_MINOR) {
    return Response.json(
      { error: `Order amount must be at least ${formatMoney(MIN_ORDER_AMOUNT_MINOR, "NGN")}.` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();

  try {
    const order = await createOrder(supabase, auth.user.id, {
      supplierId,
      supplierListingId,
      title,
      description,
      quantity,
      deliveryLocation,
      amountMinor,
    });
    return Response.json({ order: { ...order, buyer_email: auth.user.email } });
  } catch (err) {
    if (err instanceof SupplierNotCurrentlyVerifiedError) {
      return Response.json({ error: "This supplier is not currently verified and cannot receive new orders." }, { status: 409 });
    }
    if (err instanceof InvalidOrderAmountError) {
      return Response.json(
        { error: `Order amount must be at least ${formatMoney(MIN_ORDER_AMOUNT_MINOR, "NGN")}.` },
        { status: 400 }
      );
    }
    // Not a known, clean custom error class at this point, could be a
    // raw Postgres error bubbling up from lib/orderService.ts's `throw
    // error` on an unexpected DB failure. Sanitize rather than trust it.
    return dbErrorResponse("POST orders (createOrder)", err instanceof Error ? err : new Error(String(err)));
  }
}
