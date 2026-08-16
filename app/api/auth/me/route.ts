// app/api/auth/me/route.ts
//
// Read-only: lets the client fetch its own verified identity + role to
// display (role switcher, "you're a sourcer" UI, etc.). This is the ONLY
// server-sanctioned source for "what role am I" on the client, nothing
// derives role from localStorage anymore. It's still just a display hint,
// though: every actual protected action re-checks role itself via
// requireRole(), not by trusting that the client read this correctly.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { requireSession } from "../../../../lib/authz";
import { dbErrorResponse } from "../../../../lib/dbErrorResponse";

export async function GET() {
  const auth = await requireSession();
  if (!auth) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { user } = auth;
  return Response.json({
    user: {
      email: user.email,
      username: user.username,
      role: user.role,
      walletAddress: user.wallet_address ?? null,
    },
  });
}

// Onboarding's "choose a username" step. Self-service is fine here, you
// can only ever rename the account the session cookie already proves is
// yours, so there's no client-supplied-identity risk the way there was in
// the old authSync action this replaces.
export async function PATCH(request: Request) {
  const auth = await requireSession();
  if (!auth) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  if (username.length < 3) {
    return Response.json({ error: "Username must be at least 3 characters." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();
  const { data: updated, error } = await supabase
    .from("users")
    .update({ username })
    .eq("id", auth.user.id)
    .select("*")
    .single();

  if (error) {
    return dbErrorResponse("PATCH auth/me username", error);
  }

  return Response.json({
    success: true,
    user: { email: updated.email, username: updated.username, role: updated.role, walletAddress: updated.wallet_address ?? null },
  });
}
