// app/api/orders/[id]/proof/route.ts
//
// Supplier submits delivery proof, photos, receipt, notes (design doc
// Section 2's flow: Delivery -> Proof). Supplier-only, ownership-checked
// against supplier_profiles.user_id (not a client-supplied supplier id).
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { submitDeliveryProof, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
import { filterSafeHttpUrls, isSafeHttpUrl } from "../../../../../lib/safeUrl";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  // http(s)-only (Prompt 4, M6), these render as clickable links in the
  // order detail view; a javascript:/data: URI stored here would execute
  // in this app's own origin when clicked.
  const photoUrls = Array.isArray(body?.photoUrls) ? filterSafeHttpUrls(body.photoUrls) : [];
  const rawReceiptUrl = typeof body?.receiptUrl === "string" ? body.receiptUrl.trim() : "";
  const receiptUrl = rawReceiptUrl && isSafeHttpUrl(rawReceiptUrl) ? rawReceiptUrl : null;
  const notes = typeof body?.notes === "string" ? body.notes.trim() || null : null;

  if (photoUrls.length === 0 && !receiptUrl) {
    return Response.json({ error: "At least one photo or a receipt is required as proof of delivery." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const order = await submitDeliveryProof(supabase, orderId, auth.user.id, { photoUrls, receiptUrl, notes });
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to submit delivery proof." }, { status: 500 });
  }
}
