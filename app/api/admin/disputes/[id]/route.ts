// app/api/admin/disputes/[id]/route.ts
//
// Admin resolves a dispute. Delegates entirely to
// lib/orderService.ts's resolveDispute() — see that function's doc
// comment for exactly which cases automatically call into the payment
// boundary (refund/release) versus which ones only record the ruling
// for manual follow-up (design doc Open Question 9, genuinely
// unresolved — this route does not silently invent an answer either).
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole, logAudit } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import { resolveDispute, type DisputeRuling } from "../../../../../lib/orderService";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["admin"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const disputeId = Number(id);
  if (!Number.isInteger(disputeId)) return Response.json({ error: "Invalid dispute id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const ruling: DisputeRuling | null = body?.ruling === "buyer" || body?.ruling === "supplier" ? body.ruling : null;
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 2000) || null : null;

  if (!ruling) {
    return Response.json({ error: "ruling must be 'buyer' or 'supplier'." }, { status: 400 });
  }
  if (!notes) {
    // Money/reputation decision with no reasoning on file is exactly
    // what design doc Section C.7's audit-history requirement exists to
    // prevent.
    return Response.json({ error: "Resolution notes are required." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const result = await resolveDispute(supabase, getPaymentProvider(), disputeId, auth.user.id, ruling, notes);
    await logAudit({
      actorEmail: auth.user.email,
      action: "dispute_resolved",
      target: String(disputeId),
      details: { ruling, notes, autoActionTaken: result.autoActionTaken },
      request,
    });
    return Response.json({ success: true, autoActionTaken: result.autoActionTaken });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to resolve dispute." }, { status: 500 });
  }
}
