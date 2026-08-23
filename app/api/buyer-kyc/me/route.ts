// app/api/buyer-kyc/me/route.ts
//
// The current user's own buyer KYC profile (if any), read-only,
// self-only, same "you can only ever act on what the session proves is
// yours" pattern as app/api/supplier-verification/me/route.ts. What the
// BuyerKycModal checks before deciding whether to show the form.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireSession } from "../../../../lib/authz";

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = getSupabaseServerClient();
  const { data: profile } = await supabase.from("buyer_kyc_profiles").select("*").eq("user_id", auth.user.id).maybeSingle();

  return Response.json({ profile: profile ?? null });
}
