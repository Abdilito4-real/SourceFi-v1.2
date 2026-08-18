// app/api/suppliers/route.ts
//
// The supplier directory a buyer browses before creating an order
// (design doc Section F: "Buyer: Supplier directory... -> Create order").
// Only currently-verified suppliers are listed, the same three
// conditions as the is_supplier_currently_verified() Postgres function
// (migration 0004), inlined here as a WHERE clause because this is a
// LIST endpoint (checking N rows), not a single-supplier gate; the RPC
// function is still the one used for the actual authorization decision
// at order-creation/funding time (lib/supplierVerification.ts). Keep
// these two in sync by hand if the expiry rule ever changes, there's no
// codegen linking them.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";
import { computeSupplierTier, getCompletedOrderCounts, getSupplierRatingAggregates } from "../../../lib/supplierTrust";

export async function GET(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  // Free-text search across what a supplier actually uploaded, their own
  // listings (migration 0006), not the old fixed material catalog. A
  // supplier matches if their business name/what_they_sell mentions the
  // term, OR any of their active listings do.
  const q = new URL(request.url).searchParams.get("q")?.trim() || "";

  const supabase = getSupabaseServerClient();
  let query = supabase
    .from("supplier_profiles")
    .select("id, business_name, business_location, what_they_sell, verification_status, verified_at, verification_expires_at, orders_since_verification")
    .eq("verification_status", "verified")
    .gt("verification_expires_at", new Date().toISOString())
    .lt("orders_since_verification", 20)
    .is("deleted_at", null)
    .order("business_name", { ascending: true });

  if (q) {
    const escaped = q.replace(/[%_]/g, (c) => `\\${c}`);
    const { data: matchingListings } = await supabase
      .from("supplier_listings")
      .select("supplier_id")
      .eq("active", true)
      .is("deleted_at", null)
      .or(`name.ilike.%${escaped}%,category.ilike.%${escaped}%,description.ilike.%${escaped}%`);
    const supplierIdsFromListings = Array.from(new Set((matchingListings || []).map((r) => r.supplier_id)));

    query = query.or(
      `business_name.ilike.%${escaped}%,what_they_sell.ilike.%${escaped}%${
        supplierIdsFromListings.length > 0 ? `,id.in.(${supplierIdsFromListings.join(",")})` : ""
      }`
    );
  }

  const { data, error } = await query;
  if (error) return dbErrorResponse("GET suppliers", error);

  // Aggregate rating (CONFIRMED-on-chain only, design doc Section C.8)
  // and completed-order count, both bulk queries, not N+1.
  const supplierIds = (data || []).map((s) => s.id);
  const [ratingAggregates, completedOrderCounts] = await Promise.all([
    getSupplierRatingAggregates(supabase, supplierIds),
    getCompletedOrderCounts(supabase, supplierIds),
  ]);

  const suppliers = (data || []).map((s) => {
    const rating = ratingAggregates.get(s.id) ?? { average: null, count: 0 };
    const completedOrderCount = completedOrderCounts.get(s.id) ?? 0;
    return {
      ...s,
      rating_average: rating.average,
      rating_count: rating.count,
      completed_order_count: completedOrderCount,
      // Every row here already matched the same three verified-and-
      // current conditions the WHERE clause above enforces.
      tier: computeSupplierTier({
        currentlyVerified: true,
        completedOrderCount,
        ratingAverage: rating.average,
        ratingCount: rating.count,
      }),
    };
  });

  return Response.json({ suppliers });
}
