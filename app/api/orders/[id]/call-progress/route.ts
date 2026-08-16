// app/api/orders/[id]/call-progress/route.ts
//
// Reports one real call segment (join-to-leave, from Jitsi's own
// lifecycle events client-side — see components/JitsiMeetRoom.tsx)
// toward the mandatory pre-approval verification call. Either the buyer
// or the assigned supplier can report — whoever's session ends first.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireSession } from "../../../../../lib/authz";
import { recordVerificationCallProgress, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const secondsElapsed = Number(body?.secondsElapsed);
  if (!Number.isFinite(secondsElapsed) || secondsElapsed <= 0) {
    return Response.json({ error: "secondsElapsed must be a positive number." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const order = await recordVerificationCallProgress(supabase, orderId, auth.user.id, secondsElapsed);
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to record call progress." }, { status: 500 });
  }
}
