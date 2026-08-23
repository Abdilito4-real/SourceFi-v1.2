// app/api/cron/reconcile-releases/route.ts
//
// Part 2 of the production-hardening pass, the durable fix for
// "confirmation lost if the process restarts mid-poll"
// (lib/circleEscrowProvider.ts's former single point of failure): a
// DB-driven sweep for anything stuck at release_submitted/
// release_processing, independent of any one process's memory. Same
// CRON_SECRET Bearer pattern as app/api/cron/order-timeouts/route.ts.
//
// Frequency caveat, stated honestly: Vercel's Hobby tier limits a cron
// to once/day, too coarse to matter for a stuck release. See
// docs/payment-integration.md for the documented workaround (an external
// scheduled trigger, e.g. a GitHub Action, hitting this same
// CRON_SECRET-protected endpoint on a tighter interval) if you're not on
// a tier that allows a more frequent Vercel cron.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { reconcileStuckReleases } from "../../../../lib/releaseReconciliation";
import { safeCompare } from "../../../../lib/safeCompare";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (!safeCompare(auth, `Bearer ${secret}`)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  } else {
    console.error("CRON_SECRET is not set. Refusing to run release reconciliation.");
    return Response.json({ error: "Cron endpoint is not configured." }, { status: 503 });
  }

  const supabase = getSupabaseServerClient();
  try {
    const result = await reconcileStuckReleases(supabase);
    return Response.json({ success: true, ...result });
  } catch (err) {
    console.error("reconcile-releases cron run failed:", err);
    return Response.json({ error: "Cron run failed. See server logs." }, { status: 500 });
  }
}
