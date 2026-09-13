// app/api/supplier-listings/route.ts
//
// A supplier managing their own material/product catalog, GET returns
// every listing they own (active and inactive, so they can see what's
// paused), POST creates a new one. Supplier-only; resolved from the
// session's own supplier_profiles row, never a client-supplied
// supplier id. Does NOT require the supplier to be currently verified
// verification gates whether buyers can SEE a listing (GET
// /api/materials) and whether an order can be FUNDED against them, not
// whether a supplier can manage their own catalog during a brief
// re-verification gap.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireRole } from "../../../lib/authz";
import { isCloudinaryUrl } from "../../../lib/uploadValidation";
import { dbErrorResponse } from "../../../lib/dbErrorResponse";

async function resolveSupplierProfileId(supabase: ReturnType<typeof getSupabaseServerClient>, userId: number): Promise<number | null> {
  const { data } = await supabase.from("supplier_profiles").select("id").eq("user_id", userId).maybeSingle();
  return data?.id ?? null;
}

export async function GET() {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const supabase = getSupabaseServerClient();
  const supplierId = await resolveSupplierProfileId(supabase, auth.user.id);
  if (!supplierId) return Response.json({ listings: [] });

  const { data, error } = await supabase
    .from("supplier_listings")
    .select("*")
    .eq("supplier_id", supplierId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) return dbErrorResponse("GET supplier-listings", error);

  return Response.json({ listings: data || [] });
}

export async function POST(request: Request) {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const supabase = getSupabaseServerClient();
  const supplierId = await resolveSupplierProfileId(supabase, auth.user.id);
  if (!supplierId) return Response.json({ error: "No supplier profile found for this account." }, { status: 404 });

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const category = typeof body?.category === "string" ? body.category.trim() || null : null;
  const description = typeof body?.description === "string" ? body.description.trim() || null : null;
  const unit = typeof body?.unit === "string" ? body.unit.trim() || null : null;
  const rawImageUrl = typeof body?.imageUrl === "string" ? body.imageUrl.trim() : "";
  // Required on create — a listing without a photo isn't buyer-facing
  // material. Must be a real result of this app's own upload flow
  // (app/api/uploads/sign), not just any https URL a client could paste
  // in directly, or "must upload" would only be a UI-layer suggestion.
  if (!rawImageUrl || !isCloudinaryUrl(rawImageUrl)) {
    return Response.json({ error: "A photo of the material is required — upload one, don't paste a URL." }, { status: 400 });
  }
  const imageUrl = rawImageUrl;

  if (!name) return Response.json({ error: "A name is required." }, { status: 400 });

  let priceMinor: number | null = null;
  if (body?.priceAmount !== undefined && body.priceAmount !== null && body.priceAmount !== "") {
    const n = Number(body.priceAmount);
    if (!Number.isFinite(n) || n <= 0) return Response.json({ error: "Price must be a positive number, or left blank." }, { status: 400 });
    priceMinor = Math.round(n * 100);
  }

  const { data, error } = await supabase
    .from("supplier_listings")
    .insert({
      supplier_id: supplierId,
      name,
      category,
      description,
      unit,
      price_minor: priceMinor,
      image_url: imageUrl,
      active: true,
    })
    .select("*")
    .single();
  if (error) return dbErrorResponse("POST supplier-listings", error);

  return Response.json({ listing: data });
}
