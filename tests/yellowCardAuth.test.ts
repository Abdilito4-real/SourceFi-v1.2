// tests/yellowCardAuth.test.ts
//
// The HMAC signing scheme this app talks Yellow Card's real API with —
// get the message format wrong and every real request fails
// authentication, silently and unhelpfully (their API just returns
// 401). Verified directly against docs.yellowcard.engineering's own
// documented format, see lib/yellowCardAuth.ts's header.
import { describe, it, expect } from "vitest";
import { createHmac, createHash } from "crypto";
import { signYellowCardRequest, verifyYellowCardWebhookSignature } from "../lib/yellowCardAuth";

const SECRET = "test-secret-key";

describe("signYellowCardRequest", () => {
  it("produces the documented header names", () => {
    const headers = signYellowCardRequest("key", SECRET, "GET", "/business/receive/abc");
    expect(headers).toHaveProperty("X-YC-Timestamp");
    expect(headers).toHaveProperty("Authorization");
  });

  it("Authorization follows the YcHmacV1 {apiKey}:{signature} scheme", () => {
    const headers = signYellowCardRequest("my-api-key", SECRET, "GET", "/business/receive/abc");
    expect(headers.Authorization).toMatch(/^YcHmacV1 my-api-key:.+$/);
  });

  it("X-YC-Timestamp is a valid ISO8601 datetime", () => {
    const headers = signYellowCardRequest("key", SECRET, "GET", "/business/receive/abc");
    expect(new Date(headers["X-YC-Timestamp"]).toISOString()).toBe(headers["X-YC-Timestamp"]);
  });

  it("GET signs timestamp+path+METHOD with no body-hash component", () => {
    const headers = signYellowCardRequest("key", SECRET, "get", "/business/receive/abc");
    const message = `${headers["X-YC-Timestamp"]}/business/receive/abcGET`;
    const expectedSignature = createHmac("sha256", SECRET).update(message, "utf8").digest("base64");
    expect(headers.Authorization).toBe(`YcHmacV1 key:${expectedSignature}`);
  });

  it("POST/PUT append base64(sha256(body)) to the signed message", () => {
    const body = JSON.stringify({ amount: 5000 });
    const headers = signYellowCardRequest("key", SECRET, "POST", "/business/receive", body);
    const bodyHash = createHash("sha256").update(body, "utf8").digest("base64");
    const message = `${headers["X-YC-Timestamp"]}/business/receivePOST${bodyHash}`;
    const expectedSignature = createHmac("sha256", SECRET).update(message, "utf8").digest("base64");
    expect(headers.Authorization).toBe(`YcHmacV1 key:${expectedSignature}`);
  });

  it("a different secret key produces a different signature for the same request", () => {
    const a = signYellowCardRequest("key", "secret-a", "GET", "/business/receive/abc");
    const b = signYellowCardRequest("key", "secret-b", "GET", "/business/receive/abc");
    expect(a.Authorization).not.toBe(b.Authorization);
  });
});

describe("verifyYellowCardWebhookSignature", () => {
  it("accepts a correctly computed HMAC-SHA256(body, secretKey) signature", () => {
    const body = JSON.stringify({ id: "abc", status: "complete", event: "RECEIVE.COMPLETE" });
    const signature = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
    expect(verifyYellowCardWebhookSignature(body, signature, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ id: "abc", status: "complete" });
    const signature = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
    const tamperedBody = JSON.stringify({ id: "abc", status: "failed" });
    expect(verifyYellowCardWebhookSignature(tamperedBody, signature, SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = JSON.stringify({ id: "abc" });
    const wrongSignature = createHmac("sha256", "not-the-real-secret").update(body, "utf8").digest("base64");
    expect(verifyYellowCardWebhookSignature(body, wrongSignature, SECRET)).toBe(false);
  });

  it("rejects a malformed/wrong-length signature without throwing", () => {
    expect(verifyYellowCardWebhookSignature("{}", "not-base64-and-wrong-length", SECRET)).toBe(false);
  });
});
