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
// Payout bank details (migration 0019_supplier_payout.sql) are required,
// same as supportingDocumentUrl now is — a supplier who can't be paid
// out, or who submits no evidence at all, shouldn't be approvable in the
// first place. Payout details are upserted into supplier_payout_profiles
// (not application columns) so a resubmission after rejection/expiry
// updates the same row rather than creating a new one, same reasoning
// as buyer_kyc_profiles being its own table.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";
import { isCloudinaryUrl } from "../../../lib/uploadValidation";
import { isValidSupportingDocumentType } from "../../../lib/supplierDocumentTypes";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";

export async function POST(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const businessName = typeof body?.businessName === "string" ? body.businessName.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const businessLocation = typeof body?.businessLocation === "string" ? body.businessLocation.trim() : "";
  const whatTheySell = typeof body?.whatTheySell === "string" ? body.whatTheySell.trim() : "";
  const cacRegistrationNumber = typeof body?.cacRegistrationNumber === "string" ? body.cacRegistrationNumber.trim() : "";
  const taxIdNumber = typeof body?.taxIdNumber === "string" ? body.taxIdNumber.trim() : "";
  const rawSupportingDocumentUrl = typeof body?.supportingDocumentUrl === "string" ? body.supportingDocumentUrl.trim() : "";
  const supportingDocumentType = typeof body?.supportingDocumentType === "string" ? body.supportingDocumentType.trim() : "";
  const payoutBankName = typeof body?.payoutBankName === "string" ? body.payoutBankName.trim() : "";
  const payoutAccountNumber = typeof body?.payoutAccountNumber === "string" ? body.payoutAccountNumber.trim() : "";
  const payoutAccountName = typeof body?.payoutAccountName === "string" ? body.payoutAccountName.trim() : "";

  if (!businessName || !businessLocation || !whatTheySell) {
    return Response.json({ error: "Business name, location, and what you sell are required." }, { status: 400 });
  }
  if (!phone) {
    return Response.json({ error: "A business phone number is required — how an admin reaches you if your application needs a follow-up." }, { status: 400 });
  }
  if (!cacRegistrationNumber || !taxIdNumber) {
    return Response.json({ error: "CAC registration number and Tax ID are required." }, { status: 400 });
  }
  if (!payoutBankName || !payoutAccountNumber || !payoutAccountName) {
    return Response.json({ error: "Bank name, account number, and account holder name are required — this is how you'll be paid." }, { status: 400 });
  }
  // Required, and must be a real result of this app's own upload flow —
  // no longer "a link to your CAC certificate", an actual image. See
  // lib/uploadValidation.ts's own header comment for why isSafeHttpUrl
  // isn't enough here.
  if (!rawSupportingDocumentUrl || !isCloudinaryUrl(rawSupportingDocumentUrl)) {
    return Response.json({ error: "A supporting document photo is required — upload one, don't paste a URL." }, { status: 400 });
  }
  // What kind of document it is, chosen before upload
  // (lib/supplierDocumentTypes.ts) — an admin reviewing the application
  // shouldn't have to guess from the photo alone.
  if (!isValidSupportingDocumentType(supportingDocumentType)) {
    return Response.json({ error: "Choose what kind of document you're uploading." }, { status: 400 });
  }
  const supportingDocumentUrl = rawSupportingDocumentUrl;

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
      phone,
      business_location: businessLocation,
      what_they_sell: whatTheySell,
      cac_registration_number: cacRegistrationNumber,
      tax_id_number: taxIdNumber,
      supporting_document_url: supportingDocumentUrl,
      supporting_document_type: supportingDocumentType,
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
