// tests/rateLimit.test.ts
//
// Part 3 of the production-hardening pass: lib/rateLimit.ts moved from
// an in-memory Map to Supabase-backed RPC calls (migration
// 0016_rate_limiting.sql). Tested here the same way
// lib/supplierVerification.ts's is_supplier_currently_verified() RPC
// call is tested elsewhere (tests/orderService.test.ts, etc.):
// FakeSupabase.setRpc() backed by a plain JS re-implementation of the
// SQL function's logic.
//
// HONEST LIMITATION, stated once here rather than left implicit: this
// proves checkRateLimit/recordFailure/recordSuccess/checkDualQuota call
// the right RPC with the right arguments and interpret the result
// correctly (the call-shape contract), and that the JS re-implementation
// of the exponential-backoff/fixed-window math matches what the module
// used to do in-memory. It does NOT prove the real Postgres functions'
// row-locking is race-free under true concurrent connections, that
// guarantee comes from Postgres's own `select ... for update` semantics,
// not from this fixture, same distinction docs/security.md's own
// race-condition section draws for the order-approval CAS test.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeSupabase, asSupabaseClient } from "./testUtils/fakeSupabase";

vi.mock("../lib/supabaseServer", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { getSupabaseServerClient } from "../lib/supabaseServer";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey, checkDualQuota } from "../lib/rateLimit";

const WINDOW_MS = 15 * 60 * 1000;
const BASE_LOCKOUT_MS = 2000;
const MAX_LOCKOUT_MS = 15 * 60 * 1000;
const LOCKOUT_AFTER_FAILURES = 3;

interface FailureBucket {
  failureCount: number;
  firstFailureAt: number;
  lockedUntil: number | null;
}

interface QuotaBucket {
  windowStart: number;
  count: number;
}

/** Wires a fresh FakeSupabase's RPC handlers to the same logic
 * migration 0016's rl_check_rate_limit / rl_record_failure /
 * rl_record_success / rl_check_quota implement in SQL, keyed by the
 * same `p_key` arguments lib/rateLimit.ts sends. `now` is a mutable box
 * so tests can fast-forward time without a real clock dependency. */
function wireRateLimitRpcs(fake: FakeSupabase, now: { value: number }) {
  const failureBuckets = new Map<string, FailureBucket>();
  const quotaBuckets = new Map<string, QuotaBucket>();

  fake.setRpc("rl_check_rate_limit", (args) => {
    const bucket = failureBuckets.get(args.p_key as string);
    if (bucket?.lockedUntil && bucket.lockedUntil > now.value) {
      return [{ allowed: false, retry_after_seconds: Math.ceil((bucket.lockedUntil - now.value) / 1000) }];
    }
    return [{ allowed: true, retry_after_seconds: null }];
  });

  fake.setRpc("rl_record_failure", (args) => {
    const key = args.p_key as string;
    const existing = failureBuckets.get(key);
    const bucket: FailureBucket =
      existing && now.value - existing.firstFailureAt < (args.p_window_ms as number)
        ? existing
        : { failureCount: 0, firstFailureAt: now.value, lockedUntil: null };
    bucket.failureCount += 1;
    if (bucket.failureCount > (args.p_lockout_after as number)) {
      const exponent = bucket.failureCount - (args.p_lockout_after as number) - 1;
      const lockoutMs = Math.min((args.p_base_lockout_ms as number) * 2 ** exponent, args.p_max_lockout_ms as number);
      bucket.lockedUntil = now.value + lockoutMs;
    } else {
      bucket.lockedUntil = null;
    }
    failureBuckets.set(key, bucket);
    return bucket.lockedUntil;
  });

  fake.setRpc("rl_record_success", (args) => {
    failureBuckets.delete(args.p_key as string);
    return null;
  });

  fake.setRpc("rl_check_quota", (args) => {
    const key = args.p_key as string;
    const maxPerWindow = args.p_max_per_window as number;
    const windowMs = args.p_window_ms as number;
    const existing = quotaBuckets.get(key);
    if (!existing || now.value - existing.windowStart >= windowMs) {
      quotaBuckets.set(key, { windowStart: now.value, count: 1 });
      return [{ allowed: true, retry_after_seconds: null }];
    }
    if (existing.count >= maxPerWindow) {
      return [{ allowed: false, retry_after_seconds: Math.ceil((existing.windowStart + windowMs - now.value) / 1000) }];
    }
    existing.count += 1;
    return [{ allowed: true, retry_after_seconds: null }];
  });
}

let now: { value: number };

beforeEach(() => {
  now = { value: Date.now() };
  const fake = new FakeSupabase();
  wireRateLimitRpcs(fake, now);
  vi.mocked(getSupabaseServerClient).mockReturnValue(asSupabaseClient(fake));
});

describe("checkRateLimit / recordFailure / recordSuccess", () => {
  it("allows the first LOCKOUT_AFTER_FAILURES failures with no lockout", async () => {
    const key = rateLimitKey("test-action", "user@example.com");
    for (let i = 0; i < LOCKOUT_AFTER_FAILURES; i++) {
      await recordFailure(key);
      expect((await checkRateLimit(key)).allowed).toBe(true);
    }
  });

  it("locks out after exceeding LOCKOUT_AFTER_FAILURES, with an exponentially growing lockout", async () => {
    const key = rateLimitKey("test-action", "user@example.com");
    for (let i = 0; i < LOCKOUT_AFTER_FAILURES; i++) await recordFailure(key);

    await recordFailure(key); // 4th failure, first over the threshold
    const first = await checkRateLimit(key);
    expect(first.allowed).toBe(false);
    expect(first.retryAfterSeconds).toBe(Math.ceil(BASE_LOCKOUT_MS / 1000));

    // Time passes the first lockout, a 5th failure locks out for LONGER
    // (exponential backoff), not the same fixed duration again.
    now.value += BASE_LOCKOUT_MS + 1;
    await recordFailure(key);
    const second = await checkRateLimit(key);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBe(Math.ceil((BASE_LOCKOUT_MS * 2) / 1000));
  });

  it("recordSuccess wipes the failure streak entirely", async () => {
    const key = rateLimitKey("test-action", "user@example.com");
    for (let i = 0; i < LOCKOUT_AFTER_FAILURES + 1; i++) await recordFailure(key);
    expect((await checkRateLimit(key)).allowed).toBe(false);

    await recordSuccess(key);
    expect((await checkRateLimit(key)).allowed).toBe(true);
  });

  it("a failure streak older than WINDOW_MS resets instead of compounding", async () => {
    const key = rateLimitKey("test-action", "user@example.com");
    for (let i = 0; i < LOCKOUT_AFTER_FAILURES + 1; i++) await recordFailure(key);
    expect((await checkRateLimit(key)).allowed).toBe(false);

    now.value += WINDOW_MS + BASE_LOCKOUT_MS * 4 + 1; // well past both the window AND the first lockout
    await recordFailure(key); // only the 1st failure of a fresh window
    expect((await checkRateLimit(key)).allowed).toBe(true);
  });

  it("caps the lockout duration at MAX_LOCKOUT_MS however many failures pile up", async () => {
    const key = rateLimitKey("test-action", "user@example.com");
    for (let i = 0; i < 20; i++) {
      await recordFailure(key);
      now.value += 1; // stay within WINDOW_MS so the streak keeps compounding
    }
    const result = await checkRateLimit(key);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(Math.ceil(MAX_LOCKOUT_MS / 1000));
  });

  it("different actions for the same identifier don't share a lockout", async () => {
    for (let i = 0; i < LOCKOUT_AFTER_FAILURES + 1; i++) await recordFailure(rateLimitKey("action-a", "user@example.com"));
    expect((await checkRateLimit(rateLimitKey("action-a", "user@example.com"))).allowed).toBe(false);
    expect((await checkRateLimit(rateLimitKey("action-b", "user@example.com"))).allowed).toBe(true);
  });
});

describe("checkDualQuota", () => {
  const WINDOW_MS_QUOTA = 10 * 60 * 1000;
  const MAX_PER_WINDOW = 8;

  it("allows up to maxPerWindow calls, then blocks", async () => {
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      expect((await checkDualQuota("dispute-file", "1.2.3.4", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA)).allowed).toBe(true);
    }
    const blocked = await checkDualQuota("dispute-file", "1.2.3.4", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA);
    expect(blocked.allowed).toBe(false);
  });

  it("blocks on EITHER the IP gate or the account gate tripping, whichever comes first", async () => {
    // Exhaust the IP gate using two different accounts sharing the same
    // IP, the account gate alone would never trip for either account.
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      await checkDualQuota("dispute-file", "9.9.9.9", `user${i}@example.com`, MAX_PER_WINDOW, WINDOW_MS_QUOTA);
    }
    const result = await checkDualQuota("dispute-file", "9.9.9.9", "brand-new-user@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA);
    expect(result.allowed).toBe(false); // the IP gate blocks it even though this account never called before
  });

  it("a window reset allows calls again", async () => {
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      await checkDualQuota("order-terminate", "5.5.5.5", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA);
    }
    expect((await checkDualQuota("order-terminate", "5.5.5.5", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA)).allowed).toBe(false);

    now.value += WINDOW_MS_QUOTA + 1;
    expect((await checkDualQuota("order-terminate", "5.5.5.5", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA)).allowed).toBe(true);
  });

  it("every call counts toward the quota regardless of the caller's own success/failure", async () => {
    // The entire reason checkDualQuota exists instead of reusing
    // checkRateLimit: a run of individually-VALID calls (no failures at
    // all) must still trip this, unlike the failure-lockout above.
    for (let i = 0; i < MAX_PER_WINDOW; i++) {
      const result = await checkDualQuota("dispute-file", "7.7.7.7", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA);
      expect(result.allowed).toBe(true);
    }
    expect((await checkDualQuota("dispute-file", "7.7.7.7", "buyer@example.com", MAX_PER_WINDOW, WINDOW_MS_QUOTA)).allowed).toBe(false);
  });
});
