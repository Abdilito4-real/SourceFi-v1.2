// scripts/trigger-reconcile-releases.mjs — one-off manual trigger for
// the reconciliation cron (app/api/cron/reconcile-releases/route.ts),
// normally only run by Vercel's own cron scheduler. Reads CRON_SECRET
// from .env.local, same bearer-token pattern Vercel signs its own cron
// requests with.
//   node --env-file=.env.local scripts/trigger-reconcile-releases.mjs [baseUrl]
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("Missing CRON_SECRET in .env.local.");
  process.exit(1);
}
const baseUrl = process.argv[2] || "http://localhost:3000";

const res = await fetch(`${baseUrl}/api/cron/reconcile-releases`, {
  headers: { Authorization: `Bearer ${secret}` },
});
const body = await res.json().catch(() => null);
console.log("Status:", res.status);
console.log("Body:", body);
