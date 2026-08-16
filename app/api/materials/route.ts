// app/api/materials/route.ts
//
// The buyer-facing materials search, supersedes browsing the old
// hardcoded materialLibrary. Only ever returns listings belonging to a
// CURRENTLY verified supplier (design doc's live-verification rule,
// same three conditions as app/api/suppliers/route.ts and the
// is_supplier_currently_verified() Postgres function, kept in sync by
// hand, no codegen linking them, same caveat as that route). `?q=`
// searches name/category/description via ILIKE; fine at hackathon scale,
// would want a trigram/full-text index before this sees real volume.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";

export async function GET(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const supplierIdParam = url.searchParams.get("supplierId");
  const supplierId = supplierIdParam ? Number(supplierIdParam) : null;

  const supabase = getSupabaseServerClient();

  // Currently-verified suppliers only, same conditions as
  // is_supplier_currently_verified(), inlined here because this is a
  // LIST query (checking every supplier's listings), not a single-id
  // gate.
  let supplierQuery = supabase
    .from("supplier_profiles")
    .select("id, business_name, business_location")
    .eq("verification_status", "verified")
    .gt("verification_expires_at", new Date().toISOString())
    .lt("orders_since_verification", 20)
    .is("deleted_at", null);
  if (supplierId) supplierQuery = supplierQuery.eq("id", supplierId);

  const { data: verifiedSuppliers, error: supplierErr } = await supplierQuery;
  if (supplierErr) return dbErrorResponse("GET materials (suppliers)", supplierErr);

  const verifiedSupplierIds = (verifiedSuppliers || []).map((s) => s.id);
  if (verifiedSupplierIds.length === 0) return Response.json({ materials: [] });

  let listingQuery = supabase
    .from("supplier_listings")
    .select("*")
    .in("supplier_id", verifiedSupplierIds)
    .eq("active", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (q) {
    // .or() with ilike across the three searchable text fields.
    const escaped = q.replace(/[%_]/g, (c) => `\\${c}`);
    listingQuery = listingQuery.or(`name.ilike.%${escaped}%,category.ilike.%${escaped}%,description.ilike.%${escaped}%`);
  }

  const { data: listings, error } = await listingQuery;
  if (error) return dbErrorResponse("GET materials (listings)", error);

  const supplierById = new Map((verifiedSuppliers || []).map((s) => [s.id, s]));
  const materials = (listings || []).map((l) => ({
    ...l,
    supplier_business_name: supplierById.get(l.supplier_id)?.business_name ?? null,
    supplier_business_location: supplierById.get(l.supplier_id)?.business_location ?? null,
  }));

  return Response.json({ materials });
}
