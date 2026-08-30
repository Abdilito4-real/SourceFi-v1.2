// app/api/suppliers/[id]/route.ts
//
// A single supplier's trust profile: business info, verification tier,
// completed-order count, rating, the same signals the directory
// (app/api/suppliers/route.ts) uses to compute a tier, for one
// supplier in more detail. Any signed-in user can view any currently-
// verified supplier's profile, same audience as the directory itself;
// this exposes nothing beyond what's already shown there plus the
// verified-since date. Not currently verified -> 404, there's no
// profile to show a buyer for a supplier they couldn't order from
// anyway.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireSession } from "../../../../lib/authz";
import { computeSupplierTier, getCompletedOrderCounts, getSupplierProfilePictures, getSupplierRatingAggregates } from "../../../../lib/supplierTrust";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const { id } = await params;
  const supplierId = Number(id);
  if (!Number.isInteger(supplierId)) return Response.json({ error: "Invalid supplier id." }, { status: 400 });

  const supabase = getSupabaseServerClient();

  const { data: profile } = await supabase
    .from("supplier_profiles")
    .select("id, user_id, business_name, business_location, what_they_sell, verification_status, verified_at, verification_expires_at, orders_since_verification")
    .eq("id", supplierId)
    .is("deleted_at", null)
    .maybeSingle();

  const currentlyVerified = Boolean(
    profile &&
      profile.verification_status === "verified" &&
      profile.verification_expires_at &&
      new Date(profile.verification_expires_at) > new Date() &&
      profile.orders_since_verification < 20
  );
  if (!profile || !currentlyVerified) {
    return Response.json({ error: "Supplier not found." }, { status: 404 });
  }

  const [ratingAggregates, completedOrderCounts, profilePictures] = await Promise.all([
    getSupplierRatingAggregates(supabase, [supplierId]),
    getCompletedOrderCounts(supabase, [supplierId]),
    getSupplierProfilePictures(supabase, [profile]),
  ]);
  const rating = ratingAggregates.get(supplierId) ?? { average: null, count: 0 };
  const completedOrderCount = completedOrderCounts.get(supplierId) ?? 0;

  return Response.json({
    supplier: {
      id: profile.id,
      business_name: profile.business_name,
      business_location: profile.business_location,
      what_they_sell: profile.what_they_sell,
      profile_picture_url: profilePictures.get(supplierId) ?? null,
      verified_at: profile.verified_at,
      rating_average: rating.average,
      rating_count: rating.count,
      completed_order_count: completedOrderCount,
      tier: computeSupplierTier({
        currentlyVerified: true,
        completedOrderCount,
        ratingAverage: rating.average,
        ratingCount: rating.count,
      }),
    },
  });
}
