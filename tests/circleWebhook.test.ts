// tests/circleWebhook.test.ts
//
// Covers verifyCircleNotificationSignature — genuinely uncovered before
// this file existed. Found the hard way: registering the first real
// Circle webhook triggered Circle's own validation ping, which crashed
// with a Node crypto DECODER "unsupported" error because the function
// was handing Circle's raw base64 DER public key straight to
// createVerify().verify() as if it were already PEM. A real EC key
// pair here (not a fixture string) exercises the exact same
// createPublicKey({format: "der", type: "spki"}) conversion path that
// was missing, so this would have caught the bug before it ever reached
// a real webhook.
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createSign } from "crypto";
import { verifyCircleNotificationSignature, UnsupportedSignatureAlgorithmError } from "../lib/circleWebhook";

function makeSignedNotification(body: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // Exactly the shape Circle's API actually returns (confirmed against
  // developers.circle.com's "How-to: Verify webhook signatures" doc):
  // raw base64 DER (SPKI), not PEM.
  const publicKeyBase64Der = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signatureBase64 = createSign("sha256").update(body, "utf8").sign(privateKey, "base64");
  return { publicKeyBase64Der, signatureBase64 };
}

describe("verifyCircleNotificationSignature", () => {
  it("verifies a real ECDSA_SHA_256 signature against Circle's actual base64-DER public key shape", () => {
    const body = JSON.stringify({ notificationType: "transactions.outbound", notification: { id: "txn-1", state: "COMPLETE" } });
    const { publicKeyBase64Der, signatureBase64 } = makeSignedNotification(body);

    expect(verifyCircleNotificationSignature(body, signatureBase64, publicKeyBase64Der, "ECDSA_SHA_256")).toBe(true);
  });

  it("rejects a signature that doesn't match the body (tampered payload)", () => {
    const body = JSON.stringify({ notification: { state: "COMPLETE" } });
    const { publicKeyBase64Der, signatureBase64 } = makeSignedNotification(body);

    const tamperedBody = JSON.stringify({ notification: { state: "FAILED" } });
    expect(verifyCircleNotificationSignature(tamperedBody, signatureBase64, publicKeyBase64Der, "ECDSA_SHA_256")).toBe(false);
  });

  it("rejects a signature verified against the wrong public key", () => {
    const body = JSON.stringify({ notification: { state: "COMPLETE" } });
    const { signatureBase64 } = makeSignedNotification(body);
    const { publicKeyBase64Der: wrongKey } = makeSignedNotification("unrelated");

    expect(verifyCircleNotificationSignature(body, signatureBase64, wrongKey, "ECDSA_SHA_256")).toBe(false);
  });

  it("throws UnsupportedSignatureAlgorithmError for anything not on the allowlist, never silently guesses", () => {
    const body = "irrelevant";
    const { publicKeyBase64Der, signatureBase64 } = makeSignedNotification(body);

    expect(() => verifyCircleNotificationSignature(body, signatureBase64, publicKeyBase64Der, "RSA_SHA_256")).toThrow(
      UnsupportedSignatureAlgorithmError
    );
  });
});
