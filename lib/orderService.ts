// lib/orderService.ts
//
// The order lifecycle's actual orchestration — where lib/orderStateMachine.ts
// (what transitions are legal), lib/ledger.ts (what gets recorded once a
// leg is CONFIRMED, never before), lib/supplierVerification.ts (the live
// gate), and lib/paymentBoundary.ts (the provider-agnostic boundary) all
// get wired together. Route handlers (app/api/orders/*) stay thin: auth,
// input validation, call one of these, translate the result to a
// Response. Same "lib/ holds the logic" split this whole rewrite has used
// throughout — app/api/escrow/route.ts inlined everything because its
// logic was simple enough to; this flow branches by leg and by state in a
// way that's worth centralizing once, not duplicating across N routes.
//
// Every status-changing write here still follows the same two rules
// every route in this app already follows: assertTransition() before the
// write (a readable, centrally-defined "is this even legal"), and a
// compare-and-swap `.eq("status", from)` on the actual DB update (the
// thing that actually prevents a race from writing twice). Neither one
// is new here — this file is what applies them across a much longer
// chain of states than lib/requestStateMachine.ts ever had to.
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertTransition, InvalidOrderTransitionError } from "./orderStateMachine";
import { isSupplierCurrentlyVerified } from "./supplierVerification";
import { recordFundingConfirmed, recordEscrowRelease, recordSettlement, recordRefundFromEscrow } from "./ledger";
import { ORDER_PLATFORM_FEE_MINOR } from "./money";
import type { PaymentBoundary, PaymentStatusEvent } from "./paymentBoundary";
import type { DisputeCategory, DisputeRuling, DisputeType, OrderRow, OrderStatus } from "./types";

// ============================================================================
// Shared helpers
// ============================================================================

export function generateOrderCode(): string {
  return `ORD-${Math.floor(100000 + Math.random() * 900000)}`;
}

/** PLACEHOLDER exchange rate — 1 USDC ~= this many NGN. Does NOT come
 * from Yellow Card or any real rate source (nothing in this codebase has
 * one yet — that's explicitly the payment layer's job, design doc
 * Section 9). Exists only so the ledger has SOME deterministic
 * USDC-equivalent amount to record when a PaymentStatusEvent doesn't
 * supply its own — which the real Yellow Card integration will, once it
 * exists. Every USDC amount derived from this is illustrative, not
 * authoritative. Design doc Open Question 3 (who absorbs FX spread) is
 * unresolved and this constant plays no role in resolving it — it's a
 * stand-in for "a real rate would go here," not a decision about rates. */
const PLACEHOLDER_NGN_PER_USDC = 1600;

function placeholderUsdcMinorFromNgnMinor(ngnAmountMinor: number): number {
  // Both amount_minor fields are cents-scale (x100, lib/money.ts's
  // convention) so the ratio of major units is the same as the ratio of
  // minor units — a straight division by the placeholder rate.
  return Math.max(1, Math.round(ngnAmountMinor / PLACEHOLDER_NGN_PER_USDC));
}

/** Splits a total escrowed USDC amount into (supplier's cut, platform's
 * cut) in the same proportion as the order's NGN amount/fee split — used
 * by both the release and the settlement step so the two stay
 * consistent with each other without persisting a separate USDC amount
 * on the order row. */
function computeUsdcSplit(order: Pick<OrderRow, "amount_minor" | "platform_fee_minor">): {
  totalUsdcMinor: number;
  supplierUsdcMinor: number;
  platformFeeUsdcMinor: number;
} {
  const totalUsdcMinor = placeholderUsdcMinorFromNgnMinor(order.amount_minor);
  const platformFeeUsdcMinor = Math.round((totalUsdcMinor * order.platform_fee_minor) / order.amount_minor);
  return { totalUsdcMinor, supplierUsdcMinor: totalUsdcMinor - platformFeeUsdcMinor, platformFeeUsdcMinor };
}

export class OrderNotFoundError extends Error {
  constructor(orderId: number) {
    super(`Order ${orderId} not found.`);
    this.name = "OrderNotFoundError";
  }
}

export class NotOrderOwnerError extends Error {
  constructor() {
    super("You are not a party to this order.");
    this.name = "NotOrderOwnerError";
  }
}

async function fetchOrder(supabase: SupabaseClient, orderId: number): Promise<OrderRow> {
  const { data, error } = await supabase.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!data) throw new OrderNotFoundError(orderId);
  return data as OrderRow;
}

/** Compare-and-swap status transition: asserts the transition is legal,
 * then writes it conditioned on the row still being in `from` — the
 * `.eq("status", from)` is what actually prevents two concurrent
 * requests from both succeeding, same pattern as every route in this app
 * before this file. Returns false (not an error) if the row had already
 * moved on — callers use that to detect "someone else got there first"
 * without treating it as a hard failure, matching the idempotency
 * posture the design doc asks for on the payment-confirmation paths. */
async function tryTransition(
  supabase: SupabaseClient,
  orderId: number,
  from: OrderStatus,
  to: OrderStatus,
  extraPatch: Record<string, unknown> = {}
): Promise<boolean> {
  assertTransition(from, to);
  const { data, error } = await supabase
    .from("orders")
    .update({ status: to, ...extraPatch })
    .eq("id", orderId)
    .eq("status", from)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

// ============================================================================
// Order creation
// ============================================================================

export interface CreateOrderInput {
  supplierId: number;
  materialId?: number | null;
  title: string;
  description?: string | null;
  quantity?: string | null;
  deliveryLocation: string;
  amountMinor: number;
}

export class SupplierNotCurrentlyVerifiedError extends Error {
  constructor(supplierId: number) {
    super(`Supplier ${supplierId} is not currently verified and cannot receive new orders.`);
    this.name = "SupplierNotCurrentlyVerifiedError";
  }
}

/** Buyer creates an order directly against a specific, currently-verified
 * supplier — no claim/fee-naming step (see design doc Section 0). The
 * live verification check happens here AND again in fundOrder — state
 * can change in the gap between creating and funding an order. */
export async function createOrder(supabase: SupabaseClient, buyerId: number, input: CreateOrderInput): Promise<OrderRow> {
  const verified = await isSupplierCurrentlyVerified(supabase, input.supplierId);
  if (!verified) throw new SupplierNotCurrentlyVerifiedError(input.supplierId);

  const platformFeeMinor = ORDER_PLATFORM_FEE_MINOR;

  const { data, error } = await supabase
    .from("orders")
    .insert({
      order_code: generateOrderCode(),
      status: "pending_payment",
      buyer_id: buyerId,
      supplier_id: input.supplierId,
      material_id: input.materialId ?? null,
      title: input.title,
      description: input.description ?? null,
      quantity: input.quantity ?? null,
      delivery_location: input.deliveryLocation,
      amount_minor: input.amountMinor,
      currency: "NGN",
      platform_fee_minor: platformFeeMinor,
      supplier_verified_at_order_time: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as OrderRow;
}

// ============================================================================
// Funding leg
// ============================================================================

export interface FundOrderResult {
  order: OrderRow;
  paymentReference: string;
}

/** Buyer clicks "Fund Order". Re-checks supplier verification live (not
 * just at order-creation time) and ownership, then hands off to the
 * payment boundary — this function never touches Yellow Card or Circle
 * itself, see lib/paymentBoundary.ts. */
export async function fundOrder(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  orderId: number,
  buyerId: number
): Promise<FundOrderResult> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();

  const verified = await isSupplierCurrentlyVerified(supabase, order.supplier_id);
  if (!verified) throw new SupplierNotCurrentlyVerifiedError(order.supplier_id);

  const moved = await tryTransition(supabase, orderId, order.status, "payment_processing");
  if (!moved) throw new InvalidOrderTransitionError(order.status, "payment_processing");

  const result = await paymentProvider.initiateOrderFunding(orderId);

  await supabase.from("payment_events").insert({
    order_id: orderId,
    leg: "funding",
    provider: "yellow_card",
    provider_reference: result.paymentReference,
    event_type: result.status === "failed" ? "funding_failed" : "funding_initiated",
    provider_state: result.status,
  });

  if (result.status === "failed") {
    await tryTransition(supabase, orderId, "payment_processing", "payment_failed");
  }

  const updated = await fetchOrder(supabase, orderId);
  return { order: updated, paymentReference: result.paymentReference };
}

// ============================================================================
// Payment status event dispatch — the reportPaymentStatus consumer
// (design doc Section E), called by whatever polls or receives webhooks
// from the real provider, and by StubPaymentProvider's callback in dev.
// ============================================================================

export async function handlePaymentStatusEvent(supabase: SupabaseClient, event: PaymentStatusEvent): Promise<void> {
  switch (event.leg) {
    case "funding":
      return handleFundingConfirmed(supabase, event);
    case "release":
      return handleReleaseConfirmed(supabase, event);
    case "settlement":
      return handleSettlementConfirmed(supabase, event);
    case "refund":
      return handleRefundConfirmed(supabase, event);
  }
}

async function handleFundingConfirmed(supabase: SupabaseClient, event: PaymentStatusEvent): Promise<void> {
  const order = await fetchOrder(supabase, event.orderId);
  // Idempotency: if this order already reached `funded` (or beyond), a
  // duplicate/replayed confirmation is a no-op, not an error — same
  // posture the design doc asks for on retried/replayed provider events.
  if (order.status !== "payment_processing") return;

  await supabase.from("payment_events").insert({
    order_id: event.orderId,
    leg: "funding",
    provider: event.provider,
    provider_reference: event.providerReference,
    event_type: "funding_confirmed",
    provider_state: event.providerState,
    raw_payload: event,
  });

  // Walk the intermediate states in one pass. These exist as real,
  // distinct statuses for providers granular enough to report each one
  // separately (design doc Section D.1); a provider (or this stub) that
  // only reports one terminal confirmation still has to pass through
  // each legal hop, not skip to `funded` directly — assertTransition
  // enforces that even here.
  for (const to of ["converting", "escrow_depositing", "funded"] as const) {
    const moved = await tryTransition(supabase, event.orderId, (await fetchOrder(supabase, event.orderId)).status, to);
    if (!moved) return; // someone else already advanced this order — stop, don't double-write the ledger below
  }

  const ngnAmountMinor = order.amount_minor;
  const usdcAmountMinor = event.amountMinor ?? placeholderUsdcMinorFromNgnMinor(ngnAmountMinor);
  await recordFundingConfirmed(supabase, event.orderId, ngnAmountMinor, usdcAmountMinor);

  // Design doc Section D.2: orders_since_verification increments on
  // `funded` — an order that was actually paid for, not one abandoned
  // earlier. Best-effort increment via a fresh read-then-write rather
  // than a DB-level increment expression, matching this codebase's
  // existing supabase-js usage elsewhere; a lost increment under a race
  // here is a verification-expiry precision issue, not a money-safety
  // one, so it doesn't need the same CAS rigor as the status transitions
  // above.
  const { data: supplier } = await supabase
    .from("supplier_profiles")
    .select("orders_since_verification")
    .eq("id", order.supplier_id)
    .maybeSingle();
  if (supplier) {
    await supabase
      .from("supplier_profiles")
      .update({ orders_since_verification: (supplier.orders_since_verification ?? 0) + 1 })
      .eq("id", order.supplier_id);
  }
}

async function handleReleaseConfirmed(supabase: SupabaseClient, event: PaymentStatusEvent): Promise<void> {
  const order = await fetchOrder(supabase, event.orderId);
  if (order.status !== "release_submitted" && order.status !== "release_processing") return;

  await supabase.from("payment_events").insert({
    order_id: event.orderId,
    leg: "release",
    provider: event.provider,
    provider_reference: event.providerReference,
    event_type: "release_confirmed",
    provider_state: event.providerState,
    // The ENTIRE point of Section D.0: this is the only place a txHash
    // is ever written for a release, and only from a real confirmed
    // event — never fabricated. See lib/paymentBoundary.ts's
    // StubPaymentProvider for how the stub produces one, and the design
    // doc for the Circle SDK finding this structure is built around.
    tx_hash: event.txHash ?? null,
    raw_payload: event,
  });

  for (const to of ["release_processing", "escrow_released"] as const) {
    const moved = await tryTransition(supabase, event.orderId, (await fetchOrder(supabase, event.orderId)).status, to);
    if (!moved) return;
  }

  const { supplierUsdcMinor, platformFeeUsdcMinor } = computeUsdcSplit(order);
  await recordEscrowRelease(supabase, event.orderId, order.supplier_id, supplierUsdcMinor, platformFeeUsdcMinor);

  // escrow_released -> settlement_processing is a system transition with
  // no separate boundary call (design doc Section E has no
  // initiateSettlement — the payment layer converts and pays out as a
  // continuation of the same release, on its own timeline, and reports
  // back via a SEPARATE leg='settlement' event whenever that completes).
  await tryTransition(supabase, event.orderId, "escrow_released", "settlement_processing");
}

async function handleSettlementConfirmed(supabase: SupabaseClient, event: PaymentStatusEvent): Promise<void> {
  const order = await fetchOrder(supabase, event.orderId);
  if (order.status !== "settlement_processing") return;

  await supabase.from("payment_events").insert({
    order_id: event.orderId,
    leg: "settlement",
    provider: event.provider,
    provider_reference: event.providerReference,
    event_type: "settlement_confirmed",
    provider_state: event.providerState,
    raw_payload: event,
  });

  const moved = await tryTransition(supabase, event.orderId, "settlement_processing", "settled");
  if (!moved) return;

  const { supplierUsdcMinor } = computeUsdcSplit(order);
  const supplierNgnPayoutMinor = event.amountMinor ?? order.amount_minor - order.platform_fee_minor;
  await recordSettlement(supabase, event.orderId, order.supplier_id, supplierUsdcMinor, supplierNgnPayoutMinor);
}

async function handleRefundConfirmed(supabase: SupabaseClient, event: PaymentStatusEvent): Promise<void> {
  const order = await fetchOrder(supabase, event.orderId);
  if (order.status !== "refund_processing") return;

  await supabase.from("payment_events").insert({
    order_id: event.orderId,
    leg: "refund",
    provider: event.provider,
    provider_reference: event.providerReference,
    event_type: "refund_confirmed",
    provider_state: event.providerState,
    raw_payload: event,
  });

  const moved = await tryTransition(supabase, event.orderId, "refund_processing", "refunded");
  if (!moved) return;

  const { totalUsdcMinor } = computeUsdcSplit(order);
  await recordRefundFromEscrow(supabase, event.orderId, order.amount_minor, totalUsdcMinor);
}

// ============================================================================
// Delivery proof
// ============================================================================

export interface SubmitProofInput {
  photoUrls: string[];
  receiptUrl?: string | null;
  notes?: string | null;
}

export async function submitDeliveryProof(
  supabase: SupabaseClient,
  orderId: number,
  supplierUserId: number,
  input: SubmitProofInput
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);

  const { data: supplierProfile } = await supabase
    .from("supplier_profiles")
    .select("id, user_id")
    .eq("id", order.supplier_id)
    .maybeSingle();
  if (!supplierProfile || supplierProfile.user_id !== supplierUserId) throw new NotOrderOwnerError();

  if (order.status !== "funded" && order.status !== "fulfilling") {
    throw new InvalidOrderTransitionError(order.status, "proof_submitted");
  }

  await supabase.from("delivery_proofs").insert({
    order_id: orderId,
    supplier_id: order.supplier_id,
    photo_urls: input.photoUrls,
    receipt_url: input.receiptUrl ?? null,
    notes: input.notes ?? null,
  });

  const moved = await tryTransition(supabase, orderId, order.status, "proof_submitted");
  if (!moved) throw new InvalidOrderTransitionError(order.status, "proof_submitted");

  return fetchOrder(supabase, orderId);
}

// ============================================================================
// Buyer approval -> release
// ============================================================================

/** Buyer approves delivery proof. buyer_approved is intent only — no
 * funds move in that write. This function immediately continues into
 * release_submitted in the same call (matching the design doc's
 * diagram: approval fires the release request right away), but that
 * second transition is still its own explicit step, still its own
 * assertTransition call, and still doesn't write anything to the ledger
 * — only handleReleaseConfirmed does that, once Circle actually confirms.
 * This is the exact distinction Section D.0 exists to enforce in code,
 * not just in the state diagram. */
export async function approveOrder(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  orderId: number,
  buyerId: number
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "proof_submitted") throw new InvalidOrderTransitionError(order.status, "buyer_approved");

  const approved = await tryTransition(supabase, orderId, "proof_submitted", "buyer_approved");
  if (!approved) throw new InvalidOrderTransitionError(order.status, "buyer_approved");

  const released = await tryTransition(supabase, orderId, "buyer_approved", "release_submitted");
  if (released) {
    const result = await paymentProvider.initiateEscrowRelease(orderId);
    await supabase.from("payment_events").insert({
      order_id: orderId,
      leg: "release",
      provider: "circle",
      provider_reference: result.releaseReference,
      event_type: result.status === "failed" ? "release_failed" : "release_initiated",
      provider_state: result.status,
    });
  }

  return fetchOrder(supabase, orderId);
}

// ============================================================================
// Rejection -> dispute (pre-approval path)
// ============================================================================

export interface RejectProofInput {
  category: DisputeCategory;
  description?: string | null;
  evidenceUrls?: string[];
}

/** Buyer rejects delivery proof. Always routes to `disputed` automatically
 * (design doc's transition table — rejected is never a dead end), with a
 * dispute_type of 'pre_approval_rejection' since no money has moved yet. */
export async function rejectProof(
  supabase: SupabaseClient,
  orderId: number,
  buyerId: number,
  input: RejectProofInput
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "proof_submitted") throw new InvalidOrderTransitionError(order.status, "rejected");

  const rejected = await tryTransition(supabase, orderId, "proof_submitted", "rejected");
  if (!rejected) throw new InvalidOrderTransitionError(order.status, "rejected");

  const { data: dispute, error } = await supabase
    .from("disputes")
    .insert({
      order_id: orderId,
      raised_by: buyerId,
      dispute_type: "pre_approval_rejection" as DisputeType,
      category: input.category,
      description: input.description ?? null,
      evidence_urls: input.evidenceUrls ?? [],
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw error;

  await supabase.from("dispute_events").insert({ dispute_id: dispute.id, actor_id: buyerId, event_type: "opened" });

  await tryTransition(supabase, orderId, "rejected", "disputed");
  return fetchOrder(supabase, orderId);
}

export interface ReportEarlyIssueInput {
  category: DisputeCategory;
  description?: string | null;
  evidenceUrls?: string[];
}

/** Buyer flags a problem BEFORE any delivery proof exists at all — the
 * design doc's "funded -> disputed: buyer disputes before any audit
 * (rare, allowed)" edge (Section D.1), also reachable from `fulfilling`.
 * Unlike rejectProof, there's no proof to reject — this transitions the
 * order straight into `disputed`. Still `pre_approval_rejection` for
 * dispute_type (no money has moved, same refund-eligibility class as a
 * post-proof rejection — see lib/ledger.ts's recordRefundFromEscrow). */
export async function reportEarlyIssue(
  supabase: SupabaseClient,
  orderId: number,
  buyerId: number,
  input: ReportEarlyIssueInput
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "funded" && order.status !== "fulfilling") {
    throw new InvalidOrderTransitionError(order.status, "disputed");
  }

  const moved = await tryTransition(supabase, orderId, order.status, "disputed");
  if (!moved) throw new InvalidOrderTransitionError(order.status, "disputed");

  const { data: dispute, error } = await supabase
    .from("disputes")
    .insert({
      order_id: orderId,
      raised_by: buyerId,
      dispute_type: "pre_approval_rejection" as DisputeType,
      category: input.category,
      description: input.description ?? null,
      evidence_urls: input.evidenceUrls ?? [],
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw error;

  await supabase.from("dispute_events").insert({ dispute_id: dispute.id, actor_id: buyerId, event_type: "opened" });

  return fetchOrder(supabase, orderId);
}

// ============================================================================
// Post-settlement report — the genuinely new mechanism (design doc
// Section 5 / C.7). Deliberately does NOT touch orders.status — see
// lib/orderStateMachine.ts's comment on why `settled` has no outgoing
// transition to `disputed`.
// ============================================================================

export interface ReportIssueInput {
  category: DisputeCategory;
  description?: string | null;
  evidenceUrls?: string[];
}

export async function reportPostSettlementIssue(
  supabase: SupabaseClient,
  orderId: number,
  buyerId: number,
  input: ReportIssueInput
): Promise<{ disputeId: number }> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "settled") {
    throw new Error(`Order ${orderId} is not settled (status: ${order.status}) — use rejectProof before approval instead.`);
  }

  const { data: dispute, error } = await supabase
    .from("disputes")
    .insert({
      order_id: orderId,
      raised_by: buyerId,
      dispute_type: "post_settlement_report" as DisputeType,
      category: input.category,
      description: input.description ?? null,
      evidence_urls: input.evidenceUrls ?? [],
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw error;

  await supabase.from("dispute_events").insert({ dispute_id: dispute.id, actor_id: buyerId, event_type: "opened" });
  // orders.status is deliberately untouched — still `settled`.
  return { disputeId: dispute.id };
}

// ============================================================================
// Admin dispute resolution
// ============================================================================

export interface ResolveDisputeResult {
  autoActionTaken: "refund_initiated" | "release_initiated" | "none";
}

/** Records an admin's ruling. Whether that ruling AUTOMATICALLY triggers
 * real money movement, vs. just being recorded for manual follow-up, is
 * design doc Open Question 9 — genuinely unresolved. This function takes
 * the conservative reading: it only calls into the payment boundary
 * automatically when the order is still in a PRE-RELEASE disputed state
 * (funds provably still in escrow, nothing paid out yet — the case
 * lib/ledger.ts's recordRefundFromEscrow / the normal release path can
 * both handle safely). A dispute on an already-settled order (a
 * post_settlement_report) ruled for the buyer does NOT auto-refund here
 * — that's a clawback from a supplier who's already been paid, a
 * materially different and harder decision (see lib/ledger.ts's
 * recordRefundFromEscrow doc comment) that this function refuses to
 * guess at. */
export async function resolveDispute(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  disputeId: number,
  adminId: number,
  ruling: DisputeRuling,
  notes: string | null
): Promise<ResolveDisputeResult> {
  const { data: dispute, error: fetchErr } = await supabase.from("disputes").select("*").eq("id", disputeId).maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!dispute) throw new Error(`Dispute ${disputeId} not found.`);
  if (dispute.status !== "open" && dispute.status !== "under_review") {
    throw new Error(`Dispute ${disputeId} was already resolved.`);
  }

  const nextStatus = ruling === "buyer" ? "resolved_buyer" : "resolved_supplier";
  const { data: updated, error: updateErr } = await supabase
    .from("disputes")
    .update({ status: nextStatus, resolved_by: adminId, resolved_at: new Date().toISOString(), resolution_notes: notes })
    .eq("id", disputeId)
    .in("status", ["open", "under_review"])
    .select("id")
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updated) throw new Error(`Dispute ${disputeId} was already resolved by someone else.`);

  await supabase.from("dispute_events").insert({ dispute_id: disputeId, actor_id: adminId, event_type: "resolved", details: { ruling, notes } });

  const order = await fetchOrder(supabase, dispute.order_id);
  let autoActionTaken: ResolveDisputeResult["autoActionTaken"] = "none";

  if (order.status === "disputed") {
    if (ruling === "buyer") {
      const moved = await tryTransition(supabase, order.id, "disputed", "refund_processing");
      if (moved) {
        const result = await paymentProvider.initiateRefund(order.id, order.amount_minor);
        await supabase.from("payment_events").insert({
          order_id: order.id,
          leg: "refund",
          provider: "yellow_card",
          provider_reference: result.refundReference,
          event_type: result.status === "failed" ? "refund_failed" : "refund_initiated",
          provider_state: result.status,
        });
        autoActionTaken = "refund_initiated";
      }
    } else {
      const moved = await tryTransition(supabase, order.id, "disputed", "release_submitted");
      if (moved) {
        const result = await paymentProvider.initiateEscrowRelease(order.id);
        await supabase.from("payment_events").insert({
          order_id: order.id,
          leg: "release",
          provider: "circle",
          provider_reference: result.releaseReference,
          event_type: result.status === "failed" ? "release_failed" : "release_initiated",
          provider_state: result.status,
        });
        autoActionTaken = "release_initiated";
      }
    }
  }
  // order.status === 'settled' (a post_settlement_report ruling) falls
  // through with autoActionTaken = 'none', on purpose — see this
  // function's doc comment.

  return { autoActionTaken };
}

// ============================================================================
// Ratings
// ============================================================================

export async function submitRating(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  orderId: number,
  buyerId: number,
  score: 1 | 2 | 3 | 4 | 5,
  comment: string | null
): Promise<{ txHash: string | null; confirmed: boolean }> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "settled") throw new Error(`Order ${orderId} is not settled yet — cannot rate.`);

  const { data: existing } = await supabase.from("ratings").select("id").eq("order_id", orderId).maybeSingle();
  if (existing) throw new Error(`Order ${orderId} has already been rated.`);

  const result = await paymentProvider.submitRatingOnChain(orderId, order.supplier_id, score, comment);

  const { error } = await supabase.from("ratings").insert({
    order_id: orderId,
    buyer_id: buyerId,
    supplier_id: order.supplier_id,
    score,
    comment,
    on_chain_tx_hash: result.txHash,
    on_chain_confirmed_at: result.status === "confirmed" ? new Date().toISOString() : null,
  });
  if (error) throw error;

  return { txHash: result.txHash, confirmed: result.status === "confirmed" };
}
