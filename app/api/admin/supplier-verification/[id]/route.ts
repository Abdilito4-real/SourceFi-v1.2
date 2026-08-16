// app/api/admin/supplier-verification/[id]/route.ts
//
// Repurposed from app/api/admin/sourcer-applications/[id]/route.ts, with
// the one real behavioral difference the design doc calls out (Section
// F): approving here does more than flip users.role. It creates (or, for
// a re-verification after expiry, updates) a full supplier_profiles row
// with verification metadata — verified_at, verification_expires_at (90
// days out, per lib/supplierVerification.ts), and resets
// orders_since_verification to 0. Rejecting behaves exactly like before:
// nothing changes except the application's own status.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole, logAudit } from "../../../../../lib/authz";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey } from "../../../../../lib/rateLimit";
import { computeVerificationExpiry } from "../../../../../lib/supplierVerification";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const limitKey = rateLimitKey("supplier-verification-review", auth.user.email);
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
    .from("supplier_verification_applications")
    .select("*")
    .eq("id", applicationId)
    .maybeSingle();
  if (fetchErr || !application) {
    recordFailure(limitKey);
    return Response.json({ error: "Application not found." }, { status: 404 });
  }

  const nextStatus = action === "approve" ? "approved" : "rejected";

  // Compare-and-swap on the current status — same pattern as every
  // review action in this app.
  const { data: updated, error: updateErr } = await supabase
    .from("supplier_verification_applications")
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
    const verifiedAt = new Date();
    const expiresAt = computeVerificationExpiry(verifiedAt);

    // Does this applicant already have a supplier_profiles row (a
    // re-verification after expiry)? Update it in place rather than
    // creating a second row for the same person.
    const { data: existingProfile } = await supabase
      .from("supplier_profiles")
      .select("id")
      .eq("user_id", application.user_id)
      .maybeSingle();

    const profilePatch = {
      business_name: application.business_name,
      cac_registration_number: application.cac_registration_number,
      tax_id_number: application.tax_id_number,
      business_location: application.business_location,
      what_they_sell: application.what_they_sell,
      verification_status: "verified" as const,
      verified_at: verifiedAt.toISOString(),
      verified_by: auth.user.id,
      verification_expires_at: expiresAt.toISOString(),
      orders_since_verification: 0,
    };

    if (existingProfile) {
      await supabase.from("supplier_profiles").update(profilePatch).eq("id", existingProfile.id);
    } else {
      await supabase.from("supplier_profiles").insert({ user_id: application.user_id, ...profilePatch });
    }

    // Only grant the role if the applicant hasn't already been changed to
    // something else in the meantime — same guard the sourcer version had.
    const { data: roleUpdate } = await supabase
      .from("users")
      .update({ role: "supplier" })
      .eq("id", application.user_id)
      .in("role", ["buyer", "supplier"]) // buyer applying fresh, OR an already-supplier re-verifying after expiry
      .select("email")
      .maybeSingle();

    await logAudit({
      actorEmail: auth.user.email,
      action: "supplier_verification_approved",
      target: roleUpdate?.email ?? String(application.user_id),
      details: { applicationId, roleGranted: Boolean(roleUpdate), verificationExpiresAt: expiresAt.toISOString() },
      request,
    });
  } else {
    await logAudit({
      actorEmail: auth.user.email,
      action: "supplier_verification_rejected",
      target: String(application.user_id),
      details: { applicationId, notes },
      request,
    });
  }

  recordSuccess(limitKey);
  return Response.json({ success: true, application: updated });
}
