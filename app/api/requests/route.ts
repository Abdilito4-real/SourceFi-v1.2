// app/api/requests/route.ts
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession, requireRole } from "../../../lib/authz";
import { toMinorUnits } from "../../../lib/money";
import type { Currency, SourcingRequestRow } from "../../../lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/** buyer_id/sourcer_id are the real relational identity now — but the
 * client still displays and compares by email (see lib/types.ts's
 * SourcingRequest). Rather than teach every component a numeric user id,
 * the server joins emails in here, once, in a single batched query. Same
 * idea for audit_reports: requests at "verified"/"escrow_released" used to
 * carry their audit content inline in an `evidence` blob; now it's a
 * separate table, joined in the same way. */
async function attachJoins(supabase: SupabaseClient, rows: SourcingRequestRow[]): Promise<SourcingRequestRow[]> {
  if (rows.length === 0) return rows;

  const userIds = Array.from(
    new Set(rows.flatMap((r) => [r.buyer_id, r.sourcer_id]).filter((id): id is number => id != null))
  );
  const requestIds = rows.map((r) => r.id);

  const [{ data: userRows }, { data: reportRows }, { data: txRows }] = await Promise.all([
    userIds.length > 0
      ? supabase.from("users").select("id, email").in("id", userIds)
      : Promise.resolve({ data: [] as { id: number; email: string }[] }),
    supabase
      .from("audit_reports")
      .select("sourcing_request_id, notes, image_url, supplier_business_id_raw")
      .in("sourcing_request_id", requestIds),
    supabase
      .from("escrow_transactions")
      .select("sourcing_request_id, type, tx_hash, created_at")
      .in("sourcing_request_id", requestIds)
      .in("type", ["deposit", "release"]),
  ]);

  const emailById = new Map((userRows || []).map((u) => [u.id, u.email]));
  const reportByRequestId = new Map((reportRows || []).map((r) => [r.sourcing_request_id, r]));

  // A request can have at most one deposit and one release row today
  // (Stage 6 is where "at most one" stops being a safe assumption, once
  // refunds/partial releases exist) — first-match-wins per type is enough
  // for now.
  const depositHashByRequestId = new Map<number, string | null>();
  const releaseHashByRequestId = new Map<number, string | null>();
  const releasedAtByRequestId = new Map<number, string | null>();
  for (const tx of txRows || []) {
    if (tx.type === "deposit" && !depositHashByRequestId.has(tx.sourcing_request_id)) {
      depositHashByRequestId.set(tx.sourcing_request_id, tx.tx_hash);
    }
    if (tx.type === "release" && !releaseHashByRequestId.has(tx.sourcing_request_id)) {
      releaseHashByRequestId.set(tx.sourcing_request_id, tx.tx_hash);
      releasedAtByRequestId.set(tx.sourcing_request_id, tx.created_at);
    }
  }

  return rows.map((r) => {
    const report = reportByRequestId.get(r.id);
    return {
      ...r,
      buyer_email: emailById.get(r.buyer_id) ?? null,
      sourcer_email: r.sourcer_id ? emailById.get(r.sourcer_id) ?? null : null,
      audit_notes: report?.notes ?? null,
      audit_image: report?.image_url ?? null,
      audit_business_id: report?.supplier_business_id_raw ?? null,
      deposit_tx_hash: depositHashByRequestId.get(r.id) ?? null,
      release_tx_hash: releaseHashByRequestId.get(r.id) ?? null,
      released_at: releasedAtByRequestId.get(r.id) ?? null,
    };
  });
}

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const supabase = getSupabaseServerClient();
  let query = supabase.from("sourcing_requests").select("*").order("created_at", { ascending: false });

  // Row-level visibility (Stage 5's explicit ask): buyers see only their
  // own requests; sourcers see every open mandate plus whatever they've
  // personally claimed; admins see everything. This is enforced HERE, in
  // application code, not via Postgres RLS — the migration's RLS policies
  // are a default-deny backstop, not the real gate, because this route
  // always talks to Supabase as service_role (see lib/supabaseServer.ts),
  // which bypasses RLS by design.
  if (auth.user.role === "buyer") {
    query = query.eq("buyer_id", auth.user.id);
  } else if (auth.user.role === "sourcer") {
    query = query.or(`status.eq.open,sourcer_id.eq.${auth.user.id}`);
  }
  // admin: no filter.

  const { data, error } = await query;
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const requests = await attachJoins(supabase, (data || []) as SourcingRequestRow[]);
  return Response.json({ requests });
}

export async function POST(request: Request) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const body = await request.json();
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const category = typeof body.category === "string" && body.category.trim() ? body.category.trim() : null;
  const currency: Currency = body.budgetCurrency === "NGN" ? "NGN" : "USD";

  if (!title || !location) {
    return Response.json({ error: "Title and location are required." }, { status: 400 });
  }

  let budgetMinor: number;
  try {
    budgetMinor = toMinorUnits(body.budgetAmount);
  } catch {
    return Response.json({ error: "A valid, non-negative budget amount is required." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  // category doubles as the material catalog's slug (the "New Request"
  // form is a dropdown of material names, not free text) — look up the
  // real material_id from it. A miss just means no material_id, not a
  // failure: the field stays freeform enough to not hard-fail a request
  // over a catalog lookup.
  let materialId: number | null = null;
  if (category) {
    const { data: material } = await supabase.from("materials").select("id").eq("slug", category).maybeSingle();
    materialId = material?.id ?? null;
  }

  const requestCode = `REQ-${Math.floor(100000 + Math.random() * 900000)}`;

  const { data, error } = await supabase
    .from("sourcing_requests")
    .insert({
      request_code: requestCode,
      title,
      location,
      category,
      material_id: materialId,
      budget_minor: budgetMinor,
      budget_currency: currency,
      status: "open",
      buyer_id: auth.user.id, // never a client-supplied buyer id/email
    })
    .select("*")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ request: { ...data, buyer_email: auth.user.email } });
}
