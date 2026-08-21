// app/api/orders/[id]/withdraw-proof/route.ts
//
// Prompt 3, flow 7, supplier withdraws their own submitted proof within
// WITHDRAW_PROOF_WINDOW_MS to fix a mistake before the buyer reviews it.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { withdrawProof, NotOrderOwnerError, OrderNotFoundError, WithdrawWindowExpiredError } from "../../../../../lib/orderService";
import { InvalidOrderTransitionError } from "../../../../../lib/orderStateMachine";
import { checkDualQuota } from "../../../../../lib/rateLimit";
import { getClientIp } from "../../../../../lib/authz";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const quota = await checkDualQuota("order-terminate", getClientIp(request), auth.user.email, 8, 10 * 60 * 1000);
  if (!quota.allowed) {
    return Response.json({ error: "Too many attempts recently. Try again shortly." }, { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds ?? 60) } });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const supabase = getSupabaseServerClient();

  try {
    const order = await withdrawProof(supabase, orderId, auth.user.id);
    return Response.json({ success: true, order });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof WithdrawWindowExpiredError) return Response.json({ error: err.message }, { status: 409 });
    if (err instanceof InvalidOrderTransitionError) return Response.json({ error: err.message }, { status: 409 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to withdraw proof." }, { status: 500 });
  }
}
