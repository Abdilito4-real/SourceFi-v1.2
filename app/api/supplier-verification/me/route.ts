// app/api/supplier-verification/me/route.ts
//
// The current user's own supplier profile (if any) + verification status
// + their most recent verification application, what the supplier
// dashboard's status card needs. Read-only, self-only: no id param, only
// ever the caller's own row, same "you can only ever act on what the
// session proves is yours" pattern as PATCH /api/auth/me.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireSession } from "../../../../lib/authz";
import { isSupplierCurrentlyVerified } from "../../../../lib/supplierVerification";

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = getSupabaseServerClient();

  const { data: profile } = await supabase.from("supplier_profiles").select("*").eq("user_id", auth.user.id).maybeSingle();

  const currentlyVerified = profile ? await isSupplierCurrentlyVerified(supabase, profile.id) : false;

  const { data: latestApplication } = await supabase
    .from("supplier_verification_applications")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return Response.json({ profile: profile ?? null, currentlyVerified, latestApplication: latestApplication ?? null });
}
