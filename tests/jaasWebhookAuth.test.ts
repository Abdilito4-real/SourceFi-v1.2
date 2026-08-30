// tests/jaasWebhookAuth.test.ts
//
// Unlike lib/yellowCardAuth.ts's webhook signature scheme (never
// verified against a real worked example, still an open item per
// README.md), 8x8 JaaS's docs (developer.8x8.com/jaas/docs/
// webhooks-signatures) publish a complete worked example: a fixed
// secret, timestamp, payload, and the exact expected signature. This
// test reproduces that example byte-for-byte, so this implementation
// is CONFIRMED correct against JaaS's own documentation, not just
// "confirmed textually" the way Yellow Card's still is.
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyJaasWebhookSignature, isJaasWebhookConfigured } from "../lib/jaasWebhookAuth";

// The exact worked example from developer.8x8.com/jaas/docs/webhooks-signatures.
const DOC_SECRET = "whsec_9635df66714a4cf088ee9d0979dd3bf6";
const DOC_TIMESTAMP = "1632490060";
const DOC_PAYLOAD =
  '{"eventType":"PARTICIPANT_JOINED","sessionId":"9a441d60-ceaf-4eba-b0a8-a7d940a76e1b","timestamp":1632490058278,"fqn":"vpaas-magic-cookie-96f0941768964ab380ed0fbada7a502f/sampleappromanticshiftsstripas","idempotencyKey":"9e9e7420-562d-4659-8e22-44b9b22aaa49","customerId":"96f0941768964ab380ed0fbada7a502f","appId":"vpaas-magic-cookie-96f0941768964ab380ed0fbada7a502f","data":{"avatar":"","name":"Test User","id":"auth0|5f903d7a77f3b4006eb8e67d","participantJid":"fc1ea14a-9bca-4218-a563-8c627e803d56@8x8.vc","moderator":true,"email":"test.user@company.com"}}';
const DOC_EXPECTED_SIGNATURE = "xlzqEojlh4qb21sQpXYsWgyK8x9HVpz+RQldsv18rV0=";

describe("verifyJaasWebhookSignature", () => {
  it("verifies against JaaS's own published worked example", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(DOC_TIMESTAMP) * 1000)); // "now" must be near the doc's own timestamp for the tolerance check
    const header = `t=${DOC_TIMESTAMP},v1=${DOC_EXPECTED_SIGNATURE}`;
    const result = verifyJaasWebhookSignature(DOC_PAYLOAD, header, DOC_SECRET);
    vi.useRealTimers();
    expect(result.valid).toBe(true);
    expect(result.timestampSeconds).toBe(Number(DOC_TIMESTAMP));
  });

  it("rejects a wrong secret", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(DOC_TIMESTAMP) * 1000));
    const header = `t=${DOC_TIMESTAMP},v1=${DOC_EXPECTED_SIGNATURE}`;
    const result = verifyJaasWebhookSignature(DOC_PAYLOAD, header, "whsec_wrong_secret_entirely");
    vi.useRealTimers();
    expect(result.valid).toBe(false);
  });

  it("rejects a tampered payload (signature no longer matches the body)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(DOC_TIMESTAMP) * 1000));
    const header = `t=${DOC_TIMESTAMP},v1=${DOC_EXPECTED_SIGNATURE}`;
    const tampered = DOC_PAYLOAD.replace("PARTICIPANT_JOINED", "PARTICIPANT_LEFT");
    const result = verifyJaasWebhookSignature(tampered, header, DOC_SECRET);
    vi.useRealTimers();
    expect(result.valid).toBe(false);
  });

  it("rejects a signature scheme other than v1 (downgrade attempt)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Number(DOC_TIMESTAMP) * 1000));
    const header = `t=${DOC_TIMESTAMP},v0=${DOC_EXPECTED_SIGNATURE}`; // no v1 present at all
    const result = verifyJaasWebhookSignature(DOC_PAYLOAD, header, DOC_SECRET);
    vi.useRealTimers();
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed header (missing t= or v1=)", () => {
    expect(verifyJaasWebhookSignature(DOC_PAYLOAD, "garbage", DOC_SECRET).valid).toBe(false);
    expect(verifyJaasWebhookSignature(DOC_PAYLOAD, `v1=${DOC_EXPECTED_SIGNATURE}`, DOC_SECRET).valid).toBe(false);
    expect(verifyJaasWebhookSignature(DOC_PAYLOAD, `t=${DOC_TIMESTAMP}`, DOC_SECRET).valid).toBe(false);
  });

  it("rejects a timestamp far outside the tolerance window, even with a correct signature for that timestamp", () => {
    // "now" is real time here (far from 2021), well outside 5 minutes
    // of the doc example's 2021 timestamp — this is exactly the replay-
    // protection case: a captured, genuinely-valid-at-the-time request
    // resent much later.
    const header = `t=${DOC_TIMESTAMP},v1=${DOC_EXPECTED_SIGNATURE}`;
    const result = verifyJaasWebhookSignature(DOC_PAYLOAD, header, DOC_SECRET);
    expect(result.valid).toBe(false);
  });
});

describe("isJaasWebhookConfigured", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is false when JAAS_WEBHOOK_SECRET isn't set", () => {
    delete process.env.JAAS_WEBHOOK_SECRET;
    expect(isJaasWebhookConfigured()).toBe(false);
  });

  it("is true once JAAS_WEBHOOK_SECRET is set", () => {
    process.env.JAAS_WEBHOOK_SECRET = "whsec_test";
    expect(isJaasWebhookConfigured()).toBe(true);
  });
});
