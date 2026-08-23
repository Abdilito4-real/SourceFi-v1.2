// tests/supabaseUserClient.test.ts
//
// Real RLS pilot: the JWT claim shape minted here is the security-
// relevant part of lib/supabaseUserClient.ts — get `role` wrong and
// PostgREST never switches off `anon`, so migration 0017's policies
// never apply at all (silently back to "everyone denied", not a
// security hole, but a silent no-op pilot); get `user_row_id` wrong
// and the policy could scope a query to the WRONG user's rows. Both
// worth a direct test, not just trusting the code by inspection.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { jwtVerify } from "jose";
import { mintUserAccessToken, isUserScopedSupabaseConfigured } from "../lib/supabaseUserClient";

const TEST_SECRET = "test-supabase-jwt-secret-at-least-this-long";

beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
});

afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.SUPABASE_ANON_KEY;
});

describe("mintUserAccessToken", () => {
  it("mints a token that verifies against the configured secret", async () => {
    const token = await mintUserAccessToken(42);
    await expect(jwtVerify(token, new TextEncoder().encode(TEST_SECRET))).resolves.toBeTruthy();
  });

  it("carries role=authenticated, the actual PostgREST role switch — without this every policy is unreachable", async () => {
    const token = await mintUserAccessToken(42);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_SECRET));
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
  });

  it("carries the real user id as the custom user_row_id claim, the one RLS policies actually read", async () => {
    const token = await mintUserAccessToken(42);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_SECRET));
    expect(payload.user_row_id).toBe(42);
  });

  it("different users get different tokens with the correct, distinct user_row_id each time", async () => {
    const tokenA = await mintUserAccessToken(1);
    const tokenB = await mintUserAccessToken(2);
    const [{ payload: payloadA }, { payload: payloadB }] = await Promise.all([
      jwtVerify(tokenA, new TextEncoder().encode(TEST_SECRET)),
      jwtVerify(tokenB, new TextEncoder().encode(TEST_SECRET)),
    ]);
    expect(payloadA.user_row_id).toBe(1);
    expect(payloadB.user_row_id).toBe(2);
    expect(tokenA).not.toBe(tokenB);
  });

  it("sub is a deterministic, valid UUID (not the real user id), so auth.uid() never errors if referenced", async () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const tokenA1 = await mintUserAccessToken(7);
    const tokenA2 = await mintUserAccessToken(7);
    const tokenB = await mintUserAccessToken(8);
    const [{ payload: a1 }, { payload: a2 }, { payload: b }] = await Promise.all([
      jwtVerify(tokenA1, new TextEncoder().encode(TEST_SECRET)),
      jwtVerify(tokenA2, new TextEncoder().encode(TEST_SECRET)),
      jwtVerify(tokenB, new TextEncoder().encode(TEST_SECRET)),
    ]);
    expect(a1.sub).toMatch(UUID_RE);
    expect(a1.sub).toBe(a2.sub); // deterministic for the same user
    expect(a1.sub).not.toBe(b.sub); // distinct across users
  });

  it("expires quickly (short TTL, minted fresh per request, never reused)", async () => {
    const token = await mintUserAccessToken(42);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_SECRET));
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(60);
  });

  it("throws a clear error rather than minting an unsigned/garbage token when the secret is unset", async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    await expect(mintUserAccessToken(42)).rejects.toThrow(/SUPABASE_JWT_SECRET/);
  });
});

describe("isUserScopedSupabaseConfigured", () => {
  it("false when SUPABASE_ANON_KEY is missing, even with the JWT secret set", () => {
    expect(isUserScopedSupabaseConfigured()).toBe(false);
  });

  it("true once both required env vars are set", () => {
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    expect(isUserScopedSupabaseConfigured()).toBe(true);
  });
});
