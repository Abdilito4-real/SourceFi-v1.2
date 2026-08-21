// lib/supabaseUserClient.ts
//
// Real RLS pilot (orders + supplier_profiles, migration
// 0017_orders_rls_pilot.sql): mints a short-lived, Supabase-compatible
// JWT for one specific app user and returns a request-scoped Supabase
// client authenticated as that user (Postgres role `authenticated`),
// NOT service_role — so the RLS policies on `orders` actually run for
// this query, a genuine second layer behind lib/orderService.ts's
// existing app-layer ownership checks, closing the gap docs/security.md
// flags: "there is no database-level backstop behind it."
//
// Signing mirrors lib/session.ts's signSession() (same jose HS256
// technique, same short-TTL/no-rotation posture), different secret
// (Supabase's own Legacy JWT Secret, SUPABASE_JWT_SECRET — distinct
// from this app's own SESSION_SECRET) and claim shape (PostgREST's
// expected shape: `role`/`aud` so it runs as `authenticated`, not this
// app's own SessionClaims).
//
// NOT wired into every route, only the specific `orders` reads that
// need real RLS enforcement (see app/api/orders/**'s GET handlers).
// Every other query in this app still legitimately uses the
// service-role client (lib/supabaseServer.ts) — this pilot doesn't
// attempt to convert the whole app, see the plan this implements for
// why the blast radius is deliberately this narrow.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { getSupabaseServerClient } from "./supabaseServer";
import { uuidv5, SOURCEFI_UUID_NAMESPACE } from "./uuidv5";

// Minted fresh per call, used immediately for one request, never
// reused or cached — no rotation/revocation machinery needed at this
// TTL.
const TOKEN_TTL_SECONDS = 60;

/** True once both env vars this needs are set. Mirrors
 * lib/jaasAuth.ts's isJaasConfigured() "not configured yet" check, same
 * graceful-degradation contract: callers fall back to the service-role
 * client (see getUserScopedOrFallbackClient below) rather than crash
 * when this is false. */
export function isUserScopedSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_JWT_SECRET && process.env.SUPABASE_ANON_KEY);
}

/** Exported for tests/supabaseUserClient.test.ts: the claim shape is
 * the security-relevant part of this file (get it wrong and RLS either
 * denies everyone or, worse, silently authorizes the wrong user), worth
 * testing directly rather than only indirectly through a constructed
 * client. */
export async function mintUserAccessToken(userRowId: number): Promise<string> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("SUPABASE_JWT_SECRET is not set.");
  // jose's HS256 sign() takes a Uint8Array key, not a raw string, same
  // encoding lib/session.ts's own getSecret() does.
  const secretBytes = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: "authenticated", // the actual PostgREST role switch; without this the connection stays `anon`
    aud: "authenticated",
    // Custom claim, the one migration 0017's current_app_user_id()
    // actually reads. auth.uid() casts its claim to uuid and would
    // ERROR on a plain integer — this app's real identity (users.id,
    // a bigint) travels as its own claim, never as `sub`.
    user_row_id: userRowId,
  })
    .setProtectedHeader({ alg: "HS256" })
    // A deterministic, meaningless-beyond-that UUID, only so auth.uid()
    // resolves to something valid rather than throwing if anything
    // ever calls it later. Never used for the actual authorization
    // decision, that's user_row_id above.
    .setSubject(uuidv5(`user:${userRowId}`, SOURCEFI_UUID_NAMESPACE))
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .sign(secretBytes);
}

/** A request-scoped Supabase client authenticated as one specific app
 * user (Postgres role `authenticated`). Throws if SUPABASE_JWT_SECRET/
 * SUPABASE_ANON_KEY/NEXT_PUBLIC_SUPABASE_URL aren't set — check
 * isUserScopedSupabaseConfigured() first, or use
 * getUserScopedOrFallbackClient below, if you want a fallback instead
 * of a throw. */
export async function getUserScopedSupabaseClient(userRowId: number): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_ANON_KEY. Set them in .env.local.");
  }
  const token = await mintUserAccessToken(userRowId);
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** What every RLS-pilot route actually calls: the real RLS-backed
 * client when configured, the existing service-role client (today's
 * exact behavior, RLS not in the path) when not — so a missing env var
 * degrades gracefully instead of taking order reads down. Logs once per
 * call, not silent, so a genuinely misconfigured deployment is visible
 * in server logs rather than quietly running without the second layer
 * forever. */
export async function getUserScopedOrFallbackClient(userRowId: number): Promise<SupabaseClient> {
  if (!isUserScopedSupabaseConfigured()) {
    console.warn(
      "SUPABASE_JWT_SECRET/SUPABASE_ANON_KEY not set: this order read is falling back to the service-role client (the RLS pilot's second layer is inactive). See .env.local.example."
    );
    return getSupabaseServerClient();
  }
  return getUserScopedSupabaseClient(userRowId);
}
