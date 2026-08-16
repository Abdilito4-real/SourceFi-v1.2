// app/api/admin/users/[id]/suspend/route.ts
//
// Prompt 3, flow 10 / Decision 9. Suspends/unsuspends a supplier account
// orthogonal to role, blocks NEW orders only (createOrder's check), never
// touches in-flight ones. Mandatory written reason, same posture as
// resolveDispute's mandatory notes: a decision with no reasoning on file
// is exactly what the audit trail exists to prevent.
import { getSupabaseServerClient } from "../../../../../../lib/supabaseServer";
import { requireRole, logAudit } from "../../../../../../lib/authz";
import { suspendSupplier, unsuspendSupplier } from "../../../../../../lib/orderService";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const targetUserId = Number(id);
  if (!Number.isInteger(targetUserId)) return Response.json({ error: "Invalid user id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const action = body?.action;
  if (action !== "suspend" && action !== "unsuspend") {
    return Response.json({ error: "action must be 'suspend' or 'unsuspend'." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    if (action === "suspend") {
      const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
      if (!reason) {
        return Response.json({ error: "A written reason is required to suspend an account." }, { status: 400 });
      }
      const user = await suspendSupplier(supabase, targetUserId, auth.user.id, reason);
      await logAudit({ actorEmail: auth.user.email, action: "supplier_suspended", target: user.email, details: { targetUserId, reason }, request });
      return Response.json({ success: true, user });
    }

    const user = await unsuspendSupplier(supabase, targetUserId);
    await logAudit({ actorEmail: auth.user.email, action: "supplier_unsuspended", target: user.email, details: { targetUserId }, request });
    return Response.json({ success: true, user });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update suspension." }, { status: 500 });
  }
}
