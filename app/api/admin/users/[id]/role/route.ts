// app/api/admin/users/[id]/role/route.ts
//
// The entire replacement for the old "Sourcer Access" self-service
// password gate: granting the supplier (or admin) role is now admin-only,
// database-backed, and audit-logged. There is deliberately no path to
// this role anywhere in the client UI except through an authenticated
// admin session, see the Stage 4 audit note in
// supabase/migrations/0001_stage4_auth.sql for how the first admin gets
// bootstrapped (a direct DB write, on purpose). Note: granting 'supplier'
// here does NOT create a supplier_profiles row or set a verification
// expiry, that only happens through the real verification flow
// (app/api/admin/supplier-verification/[id]/route.ts). This endpoint is
// for role correction/admin bootstrapping, not a supplier-onboarding
// shortcut.
import { getSupabaseServerClient } from "../../../../../../lib/supabaseServer";
import { requireRole, logAudit } from "../../../../../../lib/authz";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey } from "../../../../../../lib/rateLimit";
import { dbErrorResponse } from "../../../../../../lib/dbErrorResponse";
import type { Role } from "../../../../../../lib/types";

const VALID_ROLES: Role[] = ["buyer", "supplier", "admin"];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const limitKey = rateLimitKey("admin-role-change", auth.user.email);
  const limit = await checkRateLimit(limitKey);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many role changes. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 30) } }
    );
  }

  const { id } = await params;
  const targetId = Number(id);
  if (!Number.isInteger(targetId)) {
    await recordFailure(limitKey);
    return Response.json({ error: "Invalid user id." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const nextRole = body?.role;
  if (typeof nextRole !== "string" || !VALID_ROLES.includes(nextRole as Role)) {
    await recordFailure(limitKey);
    return Response.json({ error: `role must be one of: ${VALID_ROLES.join(", ")}` }, { status: 400 });
  }

  if (targetId === auth.user.id) {
    // An admin locking themselves out (accidentally or via a compromised
    // session) shouldn't be a single API call, that needs another admin.
    await recordFailure(limitKey);
    return Response.json({ error: "Cannot change your own role through this endpoint." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: target, error: fetchErr } = await supabase.from("users").select("*").eq("id", targetId).maybeSingle();
  if (fetchErr || !target) {
    await recordFailure(limitKey);
    return Response.json({ error: "User not found." }, { status: 404 });
  }

  const previousRole = target.role as Role;
  const { data: updated, error: updateErr } = await supabase
    .from("users")
    .update({ role: nextRole })
    .eq("id", targetId)
    .select("*")
    .single();

  if (updateErr) {
    await recordFailure(limitKey);
    return dbErrorResponse(`PATCH admin/users/${targetId}/role`, updateErr);
  }

  await recordSuccess(limitKey);
  await logAudit({
    actorEmail: auth.user.email,
    action: "role_change",
    target: target.email,
    details: { from: previousRole, to: nextRole },
    request,
  });

  return Response.json({ success: true, user: { email: updated.email, role: updated.role } });
}
