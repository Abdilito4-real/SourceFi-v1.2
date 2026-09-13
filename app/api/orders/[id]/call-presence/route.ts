// app/api/orders/[id]/call-presence/route.ts
//
// Immediate join/leave presence for the live verification call, not the
// segment-duration report (see call-progress/route.ts, a separate
// endpoint for a separate purpose). A fresh join here notifies the
// other party, see lib/orderService.ts's setCallPresence.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireSession, getClientIp } from "../../../../../lib/authz";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { setCallPresence, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  // A security audit found this route un-throttled: a fresh true→false→
  // true cycle fires a critical, quiet-hours-bypassing push/email to the
  // other party every time (see setCallPresence's own comment), so a
  // party toggling repeatedly could spam the other side and exhaust
  // their shared per-hour notification budget. 60 per 10 minutes
  // comfortably covers a real call's own heartbeat (every 20s while
  // in-call, JitsiMeetRoom.tsx) plus a join/leave here and there, while
  // still bounding a deliberate flood.
  const quota = await checkDualQuota("call-presence", getClientIp(request), auth.user.email, 60, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json(
      { error: "Too many presence updates recently. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } }
    );
  }

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
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    console.error(`call-presence failed for order ${orderId}:`, err);
    return Response.json({ error: "Failed to update call presence." }, { status: 500 });
  }
}
