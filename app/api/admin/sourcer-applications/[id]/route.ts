// app/api/admin/sourcer-applications/[id]/route.ts
//
// The one place a sourcer_applications row can turn into an actual role
// change — see CLAUDE.md: "Sourcer role is granted by an admin after
// vetting. A user cannot self-assign it." Approving here is the admin
// doing exactly that, deliberately, after reading what the applicant
// wrote — never a side effect of the applicant's own submission.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole, logAudit } from "../../../../../lib/authz";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey } from "../../../../../lib/rateLimit";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const limitKey = rateLimitKey("sourcer-application-review", auth.user.email);
  const limit = checkRateLimit(limitKey);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many review actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 30) } }
    );
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!Number.isInteger(applicationId)) {
    recordFailure(limitKey);
    return Response.json({ error: "Invalid application id." }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const action = body?.action;
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 1000) : null;
  if (action !== "approve" && action !== "reject") {
    recordFailure(limitKey);
    return Response.json({ error: "action must be 'approve' or 'reject'." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: application, error: fetchErr } = await supabase
    .from("sourcer_applications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchErr || !application) {
    recordFailure(limitKey);
    return Response.json({ error: "Application not found." }, { status: 404 });
  }

  const nextStatus = action === "approve" ? "approved" : "rejected";

  // Compare-and-swap on the current status — the same pattern
  // app/api/escrow/route.ts uses to stop two admins racing to review the
  // same application twice.
  const { data: updated, error: updateErr } = await supabase
    .from("sourcer_applications")
    .update({ status: nextStatus, reviewed_by: auth.user.id, reviewed_at: new Date().toISOString(), review_notes: notes })
    .eq("id", applicationId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (updateErr) {
    recordFailure(limitKey);
    return Response.json({ error: updateErr.message }, { status: 500 });
  }
  if (!updated) {
    recordFailure(limitKey);
    return Response.json({ error: "This application was already reviewed." }, { status: 409 });
  }

  if (action === "approve") {
    // Only grant the role if the applicant is still exactly what they were
    // when they applied (a plain buyer) — if an admin already changed
    // their role some other way in the meantime, don't silently overwrite
    // whatever that decision was.
    const { data: roleUpdate } = await supabase
      .from("users")
      .update({ role: "sourcer" })
      .eq("id", application.user_id)
      .eq("role", "buyer")
      .select("email")
      .maybeSingle();

    await logAudit({
      actorEmail: auth.user.email,
      action: "sourcer_application_approved",
      target: roleUpdate?.email ?? String(application.user_id),
      details: { applicationId, roleGranted: Boolean(roleUpdate) },
      request,
    });
  } else {
    await logAudit({
      actorEmail: auth.user.email,
      action: "sourcer_application_rejected",
      target: String(application.user_id),
      details: { applicationId, notes },
      request,
    });
  }

  recordSuccess(limitKey);
  return Response.json({ success: true, application: updated });
}
