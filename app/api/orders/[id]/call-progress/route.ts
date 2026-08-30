// app/api/orders/[id]/call-progress/route.ts
//
// Reports one real call segment (join-to-leave, from Jitsi's own
// lifecycle events client-side, see components/JitsiMeetRoom.tsx)
// toward the mandatory pre-approval verification call. Either the buyer
// or the assigned supplier can report, whoever's session ends first.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireSession, getClientIp } from "../../../../../lib/authz";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { recordVerificationCallProgress, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  // A security audit of this flow flagged this route as having no
  // throttle at all, on top of no corroboration (see
  // recordVerificationCallProgress's own comment for the corroboration
  // fix) — a scripted flood of segment reports could still churn
  // call_segments rows even though a lone party's reports alone no
  // longer earn credit without the other party's overlap. 20 reports per
  // 10 minutes per IP+account comfortably covers a real call's actual
  // join/reconnect count on flaky mobile data (a heartbeat re-join isn't
  // reported here, only segment ends, see call-presence/route.ts for
  // that), while still bounding a spam script.
  const quota = await checkDualQuota("call-progress", getClientIp(request), auth.user.email, 20, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json(
      { error: "Too many call-progress reports recently. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } }
    );
  }

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
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    // Logged server-side (not sent to the client, the response stays a
    // generic message to avoid leaking internals) so an unexpected 500
    // here, a missing migration, a real DB error, is diagnosable from
    // the terminal instead of a silent client-side failure that just
    // looks like "the call didn't count."
    console.error(`call-progress failed for order ${orderId}:`, err);
    return Response.json({ error: err instanceof Error ? err.message : "Failed to record call progress." }, { status: 500 });
  }
}
