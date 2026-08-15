// lib/privyServer.ts
//
// Server-side Privy verification — the ONE place in this codebase allowed
// to say "this request really is from the person it claims to be." Every
// protected API route goes through this (via lib/authz.ts), never through
// a client-supplied email/role again.
//
// Deliberately does NOT use @privy-io/react-auth's client hooks or trust
// anything the browser sends except the access token itself. The access
// token is a short-lived (~1hr), auto-refreshed JWT obtained client-side
// via `usePrivy().getAccessToken()` — see components/App.tsx's session
// bootstrap. Privy's own httpOnly-cookie session mode requires a verified
// production domain configured in their Dashboard (not available in local
// dev, and not something this codebase can configure for you) — so instead
// we verify this token ONCE per session establishment and mint our own
// first-party session cookie (lib/session.ts) for every request after that.
import { PrivyClient, type User as PrivyUser } from "@privy-io/node";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
// Optional: sidesteps a network round-trip to Privy on every verification.
// Get it from Dashboard → your app → Settings → Basics → JWT verification key.
const PRIVY_VERIFICATION_KEY = process.env.PRIVY_VERIFICATION_KEY;

let client: PrivyClient | null = null;

function getPrivyClient(): PrivyClient {
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error(
      "Missing NEXT_PUBLIC_PRIVY_APP_ID or PRIVY_APP_SECRET. Set them in .env.local (see .env.local.example)."
    );
  }
  if (!client) {
    client = new PrivyClient({
      appId: PRIVY_APP_ID,
      appSecret: PRIVY_APP_SECRET,
      ...(PRIVY_VERIFICATION_KEY ? { jwtVerificationKey: PRIVY_VERIFICATION_KEY } : {}),
    });
  }
  return client;
}

export interface VerifiedPrivyIdentity {
  /** The user's Privy DID (e.g. "did:privy:clxxxxxxx") — the one
   * cryptographically-proven fact this module hands back. Everything else
   * about "who this is" is derived from OUR OWN users table, keyed on
   * this, not from anything else in the request. */
  privyUserId: string;
}

export interface VerifiedPrivyProfile {
  privyUserId: string;
  /** Privy guarantees an email can only ever be linked to one Privy user —
   * this is what makes it safe to bind a pre-Stage-4 users row (looked up
   * by this exact email) to a verified DID the first time that DID logs
   * in. Never sourced from client-supplied request data. */
  email: string | null;
  /** First linked EVM/Solana wallet address, if any — used to derive the
   * same `web3_<address>` pseudo-email convention the pre-Stage-4 code
   * already used, for wallet-only logins with no email account linked. */
  walletAddress: string | null;
}

/** Fetches the authoritative Privy user record for an already-verified DID
 * — this is where email/wallet get pulled from when linking or creating a
 * users row, specifically so that step never has to trust anything the
 * client sent in its request body. */
export async function getVerifiedPrivyProfile(privyUserId: string): Promise<VerifiedPrivyProfile> {
  const privy = getPrivyClient();
  const user: PrivyUser = await privy.users()._get(privyUserId);

  // Privy's real User type has no top-level `email` convenience field —
  // only `linked_accounts` (snake_case), a union of account types. Narrow
  // with both the discriminant and an `in` check rather than casting, so
  // this stays correct if the SDK's union shape changes under us.
  const linkedAccounts = user.linked_accounts ?? [];
  const emailAccount = linkedAccounts.find((a) => a.type === "email" && "address" in a);
  const walletAccount = linkedAccounts.find((a) => a.type === "wallet" && "address" in a);
  const email = emailAccount && "address" in emailAccount ? emailAccount.address : null;
  const walletAddress = walletAccount && "address" in walletAccount ? walletAccount.address : null;

  return { privyUserId, email: email ?? null, walletAddress: walletAddress ?? null };
}

/** Extracts a Bearer token from the Authorization header and verifies it
 * against Privy. Returns null (never throws) on anything short of a valid,
 * unexpired token — callers should treat null as "not authenticated" and
 * respond 401, not as a caught error to log and forget. */
export async function verifyPrivyAccessToken(request: Request): Promise<VerifiedPrivyIdentity | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const accessToken = authHeader.slice("Bearer ".length).trim();
  if (!accessToken) return null;

  try {
    const privy = getPrivyClient();
    const claims = await privy.utils().auth().verifyAccessToken(accessToken);
    if (!claims?.user_id) return null;
    return { privyUserId: claims.user_id };
  } catch (err) {
    // Expired/tampered/malformed token, or Privy unreachable — all the
    // same outcome from the CALLER's perspective: not authenticated, so
    // the return value here stays null either way. But collapsing every
    // failure into that one generic case at the log level too was a real
    // debugging cost — a missing PRIVY_APP_SECRET and an actually-expired
    // token look identical from outside this function without this line.
    // Server-side only, never reaches the client response.
    console.error("verifyPrivyAccessToken failed:", err);
    return null;
  }
}
