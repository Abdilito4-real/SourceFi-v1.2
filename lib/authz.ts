// lib/authz.ts
//
// The single choke point every protected route goes through. Route
// handlers never read `request.json().email` or `.role` and trust it for
// an authorization decision again, they call requireSession()/
// requireRole() here, which derives identity from the verified session
// cookie and role from a fresh DB read, every time.
import "server-only";
import { readSessionFromCookieStore } from "./session";
import { getSupabaseServerClient } from "./supabaseServer";
import type { Role, SessionClaims, UserRow } from "./types";

export interface AuthContext {
  session: SessionClaims;
  user: UserRow;
}

/** Verifies the session cookie AND re-fetches the user row fresh from the
 * DB, role lives in the DB, not in the JWT, specifically so a promotion/
 * demotion takes effect on the user's very next request instead of
 * waiting up to 12h for their session to expire and re-issue. */
export async function requireSession(): Promise<AuthContext | null> {
  const session = await readSessionFromCookieStore();
  if (!session) return null;

  const supabase = getSupabaseServerClient();
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("id", session.userRowId)
    .eq("privy_user_id", session.privyUserId) // both must match, a row id
    // repurposed across identities (shouldn't happen, but this is the
    // cheap check that makes sure it can't be exploited if it ever does)
    .maybeSingle();

  if (!user) return null;

  // Prompt 4, M5: a token issued BEFORE this user's last logout (or
  // admin suspension, see lib/orderService.ts's suspendSupplier) is
  // rejected here even though its JWT signature/expiry are still valid on
  // their own. This is what makes "server-side session invalidation on
  // logout, all devices" actually true for an otherwise-stateless JWT:
  // one DB write revokes every outstanding token for this user at once,
  // regardless of how many devices hold a copy.
  const typedUser = user as UserRow;
  if (typedUser.session_valid_after && session.issuedAt) {
    const validAfterMs = new Date(typedUser.session_valid_after).getTime();
    if (session.issuedAt * 1000 < validAfterMs) return null;
  }

  return { session, user: typedUser };
}

/** Route-handler-friendly guard: returns the auth context on success, or a
 * ready-to-return Response on failure (401 unauthenticated, 403 wrong
 * role), so call sites read as:
 *
 *   const auth = await requireRole(["sourcer"]);
 *   if (auth instanceof Response) return auth;
 */
export async function requireRole(allowedRoles: Role[]): Promise<AuthContext | Response> {
  const auth = await requireSession();
  if (!auth) {
    return Response.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!allowedRoles.includes(auth.user.role)) {
    return Response.json({ error: "Not authorized for this action." }, { status: 403 });
  }
  return auth;
}

// Exported (Prompt 4, M1), the per-IP half of the dual IP+account quota
// on dispute-filing/termination routes (lib/rateLimit.ts's checkQuota)
// needs the same IP-extraction logic this file already had privately.
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

export interface AuditEntry {
  actorEmail: string;
  action: string;
  target?: string;
  details?: unknown;
  request: Request;
}

/** Best-effort audit logging, a logging failure must never block or
 * mask the actual action's result, so errors here are swallowed (and
 * console.error'd) rather than thrown. */
export async function logAudit({ actorEmail, action, target, details, request }: AuditEntry): Promise<void> {
  try {
    const supabase = getSupabaseServerClient();
    await supabase.from("audit_log").insert({
      actor_email: actorEmail,
      action,
      target: target ?? null,
      details: details ?? null,
      ip: getClientIp(request),
    });
  } catch (err) {
    console.error("Audit log write failed:", err);
  }
}
