// app/api/orders/[id]/receipt/route.ts
//
// GET ?leg=funding|settlement — a receipt for one confirmed leg of this
// order. Same ownership-check shape as app/api/orders/[id]/route.ts
// (buyer/supplier/admin, RLS-scoped readClient for buyer/supplier —
// see that file's own comment for the full reasoning), reused rather
// than duplicated. lib/receiptService.ts does the actual read/compose;
// this route is just auth + which leg.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { getUserScopedOrFallbackClient } from "../../../../../lib/supabaseUserClient";
import { requireSession } from "../../../../../lib/authz";
import { getFundingReceipt, getSettlementReceipt, ReceiptNotFoundError } from "../../../../../lib/receiptService";
import { renderReceiptPdf } from "../../../../../lib/receiptPdf";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const leg = searchParams.get("leg");
  if (leg !== "funding" && leg !== "settlement") {
    return Response.json({ error: "?leg must be 'funding' or 'settlement'." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const readClient = auth.user.role === "admin" ? supabase : await getUserScopedOrFallbackClient(auth.user.id);
  const { data: order } = await readClient.from("orders").select("id, buyer_id, supplier_id").eq("id", orderId).maybeSingle();
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

  try {
    const receipt = leg === "funding" ? await getFundingReceipt(supabase, orderId) : await getSettlementReceipt(supabase, orderId);
    if (searchParams.get("format") === "pdf") {
      const pdf = await renderReceiptPdf(receipt);
      return new Response(new Uint8Array(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${receipt.orderCode}-${leg}-receipt.pdf"`,
        },
      });
    }
    return Response.json({ receipt });
  } catch (err) {
    if (err instanceof ReceiptNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
