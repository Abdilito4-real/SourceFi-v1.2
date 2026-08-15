// app/api/sourcer-applications/route.ts
//
// The entire path to becoming a sourcer starts here — but submitting this
// form grants nothing by itself. It only ever creates a row an admin has
// to review; see app/api/admin/sourcer-applications/[id]/route.ts for the
// one place that can actually change a role. CLAUDE.md's rule ("a user
// cannot self-assign [the sourcer role]") is enforced there, not here.
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession } from "../../../lib/authz";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey } from "../../../lib/rateLimit";

export async function POST(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  if (auth.user.role !== "buyer") {
    // Sourcers and admins already have a role; re-applying doesn't mean
    // anything for them. Not a security boundary (nothing here grants
    // access either way) — just doesn't make sense to accept.
    return Response.json({ error: "Only buyer accounts can apply to become a sourcer." }, { status: 400 });
  }

  const limitKey = rateLimitKey("sourcer-application", auth.user.email);
  const limit = checkRateLimit(limitKey);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 30) } }
    );
  }

  const body = await request.json().catch(() => null);
  const location = typeof body?.location === "string" ? body.location.trim().slice(0, 200) : null;
  const experience = typeof body?.experience === "string" ? body.experience.trim().slice(0, 2000) : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 2000) : null;

  if (!reason) {
    recordFailure(limitKey);
    return Response.json({ error: "Tell us why you want to become a sourcing partner." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  const { data: existing } = await supabase
    .from("sourcer_applications")
    .select("id")
    .eq("user_id", auth.user.id)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) {
    recordFailure(limitKey);
    return Response.json({ error: "You already have a pending application." }, { status: 409 });
  }

  const { data, error } = await supabase
    .from("sourcer_applications")
    .insert({ user_id: auth.user.id, location, experience, reason })
    .select("*")
    .single();

  if (error) {
    recordFailure(limitKey);
    return Response.json({ error: error.message }, { status: 500 });
  }

  recordSuccess(limitKey);
  return Response.json({ success: true, application: data });
}
