// lib/rateLimit.ts
//
// In-memory fixed-window counter + exponential-backoff lockout for
// login/session/role-change endpoints.
//
// ⚠ Known limitation, not a subtle bug: this is a process-local Map. On a
// single long-running dev server or a single traditional server process
// it works as described. On serverless (Vercel functions, most "npm run
// build && deploy" targets) each invocation can land on a different,
// possibly-cold instance with its own empty Map, meaning limits reset
// unpredictably and don't hold across instances. That's fine for this
// stage's purpose (proves the enforcement logic and shape is correct,
// which is what the tests check) but production deployment needs a
// shared store, Upstash Redis or Supabase-backed counters, swapped in
// behind the same checkRateLimit/recordFailure/recordSuccess interface.
import "server-only";

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
 * an attempt, pair with recordFailure()/recordSuccess() once the
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

  // Window expired since the first failure, start counting fresh rather
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

// ============================================================================
// checkQuota / checkDualQuota (Prompt 4, M1), a DIFFERENT shape from
// checkRateLimit above, deliberately. checkRateLimit is a failure-lockout:
// recordSuccess() wipes the bucket, so it's the wrong tool for "cap total
// volume regardless of outcome", a spam run of individually-valid dispute
// filings would never trip it. This is a plain fixed-window request
// counter instead: every call counts, success or not. Same in-memory-only
// caveat as the module comment above (process-local, resets on
// serverless cold starts), same "swap to Redis later behind this
// interface" plan applies here too.
// ============================================================================

interface QuotaBucket {
  windowStart: number;
  count: number;
}

const quotaBuckets = new Map<string, QuotaBucket>();

export interface QuotaResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

function checkQuota(key: string, maxPerWindow: number, windowMs: number): QuotaResult {
  const now = Date.now();
  const bucket = quotaBuckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    quotaBuckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  if (bucket.count >= maxPerWindow) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.windowStart + windowMs - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true };
}

/** "Rate-limit per IP AND per account", two independent gates, either one
 * tripping blocks the request. Used for dispute-filing and the Prompt 3
 * termination routes (cancel/abandon/withdraw), where every individual
 * call can look perfectly valid and checkRateLimit's failure-counting
 * wouldn't catch a volume spam run. */
export function checkDualQuota(action: string, ip: string, accountKey: string, maxPerWindow: number, windowMs: number): QuotaResult {
  const byIp = checkQuota(rateLimitKey(`${action}-ip`, ip), maxPerWindow, windowMs);
  if (!byIp.allowed) return byIp;
  return checkQuota(rateLimitKey(`${action}-account`, accountKey), maxPerWindow, windowMs);
}
