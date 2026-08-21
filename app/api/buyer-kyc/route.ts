// app/api/buyer-kyc/route.ts
//
// Self-service buyer KYC, the new prerequisite for real Yellow Card
// funding (migration 0018_buyer_kyc.sql). Same shape as
// app/api/supplier-verification/route.ts: no admin review step, this
// isn't a role grant, just the data Yellow Card's real "Submit Receive
// Request" requires in its `recipient` object. Upserts (a buyer
// re-submitting updates their existing row) rather than one-pending-
// per-user like supplier verification, there's no review state here to
// protect against duplicating.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";

const ID_TYPES = ["nin", "passport", "drivers_license", "voters_card"] as const;

export async function POST(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const firstName = typeof body?.firstName === "string" ? body.firstName.trim() : "";
  const lastName = typeof body?.lastName === "string" ? body.lastName.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  const dateOfBirth = typeof body?.dateOfBirth === "string" ? body.dateOfBirth.trim() : "";
  const idType = typeof body?.idType === "string" ? body.idType.trim() : "";
  const idNumber = typeof body?.idNumber === "string" ? body.idNumber.trim() : "";
  const address = typeof body?.address === "string" ? body.address.trim() : "";

  if (!firstName || !lastName || !phone || !dateOfBirth || !idType || !idNumber || !address) {
    return Response.json({ error: "First name, last name, phone, date of birth, ID type, ID number, and address are all required." }, { status: 400 });
  }
  if (!(ID_TYPES as readonly string[]).includes(idType)) {
    return Response.json({ error: `idType must be one of: ${ID_TYPES.join(", ")}.` }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || Number.isNaN(new Date(dateOfBirth).getTime())) {
    return Response.json({ error: "dateOfBirth must be a valid date in YYYY-MM-DD format." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: existing } = await supabase.from("buyer_kyc_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();

  const patch = {
    user_id: auth.user.id,
    first_name: firstName,
    last_name: lastName,
    phone,
    date_of_birth: dateOfBirth,
    id_type: idType,
    id_number: idNumber,
    address,
    country: "NG",
  };

  const { data, error } = existing
    ? await supabase.from("buyer_kyc_profiles").update(patch).eq("id", existing.id).select("*").single()
    : await supabase.from("buyer_kyc_profiles").insert(patch).select("*").single();

  if (error) return dbErrorResponse("POST buyer-kyc", error);
  return Response.json({ profile: data });
}
