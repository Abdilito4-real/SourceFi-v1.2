// lib/receiptService.ts
//
// A receipt is a formatted READ over data that already exists — orders,
// payment_events, wallet_transactions — never a new persisted row, same
// posture as getOrderTimeline (lib/orderService.ts). Gross/fee/net
// amounts come straight from orders.amount_minor/platform_fee_minor,
// the SAME columns every other screen in this app already reads (order
// detail, dashboards) — deliberately not re-derived from ledger_entries,
// so a receipt can never show a different number than the order screen
// the buyer/supplier just came from. The matching payment_events row
// supplies the transactional proof (provider, its own reference,
// tx_hash if on-chain, when it actually confirmed).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export class ReceiptNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found, or hasn't confirmed yet.`);
    this.name = "ReceiptNotFoundError";
  }
}

export interface OrderReceipt {
  kind: "funding" | "settlement";
  orderId: number;
  orderCode: string;
  title: string;
  currency: "NGN";
  grossAmountMinor: number;
  platformFeeMinor: number;
  netAmountMinor: number;
  buyerEmail: string | null;
  supplierBusinessName: string | null;
  provider: string;
  providerReference: string | null;
  txHash: string | null;
  confirmedAt: string;
}

export interface TopupReceipt {
  kind: "topup";
  reference: string;
  currency: "NGN";
  amountMinor: number;
  provider: string;
  confirmedAt: string;
}

async function loadOrderWithParties(supabase: SupabaseClient, orderId: number) {
  const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!order) return null;
  const [{ data: buyer }, { data: supplier }] = await Promise.all([
    supabase.from("users").select("email").eq("id", order.buyer_id).maybeSingle(),
    supabase.from("supplier_profiles").select("business_name").eq("id", order.supplier_id).maybeSingle(),
  ]);
  return { order, buyerEmail: buyer?.email ?? null, supplierBusinessName: supplier?.business_name ?? null };
}

/** The order's `funding_confirmed` payment_events row — the moment the
 * buyer's wallet debit actually confirmed (lib/orderService.ts's
 * handleFundingConfirmed). Net = gross - platform fee, same arithmetic
 * shown on the order detail screen, not the buyer's out-of-pocket
 * amount (that's the gross — the fee is deducted from what the
 * supplier receives, not added on top, see docs/payment-integration.md). */
export async function getFundingReceipt(supabase: SupabaseClient, orderId: number): Promise<OrderReceipt> {
  const loaded = await loadOrderWithParties(supabase, orderId);
  if (!loaded) throw new ReceiptNotFoundError("Order");
  const { order, buyerEmail, supplierBusinessName } = loaded;

  const { data: event } = await supabase
    .from("payment_events")
    .select("*")
    .eq("order_id", orderId)
    .eq("leg", "funding")
    .eq("event_type", "funding_confirmed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!event) throw new ReceiptNotFoundError("Funding");

  return {
    kind: "funding",
    orderId: order.id,
    orderCode: order.order_code,
    title: order.title,
    currency: "NGN",
    grossAmountMinor: order.amount_minor,
    platformFeeMinor: order.platform_fee_minor,
    netAmountMinor: order.amount_minor - order.platform_fee_minor,
    buyerEmail,
    supplierBusinessName,
    provider: event.provider,
    providerReference: event.provider_reference ?? null,
    txHash: event.tx_hash ?? null,
    confirmedAt: event.created_at,
  };
}

/** The order's `settlement_confirmed` payment_events row — the moment
 * the supplier's payout to their bank account actually confirmed
 * (lib/orderService.ts's handleSettlementConfirmed). */
export async function getSettlementReceipt(supabase: SupabaseClient, orderId: number): Promise<OrderReceipt> {
  const loaded = await loadOrderWithParties(supabase, orderId);
  if (!loaded) throw new ReceiptNotFoundError("Order");
  const { order, buyerEmail, supplierBusinessName } = loaded;

  const { data: event } = await supabase
    .from("payment_events")
    .select("*")
    .eq("order_id", orderId)
    .eq("leg", "settlement")
    .eq("event_type", "settlement_confirmed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!event) throw new ReceiptNotFoundError("Settlement");

  return {
    kind: "settlement",
    orderId: order.id,
    orderCode: order.order_code,
    title: order.title,
    currency: "NGN",
    grossAmountMinor: order.amount_minor,
    platformFeeMinor: order.platform_fee_minor,
    netAmountMinor: order.amount_minor - order.platform_fee_minor,
    buyerEmail,
    supplierBusinessName,
    provider: event.provider,
    providerReference: event.provider_reference ?? null,
    txHash: event.tx_hash ?? null,
    confirmedAt: event.created_at,
  };
}

/** A confirmed wallet_transactions row for this user — self-only, the
 * caller (route) is responsible for the `user_id` match, this function
 * doesn't re-check ownership itself. */
export async function getTopupReceipt(supabase: SupabaseClient, userId: number, reference: string): Promise<TopupReceipt> {
  const { data: txn } = await supabase
    .from("wallet_transactions")
    .select("*")
    .eq("user_id", userId)
    .eq("provider_reference", reference)
    .eq("type", "topup")
    .eq("status", "confirmed")
    .maybeSingle();
  if (!txn) throw new ReceiptNotFoundError("Top-up");

  return {
    kind: "topup",
    reference: txn.provider_reference,
    currency: "NGN",
    amountMinor: txn.amount_minor,
    // wallet_transactions (migration 0020) has no provider column of its
    // own — Yellow Card is the only real wallet top-up provider this app
    // has (lib/yellowCardWalletTopupProvider.ts), stated here rather
    // than left implicit.
    provider: "yellow_card",
    confirmedAt: txn.created_at,
  };
}
