// app/api/orders/[id]/call-presence/route.ts
//
// Immediate join/leave presence for the live verification call, not the
// segment-duration report (see call-progress/route.ts, a separate
// endpoint for a separate purpose). A fresh join here notifies the
// other party, see lib/orderService.ts's setCallPresence.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireSession } from "../../../../../lib/authz";
import { setCallPresence, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (typeof body?.active !== "boolean") {
    return Response.json({ error: "active must be a boolean." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    await setCallPresence(supabase, orderId, auth.user.id, body.active);
    return Response.json({ success: true });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    console.error(`call-presence failed for order ${orderId}:`, err);
    return Response.json({ error: "Failed to update call presence." }, { status: 500 });
  }
}
