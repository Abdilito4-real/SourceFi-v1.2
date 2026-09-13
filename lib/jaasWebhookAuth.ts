// lib/jaasWebhookAuth.ts
//
// 8x8 JaaS's webhook signature scheme, confirmed directly against their
// published docs (developer.8x8.com/jaas/docs/webhooks-signatures) —
// including a full worked example (fixed secret, timestamp, payload,
// and expected signature), unlike lib/yellowCardAuth.ts's webhook side,
// which had to be inferred from prose alone. tests/jaasWebhookAuth.test.ts
// verifies this implementation against that exact worked example, so
// this one is confirmed correct, not just "confirmed textually."
//
// Header shape: `X-Jaas-Signature: t=<unix seconds>,v1=<base64 HMAC>`.
// signed_payload = `${timestamp}.${rawBody}` (exact concatenation, no
// separator characters beyond the single `.`), HMAC-SHA256 over that
// string with the endpoint's own secret (revealed once in the JaaS
// Console's Webhooks section, see this file's registration note below),
// base64-encoded. "To prevent downgrade attacks, ignore all schemes
// that are not v1" — this only ever reads the v1 value, per their docs.
import { createHmac, timingSafeEqual } from "crypto";

export function isJaasWebhookConfigured(): boolean {
  return Boolean(process.env.JAAS_WEBHOOK_SECRET);
}

// "decide if the difference is within your tolerance" — their own
// wording, no specific number given. 5 minutes is generous for normal
// delivery/clock-skew while still bounding how old a captured-and-
// replayed signed request could be usefully replayed.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface JaasWebhookVerification {
  valid: boolean;
  /** Only meaningful when valid is true. */
  timestampSeconds?: number;
}

/** `headerValue` is the raw `X-Jaas-Signature` header string. `rawBody`
 * must be the exact bytes/string received (parsed-then-restringified
 * JSON is NOT guaranteed to byte-match what was signed — same rule
 * every other webhook verifier in this app follows). */
export function verifyJaasWebhookSignature(rawBody: string, headerValue: string, secret: string): JaasWebhookVerification {
  const parts = new Map<string, string>();
  for (const element of headerValue.split(",")) {
    const eq = element.indexOf("=");
    if (eq === -1) continue;
    parts.set(element.slice(0, eq).trim(), element.slice(eq + 1).trim());
  }

  const timestampRaw = parts.get("t");
  const signature = parts.get("v1"); // only v1 is a valid live scheme per JaaS's own docs
  if (!timestampRaw || !signature) return { valid: false };

  const timestampSeconds = Number(timestampRaw);
  if (!Number.isFinite(timestampSeconds)) return { valid: false };

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS) return { valid: false };

  const signedPayload = `${timestampRaw}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest("base64");

  // Lengths can legitimately differ (a forged signature of the wrong
  // length), guard before timingSafeEqual, which throws on a length
  // mismatch rather than just returning false — same pattern
  // lib/yellowCardAuth.ts's webhook verifier already uses.
  if (expected.length !== signature.length) return { valid: false };
  const valid = timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  return valid ? { valid: true, timestampSeconds } : { valid: false };
}
