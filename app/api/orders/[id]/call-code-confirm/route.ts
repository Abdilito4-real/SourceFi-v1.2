// app/api/orders/[id]/call-code-confirm/route.ts
//
// Buyer confirms the supplier showed the order's own code on camera
// during the live verification call and it matched (migration 0013,
// lib/orderService.ts's confirmCallCode). Buyer-only: this is the
// buyer's attestation, gating THEIR OWN approve action, not something
// the supplier can satisfy on the buyer's behalf.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole, getClientIp } from "../../../../../lib/authz";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { confirmCallCode, NotOrderOwnerError, OrderNotFoundError, VerificationCallIncompleteError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const quota = await checkDualQuota("call-code-confirm", getClientIp(request), auth.user.email, 10, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json(
      { error: "Too many attempts recently. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } }
    );
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const order = await confirmCallCode(supabase, orderId, auth.user.id);
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    if (err instanceof VerificationCallIncompleteError) return Response.json({ error: err.message }, { status: 409 });
    console.error(`call-code-confirm failed for order ${orderId}:`, err);
    return Response.json({ error: err instanceof Error ? err.message : "Failed to confirm the order code match." }, { status: 500 });
  }
}
