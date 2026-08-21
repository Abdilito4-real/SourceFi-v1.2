// app/api/orders/[id]/timeline/route.ts
//
// Cross-cutting requirement: "Timeline on the request shows every
// transition so both parties see the same history." Merges
// order_status_history, payment_events, and dispute_events into one
// ordered feed (see getOrderTimeline), same ownership check every other
// order route in this app already does, not a new pattern.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { getUserScopedOrFallbackClient } from "../../../../../lib/supabaseUserClient";
import { requireRole } from "../../../../../lib/authz";
import { getOrderTimeline } from "../../../../../lib/orderService";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  // Real RLS pilot (migration 0017_orders_rls_pilot.sql), same pattern
  // as app/api/orders/[id]/route.ts: only this ownership-determining
  // fetch uses the authenticated-role client, getOrderTimeline below
  // keeps using service-role for its own table reads.
  const readClient = auth.user.role === "admin" ? supabase : await getUserScopedOrFallbackClient(auth.user.id);
  const { data: order } = await readClient.from("orders").select("buyer_id, supplier_id").eq("id", orderId).maybeSingle();
  // Same 403->404 note as app/api/orders/[id]/route.ts: once RLS is
  // active, a cross-tenant order id is invisible, not just rejected,
  // so this "not found" now also covers "not yours" for buyer/supplier.
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  if (auth.user.role !== "admin") {
    // Kept as a deliberate second, redundant check, see the equivalent
    // comment in app/api/orders/[id]/route.ts.
    const isBuyer = order.buyer_id === auth.user.id;
    let isSupplier = false;
    if (!isBuyer) {
      const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
      isSupplier = Boolean(profile && profile.id === order.supplier_id);
    }
    if (!isBuyer && !isSupplier) return Response.json({ error: "You are not a party to this order." }, { status: 403 });
  }

  const timeline = await getOrderTimeline(supabase, orderId);
  return Response.json({ timeline });
}
