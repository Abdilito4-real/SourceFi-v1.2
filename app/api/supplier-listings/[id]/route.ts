// app/api/supplier-listings/[id]/route.ts
//
// Edit / pause-resume / delete a single listing, ownership-checked
// against the caller's own supplier_profiles row, never a client-
// supplied supplier id. DELETE is a soft delete (deleted_at set,
// active forced false), consistent with every other "deleted" row in
// this schema (users, orders, disputes all use deleted_at, never a hard
// DELETE).
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";
import { isCloudinaryUrl } from "../../../../lib/uploadValidation";
import { dbErrorResponse } from "../../../../lib/dbErrorResponse";

async function loadOwnedListing(supabase: ReturnType<typeof getSupabaseServerClient>, listingId: number, userId: number) {
  const { data: listing } = await supabase.from("supplier_listings").select("*").eq("id", listingId).is("deleted_at", null).maybeSingle();
  if (!listing) return { listing: null, owned: false };
  const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("id", listing.supplier_id).eq("user_id", userId).maybeSingle();
  return { listing, owned: Boolean(profile) };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const listingId = Number(id);
  if (!Number.isInteger(listingId)) return Response.json({ error: "Invalid listing id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { listing, owned } = await loadOwnedListing(supabase, listingId, auth.user.id);
  if (!listing) return Response.json({ error: "Listing not found." }, { status: 404 });
  if (!owned) return Response.json({ error: "You don't own this listing." }, { status: 403 });

  const body = await request.json().catch(() => null);
  const patch: Record<string, unknown> = {};

  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body?.category === "string") patch.category = body.category.trim() || null;
  if (typeof body?.description === "string") patch.description = body.description.trim() || null;
  if (typeof body?.unit === "string") patch.unit = body.unit.trim() || null;
  if (typeof body?.imageUrl === "string") {
    const trimmed = body.imageUrl.trim();
    // Empty means "remove the photo" (ImageUploadField's Remove button),
    // a deliberate no-photo state, unlike POST/create where a photo is
    // required — editing an existing listing never re-requires one.
    // A NON-empty value must be a real Cloudinary upload result, same
    // enforcement as create: reject rather than silently drop it, since
    // the UI only ever sends either "" or a genuine upload result now.
    if (trimmed && !isCloudinaryUrl(trimmed)) {
      return Response.json({ error: "Invalid image — upload one through the form, don't paste a URL." }, { status: 400 });
    }
    patch.image_url = trimmed || null;
  }
  if (typeof body?.active === "boolean") patch.active = body.active;
  if (body?.priceAmount !== undefined) {
    if (body.priceAmount === null || body.priceAmount === "") {
      patch.price_minor = null;
    } else {
      const n = Number(body.priceAmount);
      if (!Number.isFinite(n) || n <= 0) return Response.json({ error: "Price must be a positive number, or left blank." }, { status: 400 });
      patch.price_minor = Math.round(n * 100);
    }
  }

  if (Object.keys(patch).length === 0) return Response.json({ error: "Nothing to update." }, { status: 400 });

  const { data, error } = await supabase.from("supplier_listings").update(patch).eq("id", listingId).select("*").single();
  if (error) return dbErrorResponse(`PATCH supplier-listings/${listingId}`, error);

  return Response.json({ listing: data });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["supplier"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const listingId = Number(id);
  if (!Number.isInteger(listingId)) return Response.json({ error: "Invalid listing id." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { listing, owned } = await loadOwnedListing(supabase, listingId, auth.user.id);
  if (!listing) return Response.json({ error: "Listing not found." }, { status: 404 });
  if (!owned) return Response.json({ error: "You don't own this listing." }, { status: 403 });

  const { error } = await supabase.from("supplier_listings").update({ active: false, deleted_at: new Date().toISOString() }).eq("id", listingId);
  if (error) return dbErrorResponse(`DELETE supplier-listings/${listingId}`, error);

  return Response.json({ success: true });
}
