// lib/session.ts
//
// Our own first-party session, separate from Privy entirely once it's
// issued. Privy's SDK proves identity once (see lib/privyServer.ts); this
// is what every subsequent request actually authenticates against.
//
// Why not just use Privy's own cookie? Privy's httpOnly-cookie mode is
// gated behind registering and DNS-verifying a stable production domain in
// their Dashboard, not available in local dev, and Privy's own docs
// recommend localStorage for dev. "Sessions in httpOnly, secure, sameSite
// cookies, never localStorage" (CLAUDE.md) still has to hold in dev, so
// this project runs its own short-lived, signed session on top of a
// one-time verified Privy identity instead.
import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import type { SessionClaims } from "./types";

export const SESSION_COOKIE_NAME = "sourcefi_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h, short enough that a stolen
// token is stale soon, long enough a sourcer mid-audit in a warehouse with
// patchy signal doesn't get logged out mid-task.

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "Missing or too-short SESSION_SECRET. Set a random 32+ byte value in .env.local " +
        "(e.g. `openssl rand -hex 32`). See .env.local.example."
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

/** Verifies a raw session token string. Returns null (never throws) for
 * anything invalid/expired/tampered, same "null means not authenticated"
 * contract as verifyPrivyAccessToken. */
export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    const { privyUserId, userRowId, email, iat } = payload as Record<string, unknown>;
    if (typeof privyUserId !== "string" || typeof userRowId !== "number" || typeof email !== "string") {
      return null;
    }
    return { privyUserId, userRowId, email, issuedAt: typeof iat === "number" ? iat : undefined };
  } catch (err) {
    return null;
  }
}

export async function setSessionCookie(claims: SessionClaims): Promise<void> {
  const token = await signSession(claims);
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    // Cookies marked `secure` are dropped by the browser over plain HTTP
    // gating on NODE_ENV is the standard pattern so local dev (http://localhost)
    // keeps working while anything deployed (always https) gets the real protection.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

/** Reads and verifies the session cookie from the current request context
 * (Route Handlers, Server Components/Actions). For places that only have a
 * raw Request (not the next/headers context), read the Cookie header and
 * call verifySessionToken directly instead. */
export async function readSessionFromCookieStore(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
