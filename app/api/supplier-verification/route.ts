// app/api/supplier-verification/route.ts
//
// Repurposed from app/api/sourcer-applications/route.ts, a user applying
// to become a verified supplier. Same rule as before, just renamed:
// submitting a row here grants nothing by itself (see CLAUDE.md: "a user
// cannot self-assign" a service-provider role). Only an admin approving
// it at app/api/admin/supplier-verification/[id]/route.ts creates a real
// supplier_profiles row and flips users.role.
//
// Also used for RE-verification after expiry, same table, same
// one-pending-per-user constraint, same flow. A supplier whose
// verification expired applies again exactly the same way a brand-new
// applicant does.
//
// Payout bank details (migration 0019_supplier_payout.sql) are required
// here, not optional like supportingDocumentUrl: a supplier who can't be
// paid out shouldn't be approvable in the first place. Upserted into
// supplier_payout_profiles (not application columns) so a resubmission
// after rejection/expiry updates the same row rather than creating a new
// one, same reasoning as buyer_kyc_profiles being its own table.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";

export async function POST(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const businessName = typeof body?.businessName === "string" ? body.businessName.trim() : "";
  const businessLocation = typeof body?.businessLocation === "string" ? body.businessLocation.trim() : "";
  const whatTheySell = typeof body?.whatTheySell === "string" ? body.whatTheySell.trim() : "";
  const cacRegistrationNumber = typeof body?.cacRegistrationNumber === "string" ? body.cacRegistrationNumber.trim() || null : null;
  const taxIdNumber = typeof body?.taxIdNumber === "string" ? body.taxIdNumber.trim() || null : null;
  const supportingDocumentUrl = typeof body?.supportingDocumentUrl === "string" ? body.supportingDocumentUrl.trim() || null : null;
  const payoutBankName = typeof body?.payoutBankName === "string" ? body.payoutBankName.trim() : "";
  const payoutAccountNumber = typeof body?.payoutAccountNumber === "string" ? body.payoutAccountNumber.trim() : "";
  const payoutAccountName = typeof body?.payoutAccountName === "string" ? body.payoutAccountName.trim() : "";

  if (!businessName || !businessLocation || !whatTheySell) {
    return Response.json({ error: "Business name, location, and what you sell are required." }, { status: 400 });
  }
  if (!payoutBankName || !payoutAccountNumber || !payoutAccountName) {
    return Response.json({ error: "Bank name, account number, and account holder name are required — this is how you'll be paid." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  const { error: payoutError } = await supabase
    .from("supplier_payout_profiles")
    .upsert({ user_id: auth.user.id, bank_name: payoutBankName, account_number: payoutAccountNumber, account_name: payoutAccountName }, { onConflict: "user_id" });
  if (payoutError) return dbErrorResponse("POST supplier-verification (payout profile)", payoutError);

  // The unique partial index (migration 0004) is what actually enforces
  // "one pending application per user" under concurrent submits, this
  // check is just a friendlier error message ahead of that.
  const { data: existingPending } = await supabase
    .from("supplier_verification_applications")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("status", "pending")
    .maybeSingle();
  if (existingPending) {
    return Response.json({ error: "You already have a pending verification application." }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("supplier_verification_applications")
    .insert({
      user_id: auth.user.id,
      business_name: businessName,
      business_location: businessLocation,
      what_they_sell: whatTheySell,
      cac_registration_number: cacRegistrationNumber,
      tax_id_number: taxIdNumber,
      supporting_document_url: supportingDocumentUrl,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) {
    // The unique index rejecting a race that slipped past the check above.
    if (error.code === "23505") {
      return Response.json({ error: "You already have a pending verification application." }, { status: 409 });
    }
    return dbErrorResponse("POST supplier-verification", error);
  }

  return Response.json({ application: data });
}
