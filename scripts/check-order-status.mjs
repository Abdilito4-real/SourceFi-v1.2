// scripts/check-order-status.mjs — one-off diagnostic, prints an order's
// current status plus its most recent payment_events rows. Reads
// SUPABASE_SERVICE_ROLE_KEY from .env.local, same as the app itself.
//   node --env-file=.env.local scripts/check-order-status.mjs 6
import { createClient } from "@supabase/supabase-js";

const orderId = Number(process.argv[2]);
if (!Number.isInteger(orderId)) {
  console.error("Usage: node --env-file=.env.local scripts/check-order-status.mjs <orderId>");
  process.exit(1);
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: order, error: orderErr } = await supabase
  .from("orders")
  .select("id, order_code, status, amount_minor, platform_fee_minor, release_usdc_total_minor, release_usdc_platform_fee_minor")
  .eq("id", orderId)
  .maybeSingle();
if (orderErr) throw orderErr;
console.log("Order:", order);

const { data: events, error: eventsErr } = await supabase
  .from("payment_events")
  .select("leg, provider, event_type, provider_state, tx_hash, created_at")
  .eq("order_id", orderId)
  .order("created_at", { ascending: false })
  .limit(5);
if (eventsErr) throw eventsErr;
console.log("Recent payment_events:", events);
