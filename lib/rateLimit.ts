// lib/rateLimit.ts
//
// Part 3 of the production-hardening pass: Supabase-backed instead of an
// in-memory Map. The module header used to document exactly this as the
// known gap ("production deployment needs a shared store... swapped in
// behind the same checkRateLimit/recordFailure/recordSuccess
// interface") — this file now does that swap. Every exported name is
// unchanged; the SQL side (migration 0016_rate_limiting.sql) does the
// atomic read-modify-write via `rl_*` Postgres functions, following the
// existing supabase.rpc() pattern in lib/supplierVerification.ts. The
// one call-site ripple: every function here is now async, so every
// caller needs `await` (see the 9 call sites this rewrite touched).
import "server-only";
import { getSupabaseServerClient } from "./supabaseServer";

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
export async function checkRateLimit(key: string): Promise<RateLimitResult> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.rpc("rl_check_rate_limit", { p_key: key });
  if (error) {
    // Fails OPEN (allowed: true) rather than blocking every request if
    // the rate-limit store itself is unreachable, same posture
    // lib/fxRate.ts takes toward "fail loudly, don't guess" for a
    // DIFFERENT kind of failure (there, blocking IS the safe default;
    // here, blocking every login/action because a lookup table is
    // temporarily unreachable would turn an availability blip into a
    // full outage for something that exists to slow down abuse, not to
    // gate normal traffic).
    console.error(`rl_check_rate_limit failed for key ${key}:`, error);
    return { allowed: true };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { allowed: row?.allowed ?? true, retryAfterSeconds: row?.retry_after_seconds ?? undefined };
}

export async function recordFailure(key: string): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.rpc("rl_record_failure", {
    p_key: key,
    p_window_ms: WINDOW_MS,
    p_base_lockout_ms: BASE_LOCKOUT_MS,
    p_max_lockout_ms: MAX_LOCKOUT_MS,
    p_lockout_after: LOCKOUT_AFTER_FAILURES,
  });
  if (error) console.error(`rl_record_failure failed for key ${key}:`, error);
}

export async function recordSuccess(key: string): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.rpc("rl_record_success", { p_key: key });
  if (error) console.error(`rl_record_success failed for key ${key}:`, error);
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
// counter instead: every call counts, success or not.
// ============================================================================

export interface QuotaResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

async function checkQuota(key: string, maxPerWindow: number, windowMs: number): Promise<QuotaResult> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.rpc("rl_check_quota", { p_key: key, p_max_per_window: maxPerWindow, p_window_ms: windowMs });
  if (error) {
    // Same fail-open posture as checkRateLimit above, same reasoning.
    console.error(`rl_check_quota failed for key ${key}:`, error);
    return { allowed: true };
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { allowed: row?.allowed ?? true, retryAfterSeconds: row?.retry_after_seconds ?? undefined };
}

/** "Rate-limit per IP AND per account", two independent gates, either one
 * tripping blocks the request. Used for dispute-filing and the Prompt 3
 * termination routes (cancel/abandon/withdraw), where every individual
 * call can look perfectly valid and checkRateLimit's failure-counting
 * wouldn't catch a volume spam run. */
export async function checkDualQuota(action: string, ip: string, accountKey: string, maxPerWindow: number, windowMs: number): Promise<QuotaResult> {
  const byIp = await checkQuota(rateLimitKey(`${action}-ip`, ip), maxPerWindow, windowMs);
  if (!byIp.allowed) return byIp;
  return checkQuota(rateLimitKey(`${action}-account`, accountKey), maxPerWindow, windowMs);
}

/** Deletes rows untouched in >24h from both bucket tables so they don't
 * grow unbounded. Piggybacked onto the existing daily order-timeouts
 * cron (app/api/cron/order-timeouts/route.ts) rather than standing up
 * new cron infra just for this. Best-effort: a failure here logs and
 * moves on, it must never fail the cron run it's attached to. */
export async function cleanupOldRateLimitBuckets(): Promise<void> {
  const supabase = getSupabaseServerClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [rateLimitResult, quotaResult] = await Promise.allSettled([
    supabase.from("rate_limit_buckets").delete().lt("first_failure_at", cutoff),
    supabase.from("quota_buckets").delete().lt("window_start", cutoff),
  ]);
  if (rateLimitResult.status === "rejected") console.error("cleanupOldRateLimitBuckets: rate_limit_buckets cleanup failed:", rateLimitResult.reason);
  if (quotaResult.status === "rejected") console.error("cleanupOldRateLimitBuckets: quota_buckets cleanup failed:", quotaResult.reason);
}
