// app/api/orders/incoming-calls/route.ts
//
// "Is a live verification call happening right now on any order I'm a
// party to", scanned across ALL of this user's orders, not just one
// already-open order modal. Backs the global incoming-call banner (see
// components/IncomingCallBanner.tsx) so a call shows up anywhere in the
// app, dashboard overview, a different section, not only if the exact
// order's own modal happens to already be open (that one still has its
// own local, same-shape check, this is the "even in the background"
// counterpart, see lib/orderService.ts's setCallPresence and migration
// 0012 for what actually writes these timestamps).
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { getUserScopedOrFallbackClient } from "../../../../lib/supabaseUserClient";
import { requireSession } from "../../../../lib/authz";

// Mirrors OrderDetailsModal.tsx's own staleness window: a heartbeat-less
// presence (crashed tab, network drop) goes stale rather than showing
// as "in a call" forever.
const PRESENCE_STALE_MS = 45_000;
const LIVE_CALL_ELIGIBLE_STATUSES = ["funded", "fulfilling", "proof_submitted"];

export async function GET() {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  if (auth.user.role !== "buyer" && auth.user.role !== "supplier") {
    // Admins have view-only oversight, never a party to the call itself
    // (see app/api/orders/[id]/route.ts's isPartyToOrder), nothing to page them about.
    return Response.json({ order: null });
  }

  const supabase = getSupabaseServerClient();
  const cutoff = new Date(Date.now() - PRESENCE_STALE_MS).toISOString();

  // Real RLS pilot (migration 0017_orders_rls_pilot.sql): the role
  // check above already guarantees buyer/supplier here (admin returned
  // early), so this always uses the authenticated-role client, no
  // admin branch needed, see app/api/orders/route.ts for the full
  // reasoning.
  const readClient = await getUserScopedOrFallbackClient(auth.user.id);
  let query = readClient
    .from("orders")
    .select("id, order_code, title")
    .in("status", LIVE_CALL_ELIGIBLE_STATUSES)
    .order("id", { ascending: false })
    .limit(1);

  if (auth.user.role === "buyer") {
    query = query.eq("buyer_id", auth.user.id).gte("supplier_call_active_since", cutoff);
  } else {
    const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", auth.user.id).maybeSingle();
    if (!profile) return Response.json({ order: null });
    query = query.eq("supplier_id", profile.id).gte("buyer_call_active_since", cutoff);
  }

  const { data, error } = await query.maybeSingle();
  if (error) {
    // Best-effort background polling, a DB error here shouldn't surface
    // as a user-facing failure, just means no banner shows this tick.
    console.error("GET orders/incoming-calls failed:", error);
    return Response.json({ order: null });
  }

  return Response.json({ order: data ?? null });
}
