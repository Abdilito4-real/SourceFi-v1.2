// app/api/orders/[id]/timeline/route.ts
//
// Cross-cutting requirement: "Timeline on the request shows every
// transition so both parties see the same history." Merges
// order_status_history, payment_events, and dispute_events into one
// ordered feed (see getOrderTimeline), same ownership check every other
// order route in this app already does, not a new pattern.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getOrderTimeline } from "../../../../../lib/orderService";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { data: order } = await supabase.from("orders").select("buyer_id, supplier_id").eq("id", orderId).maybeSingle();
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  if (auth.user.role !== "admin") {
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
