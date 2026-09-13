// app/api/supplier-verification/me/route.ts
//
// The current user's own supplier profile (if any) + verification status
// + their most recent verification application, what the supplier
// dashboard's status card needs. Read-only, self-only: no id param, only
// ever the caller's own row, same "you can only ever act on what the
// session proves is yours" pattern as PATCH /api/auth/me.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { getUserScopedOrFallbackClient } from "../../../../lib/supabaseUserClient";
import { requireSession } from "../../../../lib/authz";
import { isSupplierCurrentlyVerified } from "../../../../lib/supplierVerification";
import { computeSupplierTier, getCompletedOrderCounts, getSupplierRatingAggregates } from "../../../../lib/supplierTrust";

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = getSupabaseServerClient();
  // RLS pilot expansion (0021_rls_expand_pilot.sql): both self-only
  // reads below go through the user-scoped client — supplier_profiles
  // via the existing supplier_profiles_select_own policy (0017,
  // just not exercised by this route until now), supplier_verification_
  // applications via the new supplier_verification_applications_select_own
  // one. The rating/tier aggregate calls further down stay on the plain
  // service-role `supabase` client — they read other suppliers' data
  // too, not self-only.
  const readClient = await getUserScopedOrFallbackClient(auth.user.id);

  const { data: profile } = await readClient.from("supplier_profiles").select("*").eq("user_id", auth.user.id).maybeSingle();

  const currentlyVerified = profile ? await isSupplierCurrentlyVerified(supabase, profile.id) : false;

  const { data: latestApplication } = await readClient
    .from("supplier_verification_applications")
    .select("*")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // The same tier a buyer sees on this supplier in the directory, shown
  // back to the supplier themselves so they can see what buyers see
  // and what it'd take to reach the next tier.
  let trust = null;
  if (profile) {
    const [ratingAggregates, completedOrderCounts] = await Promise.all([
      getSupplierRatingAggregates(supabase, [profile.id]),
      getCompletedOrderCounts(supabase, [profile.id]),
    ]);
    const rating = ratingAggregates.get(profile.id) ?? { average: null, count: 0 };
    const completedOrderCount = completedOrderCounts.get(profile.id) ?? 0;
    trust = {
      ratingAverage: rating.average,
      ratingCount: rating.count,
      completedOrderCount,
      tier: computeSupplierTier({ currentlyVerified, completedOrderCount, ratingAverage: rating.average, ratingCount: rating.count }),
    };
  }

  return Response.json({ profile: profile ?? null, currentlyVerified, latestApplication: latestApplication ?? null, trust });
}
