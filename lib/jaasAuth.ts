// lib/jaasAuth.ts
//
// meet.jit.si (the free public server this app defaults to, see
// components/JitsiMeetRoom.tsx) gates brand-new/empty rooms behind a
// "log in to become a moderator, otherwise wait" screen, an anti-abuse
// measure on their shared multi-tenant service, not something a client-
// side config flag can turn off. 8x8 JaaS (Jitsi-as-a-Service) removes
// it entirely: this app signs a JWT server-side identifying the caller
// as an authenticated moderator on ITS OWN tenant, so there's no
// anonymous-guest gate to hit in the first place.
//
// Same "real the moment credentials exist, otherwise fall back" posture
// as lib/paymentProvider.ts: with no JAAS_* env vars set, this returns
// null and JitsiMeetRoom.tsx falls back to the plain meet.jit.si join
// (occasional "please wait" screen included) it always has.
import "server-only";
import { SignJWT, importPKCS8 } from "jose";
import type { JaasCallConfig } from "./types";

export function isJaasConfigured(): boolean {
  return Boolean(process.env.JAAS_APP_ID && process.env.JAAS_API_KEY_ID && process.env.JAAS_PRIVATE_KEY);
}

const JWT_TTL_SECONDS = 60 * 60; // 1h, generous for a verification call, short-lived on purpose

/** Mints a fresh, single-purpose JWT for one party joining one room.
 * Both buyer and supplier get `moderator: true`, this call has no real
 * hierarchy between them, unlike a classroom/webinar Jitsi use case, so
 * there's nothing to withhold from either side. Returns null (not a
 * thrown error) when JaaS isn't configured, callers treat that as
 * "use the free public server instead," not a failure. */
export async function buildJaasCallConfig(roomId: string, userId: string, displayName: string): Promise<JaasCallConfig | null> {
  const appId = process.env.JAAS_APP_ID;
  const apiKeyId = process.env.JAAS_API_KEY_ID;
  const privateKeyPem = process.env.JAAS_PRIVATE_KEY;
  if (!appId || !apiKeyId || !privateKeyPem) return null;

  try {
    // .env files don't survive literal newlines well, the documented
    // workaround (see .env.local.example) is storing the PEM with \n
    // escape sequences and un-escaping here.
    const privateKey = await importPKCS8(privateKeyPem.replace(/\\n/g, "\n"), "RS256");
    const now = Math.floor(Date.now() / 1000);

    const jwt = await new SignJWT({
      context: {
        user: { id: String(userId), name: displayName, moderator: true },
        // Every JaaS feature this call doesn't use, explicitly off
        // rather than left to JaaS's own defaults.
        features: { livestreaming: false, recording: false, transcription: false, "outbound-call": false },
      },
      // Scoped to THIS order's room only, not "*". A wildcard here would
      // mean a leaked/replayed token (server logs, a browser network
      // tab, any future bug that exposes a roomId to the wrong party)
      // grants moderator access to every room on this tenant, not just
      // the one it was actually minted for — the room id's own secrecy
      // (see components/JitsiMeetRoom.tsx's header comment) would then
      // be the ONLY thing enforcing per-order isolation, instead of a
      // second, independent layer the token itself enforces.
      room: roomId,
    })
      .setProtectedHeader({ alg: "RS256", kid: apiKeyId, typ: "JWT" })
      .setIssuer("chat")
      .setAudience("jitsi")
      .setSubject(appId)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + JWT_TTL_SECONDS)
      .sign(privateKey);

    return { domain: "8x8.vc", roomName: `${appId}/${roomId}`, jwt };
  } catch (err) {
    // A malformed JAAS_PRIVATE_KEY shouldn't take the whole order-detail
    // route down, fall back to the free server exactly like "not
    // configured" does.
    console.error("buildJaasCallConfig: failed to sign JWT, falling back to meet.jit.si:", err);
    return null;
  }
}
