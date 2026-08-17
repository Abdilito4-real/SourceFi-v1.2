// tests/jaasAuth.test.ts
//
// lib/jaasAuth.ts's whole job is "real once all three env vars are set,
// null fallback otherwise", same posture as lib/paymentProvider.ts, plus
// the actual JWT it mints needs the right shape (jose's own jwtVerify
// against the matching public key is the real proof, not just "it
// didn't throw").
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "crypto";
import { jwtVerify, importSPKI } from "jose";
import { isJaasConfigured, buildJaasCallConfig } from "../lib/jaasAuth";

const ORIGINAL_ENV = { ...process.env };

function generateTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("isJaasConfigured", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is false unless all three env vars are set", () => {
    delete process.env.JAAS_APP_ID;
    delete process.env.JAAS_API_KEY_ID;
    delete process.env.JAAS_PRIVATE_KEY;
    expect(isJaasConfigured()).toBe(false);

    process.env.JAAS_APP_ID = "app-id";
    process.env.JAAS_API_KEY_ID = "key-id";
    expect(isJaasConfigured()).toBe(false); // still missing the private key

    process.env.JAAS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\n...";
    expect(isJaasConfigured()).toBe(true);
  });
});

describe("buildJaasCallConfig", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns null when JaaS isn't configured, the meet.jit.si fallback signal", async () => {
    delete process.env.JAAS_APP_ID;
    delete process.env.JAAS_API_KEY_ID;
    delete process.env.JAAS_PRIVATE_KEY;
    const result = await buildJaasCallConfig("room-123", "42", "SourceFi Buyer");
    expect(result).toBeNull();
  });

  it("mints a JWT that actually verifies against the matching public key, with the right claims", async () => {
    const { privateKeyPem, publicKeyPem } = generateTestKeyPair();
    process.env.JAAS_APP_ID = "vpaas-magic-app-id";
    process.env.JAAS_API_KEY_ID = "vpaas-magic-key-id";
    // Round-trips through the same \n-escaping the real .env file needs.
    process.env.JAAS_PRIVATE_KEY = privateKeyPem.replace(/\n/g, "\\n");

    const result = await buildJaasCallConfig("room-123", "42", "SourceFi Buyer");
    expect(result).not.toBeNull();
    expect(result!.domain).toBe("8x8.vc");
    // Namespaced under the App ID, never the bare room name, or this
    // would collide with every other JaaS tenant's room of that name.
    expect(result!.roomName).toBe("vpaas-magic-app-id/room-123");

    const publicKey = await importSPKI(publicKeyPem, "RS256");
    const { payload, protectedHeader } = await jwtVerify(result!.jwt, publicKey, {
      issuer: "chat",
      audience: "jitsi",
      subject: "vpaas-magic-app-id",
    });
    expect(protectedHeader.kid).toBe("vpaas-magic-key-id");
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.room).toBe("*");
    const context = payload.context as { user: { id: string; name: string; moderator: boolean } };
    expect(context.user).toEqual({ id: "42", name: "SourceFi Buyer", moderator: true });
  });

  it("returns null (not a thrown error) on a malformed private key, falling back rather than 500ing the order-detail route", async () => {
    process.env.JAAS_APP_ID = "app-id";
    process.env.JAAS_API_KEY_ID = "key-id";
    process.env.JAAS_PRIVATE_KEY = "not-a-real-pem-key";
    const result = await buildJaasCallConfig("room-123", "42", "SourceFi Buyer");
    expect(result).toBeNull();
  });
});
