// app/api/orders/[id]/route.ts
//
// Single order detail — ownership-checked (buyer who placed it, the
// assigned supplier, or any admin for oversight). Also returns the
// order's payment_events trail and any delivery_proofs/disputes/rating
// so the detail screen doesn't need N separate requests.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireSession } from "../../../../lib/authz";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { data: order, error } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  if (auth.user.role === "buyer" && order.buyer_id !== auth.user.id) {
    return Response.json({ error: "You are not the buyer for this order." }, { status: 403 });
  }
  if (auth.user.role === "supplier") {
    const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
    if (!profile || profile.id !== order.supplier_id) {
      return Response.json({ error: "You are not the assigned supplier for this order." }, { status: 403 });
    }
  }
  // admin: no ownership check — full oversight, view-only (see design doc
  // Section G — admin can view but every state-changing route below still
  // checks the specific role it's meant for, never falls back to admin).

  const [{ data: buyer }, { data: supplier }, { data: paymentEvents }, { data: proofs }, { data: disputes }, { data: rating }] =
    await Promise.all([
      supabase.from("users").select("email").eq("id", order.buyer_id).maybeSingle(),
      supabase.from("supplier_profiles").select("business_name, verification_status").eq("id", order.supplier_id).maybeSingle(),
      supabase.from("payment_events").select("*").eq("order_id", orderId).order("created_at", { ascending: true }),
      supabase.from("delivery_proofs").select("*").eq("order_id", orderId).order("submitted_at", { ascending: false }),
      supabase.from("disputes").select("*").eq("order_id", orderId).order("created_at", { ascending: false }),
      supabase.from("ratings").select("*").eq("order_id", orderId).maybeSingle(),
    ]);

  return Response.json({
    order: {
      ...order,
      buyer_email: buyer?.email ?? null,
      supplier_business_name: supplier?.business_name ?? null,
      supplier_verification_status: supplier?.verification_status ?? null,
    },
    paymentEvents: paymentEvents || [],
    deliveryProofs: proofs || [],
    disputes: disputes || [],
    rating: rating || null,
  });
}
