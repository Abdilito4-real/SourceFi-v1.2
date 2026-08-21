// lib/yellowCardAuth.ts
//
// Yellow Card's HMAC request signing, confirmed directly against their
// published docs (developers.circle... no, docs.yellowcard.engineering
// /docs/authentication-api), not guessed. Every authenticated request
// needs two headers:
//   X-YC-Timestamp: current datetime, ISO8601
//   Authorization: YcHmacV1 {apiKey}:{signature}
// where signature = base64(HMAC-SHA256(message, secretKey)) and
// message is the concatenation, in order, of:
//   1. the same ISO8601 datetime as X-YC-Timestamp
//   2. the request path only (no host), e.g. /business/receive
//   3. the request method in caps, e.g. POST
//   4. for POST/PUT only: base64(SHA256(request body))
// Their own documented example: a message like
// "2022-01-11T15:48:37.424Z/paymentPOSTuisbibf/sadf+==" — no
// delimiters between the parts, exactly as implemented below.
//
// Pure crypto primitive, no business logic, same "one file, one
// concern" shape as lib/circleWebhook.ts. Node's built-in `crypto`,
// same primitive lib/safeCompare.ts already uses, no new dependency.
import { createHash, createHmac, timingSafeEqual } from "crypto";

export interface YellowCardAuthHeaders {
  "X-YC-Timestamp": string;
  Authorization: string;
}

/** `path` must be path-only (no scheme/host/query beyond what Yellow
 * Card documents signing over — pass exactly what's requested). `body`
 * is the exact raw JSON string that will be sent, required for POST/PUT
 * (the body hash is part of the signed message), omit for GET/DELETE. */
export function signYellowCardRequest(apiKey: string, secretKey: string, method: string, path: string, body?: string): YellowCardAuthHeaders {
  const timestamp = new Date().toISOString();
  const methodUpper = method.toUpperCase();
  const bodyHashComponent = methodUpper === "POST" || methodUpper === "PUT" ? createHash("sha256").update(body ?? "", "utf8").digest("base64") : "";
  const message = `${timestamp}${path}${methodUpper}${bodyHashComponent}`;
  const signature = createHmac("sha256", secretKey).update(message, "utf8").digest("base64");
  return {
    "X-YC-Timestamp": timestamp,
    Authorization: `YcHmacV1 ${apiKey}:${signature}`,
  };
}

/** Webhook signature verification (X-YC-Signature header): "a base64
 * encoded sha256 hash of the request body using the secretkey of the
 * apiKey" per their Webhooks doc. Implemented as HMAC-SHA256(body,
 * secretKey), the standard reading of that phrase and consistent with
 * the request-signing scheme above; confirm against a real received
 * webhook once sandbox credentials exist, the docs don't show a literal
 * worked example for this one the way they do for request signing. */
export function verifyYellowCardWebhookSignature(rawBody: string, signatureBase64: string, secretKey: string): boolean {
  const expected = createHmac("sha256", secretKey).update(rawBody, "utf8").digest("base64");
  // Lengths are both fixed (base64 of a 32-byte HMAC-SHA256 digest), a
  // direct constant-time comparison is safe without lib/safeCompare.ts's
  // hash-first trick (that trick exists specifically for variable-length
  // secrets being compared directly).
  if (expected.length !== signatureBase64.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureBase64));
}
