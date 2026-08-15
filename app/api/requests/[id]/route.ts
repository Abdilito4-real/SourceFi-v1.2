import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireRole } from "../../../../lib/authz";

// Stage 4 restricted this endpoint to evidence-only updates, scoped to the
// one legitimate use that wasn't a real state transition (the sourcer
// flagging that they'd started the video call). Stage 5 makes that
// literal: invite_sent is a real timestamp column now, not a field inside
// a JSONB blob, and this route has exactly one job. Every real state
// transition (claim/deposit/audit/release/clear) goes through
// app/api/escrow/route.ts's checked, state-machine-validated actions.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["sourcer"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const supabase = getSupabaseServerClient();

  // Ownership check via the update's WHERE clause: if you're not this
  // request's assigned sourcer, zero rows match and you get a 403, not a
  // silent no-op success.
  const { data, error } = await supabase
    .from("sourcing_requests")
    .update({ invite_sent_at: new Date().toISOString() })
    .eq("id", id)
    .eq("sourcer_id", auth.user.id)
    .select()
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "You are not the assigned sourcer for this request." }, { status: 403 });
  }

  return Response.json({ request: data });
}
