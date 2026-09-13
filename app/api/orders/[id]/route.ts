// app/api/orders/[id]/route.ts
//
// Single order detail, ownership-checked (buyer who placed it, the
// assigned supplier, or any admin for oversight). Also returns the
// order's payment_events trail and any delivery_proofs/disputes/rating
// so the detail screen doesn't need N separate requests.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { getUserScopedOrFallbackClient } from "../../../../lib/supabaseUserClient";
import { requireSession } from "../../../../lib/authz";
import { ensureCallRoomId } from "../../../../lib/orderService";
import { dbErrorResponse } from "../../../../lib/dbErrorResponse";
import { buildJaasCallConfig } from "../../../../lib/jaasAuth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  // Real RLS pilot (0017_orders_rls_pilot.sql, expanded by
  // 0021_rls_expand_pilot.sql): buyer/supplier fetch this order and its
  // order_id-scoped children (payment_events, delivery_proofs,
  // disputes, ratings, below) through a genuine `authenticated`-role
  // client, see lib/supabaseUserClient.ts and app/api/orders/route.ts's
  // own comment for the full reasoning. `users`/`supplier_profiles`
  // (for the OTHER party's public info) and `supplier_listings` stay on
  // the plain service-role `supabase` client below — they're not
  // self-only lookups (a buyer legitimately reads the supplier's row
  // here, and vice versa), so an own-row RLS policy wouldn't fit them
  // anyway.
  const readClient = auth.user.role === "admin" ? supabase : await getUserScopedOrFallbackClient(auth.user.id);
  const { data: order, error } = await readClient.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (error) return dbErrorResponse(`GET orders/${orderId}`, error);
  // Real behavior change from this pilot, worth naming explicitly: once
  // the RLS policy above is active, a cross-tenant order id is
  // genuinely invisible to a buyer/supplier who isn't a party to it —
  // this 404 now covers BOTH "no such order" and "not yours" for them,
  // where it used to be a distinct 403 below. Arguably a security
  // improvement (doesn't confirm an order id exists to someone who
  // doesn't own it), but a real, intentional response-shape change.
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  // Kept as a deliberate second, redundant check even though RLS above
  // should already make a mismatched row unreachable for buyer/supplier
  // — same "two independent layers" posture as everywhere else in this
  // hardening pass. If SUPABASE_JWT_SECRET/SUPABASE_ANON_KEY aren't set,
  // getUserScopedOrFallbackClient silently falls back to service-role
  // (RLS inactive), and THIS check becomes the only thing enforcing
  // ownership, exactly as it always has been.
  if (auth.user.role === "buyer" && order.buyer_id !== auth.user.id) {
    return Response.json({ error: "You are not the buyer for this order." }, { status: 403 });
  }
  if (auth.user.role === "supplier") {
    const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
    if (!profile || profile.id !== order.supplier_id) {
      return Response.json({ error: "You are not the assigned supplier for this order." }, { status: 403 });
    }
  }
  // admin: no ownership check, full oversight, view-only (see design doc
  // Section G, admin can view but every state-changing route below still
  // checks the specific role it's meant for, never falls back to admin).
  const isPartyToOrder = auth.user.role === "buyer" || auth.user.role === "supplier";

  // Only the buyer and the assigned supplier ever get the real call room
  // ID, admin oversight is view-only for order data, but the live
  // verification call is explicitly a private, two-party conversation,
  // not something oversight should be able to silently join. Backfilling
  // it here (rather than in createOrder() only) covers any order created
  // before migration 0008 added the column.
  const callRoomId = isPartyToOrder ? await ensureCallRoomId(supabase, order) : null;
  // Same isPartyToOrder gate as the room id itself: a signed JWT is as
  // sensitive as the room id it grants moderator access to, admin
  // oversight doesn't get one either.
  const callConfig =
    isPartyToOrder && callRoomId
      ? await buildJaasCallConfig(callRoomId, String(auth.user.id), auth.user.role === "buyer" ? "SourceFi Buyer" : "SourceFi Supplier")
      : null;

  const [{ data: buyer }, { data: supplier }, { data: paymentEvents }, { data: proofs }, { data: disputes }, { data: rating }, { data: listing }] =
    await Promise.all([
      supabase.from("users").select("email").eq("id", order.buyer_id).maybeSingle(),
      supabase.from("supplier_profiles").select("business_name, verification_status").eq("id", order.supplier_id).maybeSingle(),
      // RLS pilot expansion (migration 0021_rls_expand_pilot.sql): these
      // four are all order_id-scoped, visible to either party of THIS
      // order, same readClient already computed above for the orders
      // read itself (admin stays on the plain service-role `supabase`
      // client via that same variable, unchanged).
      readClient.from("payment_events").select("*").eq("order_id", orderId).order("created_at", { ascending: true }),
      readClient.from("delivery_proofs").select("*").eq("order_id", orderId).order("submitted_at", { ascending: false }),
      readClient.from("disputes").select("*").eq("order_id", orderId).order("created_at", { ascending: false }),
      readClient.from("ratings").select("*").eq("order_id", orderId).maybeSingle(),
      // Only for the "total = unit price x quantity" breakdown shown on
      // the order detail screen, orders created without picking a
      // listing (freeform amount) just won't have one to join.
      order.supplier_listing_id
        ? supabase.from("supplier_listings").select("price_minor, unit").eq("id", order.supplier_listing_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  return Response.json({
    order: {
      ...order,
      verification_call_room_id: callRoomId,
      buyer_email: buyer?.email ?? null,
      supplier_business_name: supplier?.business_name ?? null,
      supplier_verification_status: supplier?.verification_status ?? null,
      listing_unit_price_minor: listing?.price_minor ?? null,
      listing_unit: listing?.unit ?? null,
    },
    paymentEvents: paymentEvents || [],
    deliveryProofs: proofs || [],
    disputes: disputes || [],
    rating: rating || null,
    callConfig,
  });
}
