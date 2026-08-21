// app/api/cron/order-timeouts/route.ts
//
// Flow 8, the three system-initiated timeouts (see runOrderTimeouts).
// Triggered by Vercel Cron (see vercel.json) once daily, these are
// day-scale windows (7/14/7 days), so daily is frequent enough without
// being wasteful. Protected by CRON_SECRET: Vercel signs its own cron
// requests with this as a Bearer token automatically once the env var is
// set (see Vercel's cron docs), anyone else hitting this route without
// it gets 401.
//
// Idempotent by construction, not by anything this route adds: every
// transition inside runOrderTimeouts goes through tryTransition's
// compare-and-swap, so this route can be triggered twice concurrently, or
// retried after a timeout, without double-processing any order, see
// lib/orderService.ts's module comment on this whole section.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { getPaymentProvider } from "../../../../lib/paymentProvider";
import { runOrderTimeouts } from "../../../../lib/orderService";
import { safeCompare } from "../../../../lib/safeCompare";
import { cleanupOldRateLimitBuckets } from "../../../../lib/rateLimit";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    // Constant-time (Prompt 4, M7), a plain !== here leaks a
    // character-by-character timing signal on the secret itself.
    if (!safeCompare(auth, `Bearer ${secret}`)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  } else {
    // No secret configured. Refuse rather than run this unauthenticated.
    console.error("CRON_SECRET is not set. Refusing to run order timeouts.");
    return Response.json({ error: "Cron endpoint is not configured." }, { status: 503 });
  }

  const supabase = getSupabaseServerClient();
  try {
    const result = await runOrderTimeouts(supabase, getPaymentProvider());
    // Part 3 of the production-hardening pass: piggybacked here rather
    // than standing up new cron infra just for bucket cleanup. Never
    // allowed to fail this run, see cleanupOldRateLimitBuckets's own
    // best-effort posture.
    await cleanupOldRateLimitBuckets();
    return Response.json({ success: true, ...result });
  } catch (err) {
    console.error("order-timeouts cron run failed:", err);
    return Response.json({ error: "Cron run failed. See server logs." }, { status: 500 });
  }
}
