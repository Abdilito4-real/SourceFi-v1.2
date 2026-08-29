// app/api/buyer-kyc/me/route.ts
//
// The current user's own buyer KYC profile (if any), read-only,
// self-only, same "you can only ever act on what the session proves is
// yours" pattern as app/api/supplier-verification/me/route.ts. What the
// BuyerKycModal checks before deciding whether to show the form.
import { getUserScopedOrFallbackClient } from "../../../../lib/supabaseUserClient";
import { requireSession } from "../../../../lib/authz";

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  // RLS pilot expansion (0021_rls_expand_pilot.sql): self-only KYC PII,
  // backed by buyer_kyc_profiles_select_own.
  const supabase = await getUserScopedOrFallbackClient(auth.user.id);
  const { data: profile } = await supabase.from("buyer_kyc_profiles").select("*").eq("user_id", auth.user.id).maybeSingle();

  return Response.json({ profile: profile ?? null });
}
