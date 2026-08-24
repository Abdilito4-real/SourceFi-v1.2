// lib/circleWebhook.ts
//
// The pure signature-verification primitive for Circle's real webhook
// notifications. Circle signs every notification POST and documents the
// mechanism directly in its own SDK JSDoc (verified against the
// installed @circle-fin/developer-controlled-wallets package, not
// assumed): the request carries `X-Circle-Signature` (the signature) and
// `X-Circle-Key-Id` (which public key signed it), and
// client.getNotificationSignature(keyId) returns that key's
// {algorithm, publicKey}. This module only does the crypto verification
// once the caller (lib/circleEscrowProvider.ts's verifyWebhookSignature,
// which owns fetching/caching the key) has both pieces in hand.
//
// Deliberately no dependency on Circle's exact NOTIFICATION BODY schema,
// only the SIGNATURE mechanism, which the SDK's own JSDoc documents
// precisely. The webhook route (app/api/webhooks/circle/route.ts) does
// not trust body fields for money-relevant state either, see that
// file's own comment.
//
// FOUND WHILE REGISTERING THE FIRST REAL WEBHOOK: the value
// client.getNotificationSignature(keyId) returns is raw base64-encoded
// DER (SPKI format), NOT a PEM string, confirmed directly against
// Circle's own "How-to: Verify webhook signatures" doc (its own Node
// example wraps it with createPublicKey({format: "der", type: "spki"})
// before ever calling .verify()). Passing that raw base64 straight into
// createVerify().verify() as if it were already PEM crashed with a
// Node crypto DECODER "unsupported" error — verification never actually
// worked, and Circle's own webhook-registration validation ping (which
// exercises this same code path) failed as a direct result.
import { createVerify, createPublicKey } from "crypto";

/** Circle's documented signing algorithm string -> the Node.js digest
 * name crypto.createVerify() expects. An explicit allowlist on purpose:
 * an algorithm this app doesn't recognize is rejected outright rather
 * than guessed at, same posture lib/safeCompare.ts's constant-time
 * comparison takes toward not cutting corners on a security primitive. */
const ALGORITHM_MAP: Record<string, string> = {
  ECDSA_SHA_256: "sha256",
};

export class UnsupportedSignatureAlgorithmError extends Error {
  constructor(algorithm: string) {
    super(`Circle notification signature algorithm "${algorithm}" is not in this app's allowlist. Refusing to verify.`);
    this.name = "UnsupportedSignatureAlgorithmError";
  }
}

/** Verifies a raw request body against a base64 signature, using the
 * base64 DER (SPKI) public key + Circle algorithm name returned by
 * client.getNotificationSignature(). `rawBody` MUST be the exact,
 * unmodified request body bytes (as text) Circle signed, never a
 * re-serialized JSON.parse/stringify round trip, which is not
 * guaranteed to reproduce the same bytes.
 *
 * `publicKeyBase64Der` is exactly what Circle's API returns in
 * `publicKey` — raw base64 DER, not PEM — imported here via
 * createPublicKey({format: "der", type: "spki"}), the same conversion
 * Circle's own docs example does, rather than handed to
 * createVerify().verify() as a bare string (that used to be this
 * function's bug: Node's crypto module has no way to auto-detect a
 * PEM-less DER blob, and threw a DECODER "unsupported" error instead of
 * ever actually verifying anything). */
export function verifyCircleNotificationSignature(rawBody: string, signatureBase64: string, publicKeyBase64Der: string, circleAlgorithm: string): boolean {
  const nodeDigest = ALGORITHM_MAP[circleAlgorithm];
  if (!nodeDigest) throw new UnsupportedSignatureAlgorithmError(circleAlgorithm);
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyBase64Der, "base64"), format: "der", type: "spki" });
  return createVerify(nodeDigest).update(rawBody, "utf8").verify(publicKey, signatureBase64, "base64");
}
