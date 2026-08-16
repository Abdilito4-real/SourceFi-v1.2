// app/api/suppliers/route.ts
//
// The supplier directory a buyer browses before creating an order
// (design doc Section F: "Buyer: Supplier directory... -> Create order").
// Only currently-verified suppliers are listed — the same three
// conditions as the is_supplier_currently_verified() Postgres function
// (migration 0004), inlined here as a WHERE clause because this is a
// LIST endpoint (checking N rows), not a single-supplier gate; the RPC
// function is still the one used for the actual authorization decision
// at order-creation/funding time (lib/supplierVerification.ts). Keep
// these two in sync by hand if the expiry rule ever changes — there's no
// codegen linking them.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";

export async function GET(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  // Free-text search across what a supplier actually uploaded — their own
  // listings (migration 0006) — not the old fixed material catalog. A
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
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Aggregate rating, from CONFIRMED-on-chain ratings only (design doc
  // Section C.8) — a rating submitted but not yet independently
  // verifiable can't inflate a supplier's public number.
  const supplierIds = (data || []).map((s) => s.id);
  const { data: ratingRows } =
    supplierIds.length > 0
      ? await supabase.from("ratings").select("supplier_id, score").in("supplier_id", supplierIds).not("on_chain_confirmed_at", "is", null)
      : { data: [] as { supplier_id: number; score: number }[] };

  const ratingsBySupplier = new Map<number, number[]>();
  for (const r of ratingRows || []) {
    const list = ratingsBySupplier.get(r.supplier_id) ?? [];
    list.push(r.score);
    ratingsBySupplier.set(r.supplier_id, list);
  }

  const suppliers = (data || []).map((s) => {
    const scores = ratingsBySupplier.get(s.id) ?? [];
    return {
      ...s,
      rating_average: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      rating_count: scores.length,
    };
  });

  return Response.json({ suppliers });
}
