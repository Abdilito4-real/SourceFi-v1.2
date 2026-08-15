// lib/rateLimit.ts
//
// In-memory fixed-window counter + exponential-backoff lockout for
// login/session/role-change endpoints.
//
// ⚠ Known limitation, not a subtle bug: this is a process-local Map. On a
// single long-running dev server or a single traditional server process
// it works as described. On serverless (Vercel functions, most "npm run
// build && deploy" targets) each invocation can land on a different,
// possibly-cold instance with its own empty Map — meaning limits reset
// unpredictably and don't hold across instances. That's fine for this
// stage's purpose (proves the enforcement logic and shape is correct,
// which is what the tests check) but production deployment needs a
// shared store — Upstash Redis or Supabase-backed counters — swapped in
// behind the same checkRateLimit/recordFailure/recordSuccess interface.
interface Bucket {
  failureCount: number;
  firstFailureAt: number;
  lockedUntil: number | null;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 15 * 60 * 1000; // failures older than this don't count
const BASE_LOCKOUT_MS = 2000; // first lockout: 2s
const MAX_LOCKOUT_MS = 15 * 60 * 1000; // cap at 15 minutes
const LOCKOUT_AFTER_FAILURES = 3; // allow this many free tries before backing off

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/** Call before attempting the protected action. Does not itself count as
 * an attempt — pair with recordFailure()/recordSuccess() once the
 * action's real outcome is known. */
export function checkRateLimit(key: string): RateLimitResult {
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true };

  if (bucket.lockedUntil && bucket.lockedUntil > Date.now()) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.lockedUntil - Date.now()) / 1000) };
  }
  return { allowed: true };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const existing = buckets.get(key);

  // Window expired since the first failure — start counting fresh rather
  // than let a stale streak from an hour ago compound into today's lockout.
  const bucket: Bucket =
    existing && now - existing.firstFailureAt < WINDOW_MS
      ? existing
      : { failureCount: 0, firstFailureAt: now, lockedUntil: null };

  bucket.failureCount += 1;

  if (bucket.failureCount > LOCKOUT_AFTER_FAILURES) {
    const exponent = bucket.failureCount - LOCKOUT_AFTER_FAILURES - 1;
    const lockoutMs = Math.min(BASE_LOCKOUT_MS * 2 ** exponent, MAX_LOCKOUT_MS);
    bucket.lockedUntil = now + lockoutMs;
  }

  buckets.set(key, bucket);
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/** Build a stable rate-limit key from the action name plus whatever
 * identifies the caller (IP for pre-auth actions like login; email once
 * an identity is known). Keeping action in the key means a lockout on
 * login doesn't also lock out an unrelated action from the same IP. */
export function rateLimitKey(action: string, identifier: string): string {
  return `${action}:${identifier}`;
}
