// app/api/cron/reconcile-yellowcard/route.ts
//
// The Yellow Card counterpart to app/api/cron/reconcile-releases/route.ts —
// a DB-driven sweep for anything stuck mid-refund/mid-settlement/
// mid-topup, independent of any one process's memory. Same CRON_SECRET
// Bearer pattern as every other cron route in this app.
//
// Same Vercel Hobby-tier frequency caveat as reconcile-releases: once/day
// is too coarse to matter for a genuinely stuck leg. See
// docs/payment-integration.md for the documented workaround (an external
// scheduled trigger hitting this same CRON_SECRET-protected endpoint on
// a tighter interval) if you're not on a tier that allows more frequent
// Vercel crons.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { reconcileStuckYellowCardLegs } from "../../../../lib/yellowCardReconciliation";
import { safeCompare } from "../../../../lib/safeCompare";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (!safeCompare(auth, `Bearer ${secret}`)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  } else {
    console.error("CRON_SECRET is not set. Refusing to run Yellow Card reconciliation.");
    return Response.json({ error: "Cron endpoint is not configured." }, { status: 503 });
  }

  const supabase = getSupabaseServerClient();
  try {
    const result = await reconcileStuckYellowCardLegs(supabase);
    return Response.json({ success: true, ...result });
  } catch (err) {
    console.error("reconcile-yellowcard cron run failed:", err);
    return Response.json({ error: "Cron run failed. See server logs." }, { status: 500 });
  }
}
