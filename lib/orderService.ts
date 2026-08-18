// lib/orderService.ts
//
// The order lifecycle's actual orchestration, where lib/orderStateMachine.ts
// (what transitions are legal), lib/ledger.ts (what gets recorded once a
// leg is CONFIRMED, never before), lib/supplierVerification.ts (the live
// gate), and lib/paymentBoundary.ts (the provider-agnostic boundary) all
// get wired together. Route handlers (app/api/orders/*) stay thin: auth,
// input validation, call one of these, translate the result to a
// Response. Same "lib/ holds the logic" split this whole rewrite has used
// throughout, app/api/escrow/route.ts inlined everything because its
// logic was simple enough to; this flow branches by leg and by state in a
// way that's worth centralizing once, not duplicating across N routes.
//
// Every status-changing write here still follows the same two rules
// every route in this app already follows: assertTransition() before the
// write (a readable, centrally-defined "is this even legal"), and a
// compare-and-swap `.eq("status", from)` on the actual DB update (the
// thing that actually prevents a race from writing twice). Neither one
// is new here, this file is what applies them across a much longer
// chain of states than lib/requestStateMachine.ts ever had to.
import "server-only";
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertTransition, InvalidOrderTransitionError } from "./orderStateMachine";
import { isSupplierCurrentlyVerified } from "./supplierVerification";
import { recordFundingConfirmed, recordEscrowRelease, recordSettlement, recordRefundFromEscrow, recordPartialRefundWithFee } from "./ledger";
import { ORDER_PLATFORM_FEE_MINOR, MIN_ORDER_AMOUNT_MINOR, CANCELLATION_FEE_MINOR } from "./money";
import type { PaymentBoundary, PaymentStatusEvent } from "./paymentBoundary";
import type { CancellationCategory, DisputeCategory, DisputeRuling, DisputeType, OrderRow, OrderStatus, UserRow } from "./types";
import { notifyUser, notifyAdmins } from "./notifications/dispatch";

// ============================================================================
// Termination flows (Prompt 3 of the feedback/notifications/security
// pack), policy constants. Every one of these was an open decision
// flagged in the termination matrix review before any of this was
// written; see that review for the reasoning behind each number.
// ============================================================================

// CANCELLATION_FEE_MINOR itself now lives in lib/money.ts (re-exported
// here for existing call sites), it needs to be importable from a
// client component (OrderDetailsModal's disclosure copy) without pulling
// in this file's Node-only `crypto` import.
export { CANCELLATION_FEE_MINOR };
/** Decision 5. */
export const WITHDRAW_PROOF_WINDOW_MS = 30 * 60 * 1000;
/** Decision 4, trailing window a strike counts within. */
export const SUPPLIER_STRIKE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** Decision 4, how long a 2nd strike within the window blocks new orders. */
export const SUPPLIER_BLOCK_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
/** Decision 6, how long an unfunded order sits before auto-expiry. */
export const UNFUNDED_ORDER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Decision 7, how long a funded order can sit with no proof before an
 * auto-dispute opens for admin review (never an automatic refund on a
 * timer with no human in the loop). */
export const FUNDED_NO_PROOF_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
/** Decision 8, how long a buyer can leave submitted proof unreviewed
 * before it auto-approves. */
export const PROOF_NO_RESPONSE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export class WithdrawWindowExpiredError extends Error {
  constructor() {
    super(`The window to withdraw a submitted proof has closed.`);
    this.name = "WithdrawWindowExpiredError";
  }
}

export class SupplierSuspendedError extends Error {
  constructor() {
    super("This supplier's account is currently suspended and can't receive new orders.");
    this.name = "SupplierSuspendedError";
  }
}

export class SupplierBlockedError extends Error {
  constructor(until: string) {
    super(`This supplier is temporarily blocked from new orders until ${until}.`);
    this.name = "SupplierBlockedError";
  }
}

// ============================================================================
// Notification hook points (Prompt 2 of the feedback/notifications pack).
// Every call below is fire-and-forget (notifyUser/notifyAdmins never
// throw, see lib/notifications/dispatch.ts) placed AFTER the function's
// own write already succeeded, so a notification failure can never affect
// order/dispute state. PAYLOAD SECURITY: every title/body here is a
// generic, lock-screen-safe string with no amount, wallet address, or
// name, see dispatch.ts's payload-security contract at the top of that
// file. The one place that looks up a supplier's user_id (order.supplier_id
// is a supplier_profiles.id, not a users.id) is factored out here since
// several hook points below need it.
// ============================================================================

async function getSupplierUserId(supabase: SupabaseClient, supplierProfileId: number): Promise<number | null> {
  const { data } = await supabase.from("supplier_profiles").select("user_id").eq("id", supplierProfileId).maybeSingle();
  return data?.user_id ?? null;
}

/** Shared by rejectProof/reportEarlyIssue/reportPostSettlementIssue
 * three different ways a dispute can open, one notification shape.
 * critical: true both because a dispute is exactly the pack's own named
 * example of an event that bypasses quiet hours, and because "who should
 * know" for the admin side is genuinely time-sensitive. */
function notifyDisputeOpened(supabase: SupabaseClient, order: OrderRow): void {
  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "disputes",
      eventType: "dispute_opened",
      resourceType: "order",
      resourceId: order.id,
      title: "Dispute opened",
      body: "A dispute was opened on one of your orders. Tap to view.",
      deepLink: `/supplier?order=${order.id}`,
      critical: true,
    });
  });
  void notifyAdmins(supabase, {
    category: "disputes",
    eventType: "dispute_opened",
    resourceType: "order",
    resourceId: order.id,
    title: "Dispute opened",
    body: "A new dispute needs review. Tap to view.",
    deepLink: `/admin?order=${order.id}`,
    critical: true,
  });
}

// ============================================================================
// Shared helpers
// ============================================================================

export function generateOrderCode(): string {
  return `ORD-${Math.floor(100000 + Math.random() * 900000)}`;
}

/** PLACEHOLDER exchange rate, 1 USDC ~= this many NGN. Does NOT come
 * from Yellow Card or any real rate source (nothing in this codebase has
 * one yet, that's explicitly the payment layer's job, design doc
 * Section 9). Exists only so the ledger has SOME deterministic
 * USDC-equivalent amount to record when a PaymentStatusEvent doesn't
 * supply its own, which the real Yellow Card integration will, once it
 * exists. Every USDC amount derived from this is illustrative, not
 * authoritative. Design doc Open Question 3 (who absorbs FX spread) is
 * unresolved and this constant plays no role in resolving it, it's a
 * stand-in for "a real rate would go here," not a decision about rates. */
const PLACEHOLDER_NGN_PER_USDC = 1600;

function placeholderUsdcMinorFromNgnMinor(ngnAmountMinor: number): number {
  // Both amount_minor fields are cents-scale (x100, lib/money.ts's
  // convention) so the ratio of major units is the same as the ratio of
  // minor units, a straight division by the placeholder rate.
  return Math.max(1, Math.round(ngnAmountMinor / PLACEHOLDER_NGN_PER_USDC));
}

/** Splits a total escrowed USDC amount into (supplier's cut, platform's
 * cut) in the same proportion as the order's NGN amount/fee split, used
 * by both the release and the settlement step so the two stay
 * consistent with each other without persisting a separate USDC amount
 * on the order row. Exported so a real PaymentBoundary implementation
 * (lib/circleEscrowProvider.ts) computes the EXACT same supplier cut
 * this module will independently book to the ledger once release is
 * confirmed, the on-chain transfer amount and the ledger entry must
 * never be allowed to drift apart by using two different formulas. */
export function computeUsdcSplit(order: Pick<OrderRow, "amount_minor" | "platform_fee_minor">): {
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

export interface TransitionHistory {
  actorId: number | null;
  actorRole: "buyer" | "supplier" | "admin" | "system";
  reasonCategory?: string | null;
  reasonText?: string | null;
}

/** Compare-and-swap status transition: asserts the transition is legal,
 * then writes it conditioned on the row still being in `from`, the
 * `.eq("status", from)` is what actually prevents two concurrent
 * requests from both succeeding, same pattern as every route in this app
 * before this file. Returns false (not an error) if the row had already
 * moved on, callers use that to detect "someone else got there first"
 * without treating it as a hard failure, matching the idempotency
 * posture the design doc asks for on the payment-confirmation paths.
 *
 * Prompt 3: also logs to order_status_history on a successful move
 * this is what "Timeline on the request shows every transition" is built
 * on, for EVERY transition past this point, not just the new termination
 * ones. `history` defaults to an attribution-free system entry so every
 * pre-existing call site keeps working unchanged; only the new
 * termination-flow call sites below pass real actor context. A logging
 * failure never blocks or fails the transition it's describing, it's
 * already committed by the time this runs. */
async function tryTransition(
  supabase: SupabaseClient,
  orderId: number,
  from: OrderStatus,
  to: OrderStatus,
  extraPatch: Record<string, unknown> = {},
  history?: TransitionHistory
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
  const moved = Boolean(data);

  if (moved) {
    const { error: historyError } = await supabase.from("order_status_history").insert({
      order_id: orderId,
      from_status: from,
      to_status: to,
      actor_id: history?.actorId ?? null,
      actor_role: history?.actorRole ?? "system",
      reason_category: history?.reasonCategory ?? null,
      reason_text: history?.reasonText ?? null,
    });
    if (historyError) console.error(`order_status_history insert failed for order ${orderId}:`, historyError);
  }

  return moved;
}

// ============================================================================
// Order creation
// ============================================================================

export interface CreateOrderInput {
  supplierId: number;
  /** The supplier-uploaded listing this order is for, if the buyer
   * picked one from search/browse rather than typing a freeform order
   * (migration 0006), supersedes the old materialId (fixed-catalog)
   * field, which no current code path sets anymore. */
  supplierListingId?: number | null;
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

/** Thrown when an order's amount is too small to leave the supplier a
 * sane payout once the flat ORDER_PLATFORM_FEE_MINOR is deducted, see
 * MIN_ORDER_AMOUNT_MINOR's comment in lib/money.ts for why this floor
 * exists at all. */
export class InvalidOrderAmountError extends Error {
  constructor(amountMinor: number) {
    super(
      `Order amount (${amountMinor} kobo) is below the ${MIN_ORDER_AMOUNT_MINOR} kobo minimum required to cover the platform fee.`
    );
    this.name = "InvalidOrderAmountError";
  }
}

/** Buyer creates an order directly against a specific, currently-verified
 * supplier, no claim/fee-naming step (see design doc Section 0). The
 * live verification check happens here AND again in fundOrder, state
 * can change in the gap between creating and funding an order. */
export async function createOrder(supabase: SupabaseClient, buyerId: number, input: CreateOrderInput): Promise<OrderRow> {
  const verified = await isSupplierCurrentlyVerified(supabase, input.supplierId);
  if (!verified) throw new SupplierNotCurrentlyVerifiedError(input.supplierId);

  // Prompt 3, Decision 9: a suspended supplier can't receive new orders
  // existing in-flight ones are untouched (see the suspend route). Also
  // blocks on a strike-driven temporary block (Decision 4). Both checked
  // here, not just at some earlier point, since verification status and
  // suspension/block state can both change between when a buyer loads the
  // supplier page and when they actually submit an order.
  const { data: supplierProfile } = await supabase
    .from("supplier_profiles")
    .select("user_id, blocked_until")
    .eq("id", input.supplierId)
    .maybeSingle();
  if (supplierProfile) {
    if (supplierProfile.blocked_until && new Date(supplierProfile.blocked_until) > new Date()) {
      throw new SupplierBlockedError(supplierProfile.blocked_until);
    }
    const { data: supplierUser } = await supabase.from("users").select("suspended_at").eq("id", supplierProfile.user_id).maybeSingle();
    if (supplierUser?.suspended_at) throw new SupplierSuspendedError();
  }

  if (input.amountMinor < MIN_ORDER_AMOUNT_MINOR) throw new InvalidOrderAmountError(input.amountMinor);

  const platformFeeMinor = ORDER_PLATFORM_FEE_MINOR;

  const { data, error } = await supabase
    .from("orders")
    .insert({
      order_code: generateOrderCode(),
      status: "pending_payment",
      buyer_id: buyerId,
      supplier_id: input.supplierId,
      supplier_listing_id: input.supplierListingId ?? null,
      title: input.title,
      description: input.description ?? null,
      quantity: input.quantity ?? null,
      delivery_location: input.deliveryLocation,
      amount_minor: input.amountMinor,
      currency: "NGN",
      platform_fee_minor: platformFeeMinor,
      // A real random room name for the verification call, deliberately
      // NOT derived from order_code (a guessable 6-digit string shown to
      // users). See migration 0008.
      verification_call_room_id: randomUUID(),
      supplier_verified_at_order_time: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) throw error;
  return data as OrderRow;
}

/** Every order created after migration 0008 already has a private
 * verification_call_room_id from createOrder() above. This backfills the
 * rare row that predates it (or was created between the migration
 * landing and this column being populated), called from the
 * ownership-checked order-detail route, never from anywhere that hasn't
 * already verified the caller is a party to the order. Room name privacy
 * is entirely this ID: never fall back to order_code (guessable) if this
 * is somehow still empty after the update. */
export async function ensureCallRoomId(supabase: SupabaseClient, order: OrderRow): Promise<string> {
  if (order.verification_call_room_id) return order.verification_call_room_id;

  const roomId = randomUUID();
  const { error } = await supabase.from("orders").update({ verification_call_room_id: roomId }).eq("id", order.id);
  if (error) throw error;
  return roomId;
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
 * payment boundary, this function never touches Yellow Card or Circle
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
// Payment status event dispatch, the reportPaymentStatus consumer
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
  // duplicate/replayed confirmation is a no-op, not an error, same
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
  // each legal hop, not skip to `funded` directly, assertTransition
  // enforces that even here.
  for (const to of ["converting", "escrow_depositing", "funded"] as const) {
    const moved = await tryTransition(supabase, event.orderId, (await fetchOrder(supabase, event.orderId)).status, to);
    if (!moved) return; // someone else already advanced this order, stop, don't double-write the ledger below
  }

  const ngnAmountMinor = order.amount_minor;
  const usdcAmountMinor = event.amountMinor ?? placeholderUsdcMinorFromNgnMinor(ngnAmountMinor);
  await recordFundingConfirmed(supabase, event.orderId, ngnAmountMinor, usdcAmountMinor);

  // Design doc Section D.2: orders_since_verification increments on
  // `funded`, an order that was actually paid for, not one abandoned
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

  // Notify both sides now, not at createOrder, an order that's never
  // funded shouldn't page a supplier about work that may never happen.
  // `funded` is the first moment this order is real money for both of them.
  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "escrow_payment",
    eventType: "order_funded",
    resourceType: "order",
    resourceId: order.id,
    title: "Payment confirmed",
    body: "Your escrow payment is confirmed. Tap to view your order.",
    deepLink: `/buyer?order=${order.id}`,
  });
  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "job_availability",
      eventType: "order_funded",
      resourceType: "order",
      resourceId: order.id,
      title: "New order to fulfill",
      body: "A buyer funded a new order with you. Tap to view.",
      deepLink: `/supplier?order=${order.id}`,
    });
  });
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
    // event, never fabricated. See lib/paymentBoundary.ts's
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
  // initiateSettlement, the payment layer converts and pays out as a
  // continuation of the same release, on its own timeline, and reports
  // back via a SEPARATE leg='settlement' event whenever that completes).
  await tryTransition(supabase, event.orderId, "escrow_released", "settlement_processing");

  // critical: true, "funds released" is the feedback pack's own named
  // example of an event that bypasses quiet hours and goes by email too.
  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "escrow_payment",
      eventType: "funds_released",
      resourceType: "order",
      resourceId: order.id,
      title: "Funds released",
      body: "Escrow funds for one of your orders have been released. Tap to view.",
      deepLink: `/supplier?order=${order.id}`,
      critical: true,
    });
  });
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

  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "escrow_payment",
      eventType: "settlement_complete",
      resourceType: "order",
      resourceId: order.id,
      title: "Payout complete",
      body: "Your payout for this order is complete. Tap to view.",
      deepLink: `/supplier?order=${order.id}`,
    });
  });
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

  // Prompt 3: a refund can now arrive via three different paths, a
  // dispute ruled for the buyer (full refund, no order_cancellations
  // row), a buyer's own cancelFundedOrder (partial, fee retained), or a
  // supplier's abandonOrder (full, no fee, but DOES write a
  // order_cancellations row). Reading the most recent cancellation row
  // back, rather than trusting anything on the event itself, is what
  // tells these apart: whichever function initiated this refund already
  // wrote the fee it charged (zero or not) BEFORE calling
  // initiateRefund, so it's there by the time confirmation arrives.
  const { data: cancellation } = await supabase
    .from("order_cancellations")
    .select("fee_charged_minor, refund_minor")
    .eq("order_id", event.orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cancellation && cancellation.fee_charged_minor > 0) {
    const feeFraction = cancellation.fee_charged_minor / order.amount_minor;
    const usdcFeeMinor = Math.round(totalUsdcMinor * feeFraction);
    const usdcRefundMinor = totalUsdcMinor - usdcFeeMinor;
    const ngnRefundMinor = cancellation.refund_minor ?? order.amount_minor - cancellation.fee_charged_minor;
    await recordPartialRefundWithFee(supabase, event.orderId, ngnRefundMinor, usdcRefundMinor, usdcFeeMinor);
  } else {
    await recordRefundFromEscrow(supabase, event.orderId, order.amount_minor, totalUsdcMinor);
  }

  // critical: true, a refund is as much "your money moved" as a release is.
  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "escrow_payment",
    eventType: "order_refunded",
    resourceType: "order",
    resourceId: order.id,
    title: "Refund complete",
    body: "Your refund has been processed. Tap to view.",
    deepLink: `/buyer?order=${order.id}`,
    critical: true,
  });
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
    // Explicit rather than leaning on the column's DB-side default
    // (migration 0004), withdrawProof (Prompt 3) now reads this back to
    // enforce WITHDRAW_PROOF_WINDOW_MS, so it needs to be unambiguous
    // here rather than implicit.
    submitted_at: new Date().toISOString(),
  });

  const moved = await tryTransition(supabase, orderId, order.status, "proof_submitted");
  if (!moved) throw new InvalidOrderTransitionError(order.status, "proof_submitted");

  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "audit_status",
    eventType: "proof_submitted",
    resourceType: "order",
    resourceId: orderId,
    title: "Delivery proof submitted",
    body: "Your supplier submitted delivery proof. Tap to review.",
    deepLink: `/buyer?order=${orderId}`,
  });

  return fetchOrder(supabase, orderId);
}

// ============================================================================
// Live verification call, mandatory before approval (explicit product
// requirement, not inferred). Enforced HERE, server-side, in
// approveOrder itself, not just a disabled button client-side, which
// would just be a suggestion anyone could bypass by calling the route
// directly. The actual authorization boundary (requireRole on the
// route) is unaffected; this is an additional precondition on top of it.
// ============================================================================

export const MIN_VERIFICATION_CALL_SECONDS = 5 * 60;

export class VerificationCallIncompleteError extends Error {
  constructor(secondsSoFar: number) {
    super(
      `A live verification call of at least ${MIN_VERIFICATION_CALL_SECONDS / 60} minutes is required before ` +
        `approving this order (${secondsSoFar}s recorded so far).`
    );
    this.name = "VerificationCallIncompleteError";
  }
}

/** Second, independent gate alongside VerificationCallIncompleteError: a
 * long-enough call and a call that actually proved something are not
 * the same claim, see confirmCallCode below. */
export class CallCodeNotConfirmedError extends Error {
  constructor() {
    super(
      "Confirm that your supplier showed the order code on camera during the call before approving this order."
    );
    this.name = "CallCodeNotConfirmedError";
  }
}

/** Buyer-only attestation that the supplier showed THIS order's own
 * code on camera during the live call and it matched. Closes the loop-
 * hole a bare time requirement leaves open, verification_call_seconds
 * only proves a call of a certain length connected, not that it was
 * genuinely this order's live call rather than a pre-recorded loop or
 * a call about different goods. Order-level and one-way, like
 * verification_call_seconds: once set it stays set across a
 * withdraw/resubmit cycle, the underlying call already happened. */
export async function confirmCallCode(supabase: SupabaseClient, orderId: number, buyerUserId: number): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerUserId) throw new NotOrderOwnerError();
  if (!["funded", "fulfilling", "proof_submitted"].includes(order.status)) {
    throw new InvalidOrderTransitionError(order.status, "proof_submitted");
  }

  const { error } = await supabase
    .from("orders")
    .update({ call_code_confirmed_at: new Date().toISOString() })
    .eq("id", orderId);
  if (error) throw error;

  return fetchOrder(supabase, orderId);
}

/** Adds one real call segment (join-to-leave, reported by the client
 * from Jitsi's own lifecycle events, never just "the panel was open")
 * to the order's running total. Either party to the order can report a
 * segment, whoever's Jitsi session ends first reports it, same total
 * either way. `secondsElapsed` is sanity-capped, not trusted blindly:
 * this is a workflow gate, not itself a money-movement action, but an
 * unbounded client-supplied number is still worth bounding. */
export async function recordVerificationCallProgress(
  supabase: SupabaseClient,
  orderId: number,
  userId: number,
  secondsElapsed: number
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);

  const isBuyer = order.buyer_id === userId;
  let isSupplier = false;
  if (!isBuyer) {
    const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", userId).maybeSingle();
    isSupplier = Boolean(profile && profile.id === order.supplier_id);
  }
  if (!isBuyer && !isSupplier) throw new NotOrderOwnerError();

  // A single reported segment capped at 2 hours, generous for a real
  // call, not so unbounded that one malformed/malicious report could
  // satisfy the whole requirement by itself.
  const cappedSeconds = Math.max(0, Math.min(Math.round(secondsElapsed), 2 * 60 * 60));
  const newTotal = (order.verification_call_seconds ?? 0) + cappedSeconds;

  const { error } = await supabase.from("orders").update({ verification_call_seconds: newTotal }).eq("id", orderId);
  if (error) throw error;

  return fetchOrder(supabase, orderId);
}

/** Reports "I just joined" / "I just left" the live call, immediately,
 * separate from recordVerificationCallProgress above (which only fires
 * once a segment ENDS, for the total-duration requirement). This is
 * what lets the other party get an incoming-call prompt instead of
 * needing to already be looking at the order, see migration 0012 and
 * OrderDetailsModal.tsx. A fresh join (was null, now active) also
 * notifies the other party; a heartbeat re-join (was already set)
 * doesn't page them again. */
export async function setCallPresence(supabase: SupabaseClient, orderId: number, userId: number, active: boolean): Promise<void> {
  const order = await fetchOrder(supabase, orderId);

  const isBuyer = order.buyer_id === userId;
  let isSupplier = false;
  if (!isBuyer) {
    const { data: profile } = await supabase.from("supplier_profiles").select("id").eq("user_id", userId).maybeSingle();
    isSupplier = Boolean(profile && profile.id === order.supplier_id);
  }
  if (!isBuyer && !isSupplier) throw new NotOrderOwnerError();

  const column = isBuyer ? "buyer_call_active_since" : "supplier_call_active_since";
  const wasAlreadyActive = Boolean(isBuyer ? order.buyer_call_active_since : order.supplier_call_active_since);
  const { error } = await supabase
    .from("orders")
    .update({ [column]: active ? new Date().toISOString() : null })
    .eq("id", orderId);
  if (error) throw error;

  if (active && !wasAlreadyActive) {
    // critical: true here isn't "financially critical" like a release or
    // refund, it's "time-sensitive the way an actual phone call is": a
    // notification that arrives after quiet hours end is arriving after
    // the call is long over, worthless by then. The deep link's `call=1`
    // is what makes this feel like answering a call rather than reading
    // about one, see BuyerDashboard.tsx/SupplierDashboard.tsx/
    // OrderDetailsModal.tsx's autoJoinCall handling, and the service
    // worker (worker/index.ts) renders this one with a "Join call"
    // action button instead of the plain default notification.
    if (isBuyer) {
      getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
        if (supplierUserId == null) return;
        void notifyUser(supabase, {
          userId: supplierUserId,
          category: "audit_status",
          eventType: "verification_call_started",
          resourceType: "order",
          resourceId: order.id,
          title: "Incoming verification call",
          body: "Your buyer is on a live verification call for this order now.",
          deepLink: `/supplier?order=${order.id}&call=1`,
          tag: `call:${order.id}`,
          critical: true,
        });
      });
    } else {
      void notifyUser(supabase, {
        userId: order.buyer_id,
        category: "audit_status",
        eventType: "verification_call_started",
        resourceType: "order",
        resourceId: order.id,
        title: "Incoming verification call",
        body: "Your supplier is on a live verification call for this order now.",
        deepLink: `/buyer?order=${order.id}&call=1`,
        tag: `call:${order.id}`,
        critical: true,
      });
    }
  }
}

// ============================================================================
// Buyer approval -> release
// ============================================================================

/** Buyer approves delivery proof. buyer_approved is intent only, no
 * funds move in that write. This function immediately continues into
 * release_submitted in the same call (matching the design doc's
 * diagram: approval fires the release request right away), but that
 * second transition is still its own explicit step, still its own
 * assertTransition call, and still doesn't write anything to the ledger
 *, only handleReleaseConfirmed does that, once Circle actually confirms.
 * This is the exact distinction Section D.0 exists to enforce in code,
 * not just in the state diagram.
 *
 * Also requires MIN_VERIFICATION_CALL_SECONDS of real call time first
 * (see above), checked here, not just suggested in the UI. Deliberately
 * scoped to THIS function only: an admin resolving a dispute in the
 * supplier's favor (resolveDispute) calls initiateEscrowRelease directly
 * and is NOT gated by this, that's an admin ruling on a disputed order
 * not the buyer's own approval flow this requirement is about. */
export async function approveOrder(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  orderId: number,
  buyerId: number
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "proof_submitted") throw new InvalidOrderTransitionError(order.status, "buyer_approved");
  if ((order.verification_call_seconds ?? 0) < MIN_VERIFICATION_CALL_SECONDS) {
    throw new VerificationCallIncompleteError(order.verification_call_seconds ?? 0);
  }
  if (!order.call_code_confirmed_at) {
    throw new CallCodeNotConfirmedError();
  }

  const approved = await tryTransition(supabase, orderId, "proof_submitted", "buyer_approved");
  if (!approved) throw new InvalidOrderTransitionError(order.status, "buyer_approved");

  const released = await tryTransition(supabase, orderId, "buyer_approved", "release_submitted");
  if (released) {
    try {
      const result = await paymentProvider.initiateEscrowRelease(orderId);
      await supabase.from("payment_events").insert({
        order_id: orderId,
        leg: "release",
        provider: "circle",
        provider_reference: result.releaseReference,
        event_type: result.status === "failed" ? "release_failed" : "release_initiated",
        provider_state: result.status,
      });
    } catch (err) {
      // A REAL provider (CircleEscrowProvider) can throw synchronously
      // for reasons the stub never could, no wallet_address on file for
      // the supplier, no USDC balance in escrow, insufficient balance.
      // The order is already at release_submitted at this point; there is
      // no legal transition back to buyer_approved (see
      // lib/orderStateMachine.ts, release_submitted only goes forward to
      // release_processing or disputed), so it stays here rather than
      // being forced into a status that doesn't fit what happened. What
      // matters is this is never silently lost: logged loudly, and
      // recorded on the order's own payment_events trail (which the
      // order-detail route already returns, so it's visible to the buyer,
      // supplier, and admin, not buried in a server log only admin can
      // reach). A real production version needs an explicit "retry
      // release" admin action once the underlying issue (e.g. the
      // supplier's wallet_address) is fixed, not built here; this is the
      // honest boundary of what this stage covers, not a silent gap.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Escrow release failed for order ${orderId}, order stuck at release_submitted:`, err);
      await supabase.from("payment_events").insert({
        order_id: orderId,
        leg: "release",
        provider: "circle",
        provider_reference: null,
        event_type: "release_failed",
        provider_state: "error",
        raw_payload: { error: message },
      });
      throw err;
    }
  }

  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "audit_status",
      eventType: "proof_approved",
      resourceType: "order",
      resourceId: orderId,
      title: "Delivery approved",
      body: "The buyer approved your delivery. Funds are being released.",
      deepLink: `/supplier?order=${orderId}`,
    });
  });

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
 * (design doc's transition table, rejected is never a dead end), with a
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
  notifyDisputeOpened(supabase, order);
  return fetchOrder(supabase, orderId);
}

export interface ReportEarlyIssueInput {
  category: DisputeCategory;
  description?: string | null;
  evidenceUrls?: string[];
}

/** Buyer flags a problem BEFORE any delivery proof exists at all, the
 * design doc's "funded -> disputed: buyer disputes before any audit
 * (rare, allowed)" edge (Section D.1), also reachable from `fulfilling`.
 * Unlike rejectProof, there's no proof to reject, this transitions the
 * order straight into `disputed`. Still `pre_approval_rejection` for
 * dispute_type (no money has moved, same refund-eligibility class as a
 * post-proof rejection, see lib/ledger.ts's recordRefundFromEscrow). */
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
  notifyDisputeOpened(supabase, order);

  return fetchOrder(supabase, orderId);
}

// ============================================================================
// Post-settlement report, the genuinely new mechanism (design doc
// Section 5 / C.7). Deliberately does NOT touch orders.status, see
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
    throw new Error(`Order ${orderId} is not settled (status: ${order.status}). Use rejectProof before approval instead.`);
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
  notifyDisputeOpened(supabase, order);
  // orders.status is deliberately untouched, still `settled`.
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
 * design doc Open Question 9, genuinely unresolved. This function takes
 * the conservative reading: it only calls into the payment boundary
 * automatically when the order is still in a PRE-RELEASE disputed state
 * (funds provably still in escrow, nothing paid out yet, the case
 * lib/ledger.ts's recordRefundFromEscrow / the normal release path can
 * both handle safely). A dispute on an already-settled order (a
 * post_settlement_report) ruled for the buyer does NOT auto-refund here
 *, that's a clawback from a supplier who's already been paid, a
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
  // through with autoActionTaken = 'none', on purpose, see this
  // function's doc comment.

  // The dispute resolving is newsworthy on its own, independent of
  // whether autoActionTaken moved money, a real refund/release still
  // gets its OWN, separate notification once it actually confirms (see
  // handleRefundConfirmed/handleReleaseConfirmed above), not duplicated
  // here at the "ruling recorded" moment.
  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "disputes",
    eventType: "dispute_resolved",
    resourceType: "order",
    resourceId: order.id,
    title: "Dispute resolved",
    body: "A dispute on your order has been resolved. Tap to view.",
    deepLink: `/buyer?order=${order.id}`,
    critical: true,
  });
  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "disputes",
      eventType: "dispute_resolved",
      resourceType: "order",
      resourceId: order.id,
      title: "Dispute resolved",
      body: "A dispute on your order has been resolved. Tap to view.",
      deepLink: `/supplier?order=${order.id}`,
      critical: true,
    });
  });

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
  if (order.status !== "settled") throw new Error(`Order ${orderId} is not settled yet, cannot rate.`);

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

// ============================================================================
// Termination flows (Prompt 3 of the feedback/notifications/security
// pack), every buyer/supplier/system/admin exit path from the
// termination matrix review. Each function below follows the same two
// rules the rest of this file already does (assertTransition via
// tryTransition, compare-and-swap on the DB write) plus, new in this
// section: an order_cancellations row recording the fund consequence
// actually applied, and a notifyUser/notifyAdmins call to the other
// party. None of these touch the existing happy-path functions above
// except tryTransition (now logs history) and handleRefundConfirmed
// (now branches on whether a fee applies), see that function's updated
// comment.
// ============================================================================

export interface CancelInput {
  category: CancellationCategory;
  description?: string | null;
}

/** Flow 1: buyer cancels before any money has moved. No fee, no dispute
 *, the cleanest exit in the whole set. Covers both pending_payment (never
 * attempted payment) and payment_failed (attempted, didn't go through)
 * the prompt's "before a claim" and "after a claim, before funding" cases
 * collapse into this one, since no separate claim step exists post-pivot
 * (see the termination matrix). */
export async function cancelBeforeFunding(supabase: SupabaseClient, orderId: number, buyerId: number, input: CancelInput): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "pending_payment" && order.status !== "payment_failed") {
    throw new InvalidOrderTransitionError(order.status, "cancelled");
  }

  const moved = await tryTransition(supabase, orderId, order.status, "cancelled", {}, {
    actorId: buyerId,
    actorRole: "buyer",
    reasonCategory: input.category,
    reasonText: input.description ?? null,
  });
  if (!moved) throw new InvalidOrderTransitionError(order.status, "cancelled");

  await supabase.from("order_cancellations").insert({
    order_id: orderId,
    actor_id: buyerId,
    actor_role: "buyer",
    category: input.category,
    description: input.description ?? null,
    fee_charged_minor: 0,
    refund_minor: null, // nothing to refund, no payment ever completed
  });

  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "job_availability",
      eventType: "order_cancelled",
      resourceType: "order",
      resourceId: orderId,
      title: "Order cancelled",
      body: "The buyer cancelled this order before payment. Tap to view.",
      deepLink: `/supplier?order=${orderId}`,
    });
  });

  return fetchOrder(supabase, orderId);
}

export interface CancelFundedResult {
  order: OrderRow;
  refundMinor: number;
  feeMinor: number;
}

/** Flow 4 / Decision 2: buyer cancels a FUNDED order before the supplier
 * submits proof. Not a dispute, no fault is being alleged, so it skips
 * `disputed` entirely and goes straight to `refund_processing`, minus the
 * disclosed non-refundable fee (CANCELLATION_FEE_MINOR, reused from the
 * existing platform fee). The route layer is responsible for having shown
 * this fee BEFORE the buyer ever funded, see OrderDetailsModal's Fund
 * Order confirmation. */
export async function cancelFundedOrder(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  orderId: number,
  buyerId: number,
  input: CancelInput
): Promise<CancelFundedResult> {
  const order = await fetchOrder(supabase, orderId);
  if (order.buyer_id !== buyerId) throw new NotOrderOwnerError();
  if (order.status !== "funded" && order.status !== "fulfilling") {
    throw new InvalidOrderTransitionError(order.status, "refund_processing");
  }

  // Never charge more than the order is worth (a pathologically small
  // order below the fee would otherwise produce a negative refund).
  const feeMinor = Math.min(CANCELLATION_FEE_MINOR, order.amount_minor);
  const refundMinor = order.amount_minor - feeMinor;

  const moved = await tryTransition(supabase, orderId, order.status, "refund_processing", {}, {
    actorId: buyerId,
    actorRole: "buyer",
    reasonCategory: input.category,
    reasonText: input.description ?? null,
  });
  if (!moved) throw new InvalidOrderTransitionError(order.status, "refund_processing");

  // Written BEFORE initiating the refund, handleRefundConfirmed reads
  // this row back to decide whether the ledger should book a full or a
  // fee-retaining partial refund once the provider confirms.
  await supabase.from("order_cancellations").insert({
    order_id: orderId,
    actor_id: buyerId,
    actor_role: "buyer",
    category: input.category,
    description: input.description ?? null,
    fee_charged_minor: feeMinor,
    refund_minor: refundMinor,
  });

  const result = await paymentProvider.initiateRefund(orderId, refundMinor);
  await supabase.from("payment_events").insert({
    order_id: orderId,
    leg: "refund",
    provider: "yellow_card",
    provider_reference: result.refundReference,
    event_type: result.status === "failed" ? "refund_failed" : "refund_initiated",
    provider_state: result.status,
  });

  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "escrow_payment",
      eventType: "order_cancelled_by_buyer",
      resourceType: "order",
      resourceId: orderId,
      title: "Order cancelled",
      body: "The buyer cancelled this funded order before you submitted proof. Tap to view.",
      deepLink: `/supplier?order=${orderId}`,
      critical: true,
    });
  });

  return { order: await fetchOrder(supabase, orderId), refundMinor, feeMinor };
}

/** Flow 6 / Decision 4: supplier voluntarily abandons a funded order
 * before submitting proof. Unlike a buyer's own cancellation, this is a
 * FULL refund, no fee, because the buyer didn't cause it. Records a
 * strike; a 2nd strike within 90 days blocks new orders for 7 days, a
 * 3rd+ flags the supplier for admin review rather than auto-suspending
 * a human looks at it before anyone's account is actually suspended. */
export async function abandonOrder(
  supabase: SupabaseClient,
  paymentProvider: PaymentBoundary,
  orderId: number,
  supplierUserId: number,
  input: CancelInput
): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  const { data: supplierProfile } = await supabase.from("supplier_profiles").select("id, user_id").eq("id", order.supplier_id).maybeSingle();
  if (!supplierProfile || supplierProfile.user_id !== supplierUserId) throw new NotOrderOwnerError();
  if (order.status !== "funded" && order.status !== "fulfilling") {
    throw new InvalidOrderTransitionError(order.status, "refund_processing");
  }

  const moved = await tryTransition(supabase, orderId, order.status, "refund_processing", {}, {
    actorId: supplierUserId,
    actorRole: "supplier",
    reasonCategory: input.category,
    reasonText: input.description ?? null,
  });
  if (!moved) throw new InvalidOrderTransitionError(order.status, "refund_processing");

  await supabase.from("order_cancellations").insert({
    order_id: orderId,
    actor_id: supplierUserId,
    actor_role: "supplier",
    category: input.category,
    description: input.description ?? null,
    fee_charged_minor: 0,
    refund_minor: order.amount_minor,
  });

  const result = await paymentProvider.initiateRefund(orderId, order.amount_minor);
  await supabase.from("payment_events").insert({
    order_id: orderId,
    leg: "refund",
    provider: "yellow_card",
    provider_reference: result.refundReference,
    event_type: result.status === "failed" ? "refund_failed" : "refund_initiated",
    provider_state: result.status,
  });

  // created_at set explicitly (not left to the column's DB-side default)
  //, the escalation check right below filters on it via .gte(), so it
  // needs to be unambiguous here rather than implicit, same reasoning as
  // delivery_proofs.submitted_at above.
  await supabase
    .from("supplier_strikes")
    .insert({ supplier_id: order.supplier_id, order_id: orderId, reason: input.category, created_at: new Date().toISOString() });

  const windowStart = new Date(Date.now() - SUPPLIER_STRIKE_WINDOW_MS).toISOString();
  const { count: strikeCount } = await supabase
    .from("supplier_strikes")
    .select("id", { count: "exact", head: true })
    .eq("supplier_id", order.supplier_id)
    .gte("created_at", windowStart);
  const strikes = strikeCount ?? 1;

  if (strikes === 2) {
    await supabase
      .from("supplier_profiles")
      .update({ blocked_until: new Date(Date.now() + SUPPLIER_BLOCK_DURATION_MS).toISOString() })
      .eq("id", order.supplier_id);
  } else if (strikes >= 3) {
    void notifyAdmins(supabase, {
      category: "security",
      eventType: "supplier_strike_escalation",
      resourceType: "supplier_profile",
      resourceId: order.supplier_id,
      title: "Supplier flagged for review",
      body: "A supplier has repeated order abandonments and may need review.",
      deepLink: "/admin?section=users",
      critical: true,
    });
  }

  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "escrow_payment",
    eventType: "supplier_abandoned",
    resourceType: "order",
    resourceId: orderId,
    title: "Order cancelled by supplier",
    body: "Your supplier cancelled this order. You'll be refunded in full.",
    deepLink: `/buyer?order=${orderId}`,
    critical: true,
  });

  return fetchOrder(supabase, orderId);
}

/** Flow 7 / Decision 5: supplier withdraws a submitted proof within a
 * short window, to fix a mistake before the buyer reviews it. No fund
 * movement either way (nothing's settled at proof_submitted), reverts to
 * `fulfilling` so they can resubmit. Logged via order_status_history
 * (every transition already goes there), no separate audit_log entry;
 * this is a routine self-service correction, not an admin-sensitive
 * action. */
export async function withdrawProof(supabase: SupabaseClient, orderId: number, supplierUserId: number): Promise<OrderRow> {
  const order = await fetchOrder(supabase, orderId);
  const { data: supplierProfile } = await supabase.from("supplier_profiles").select("id, user_id").eq("id", order.supplier_id).maybeSingle();
  if (!supplierProfile || supplierProfile.user_id !== supplierUserId) throw new NotOrderOwnerError();
  if (order.status !== "proof_submitted") throw new InvalidOrderTransitionError(order.status, "fulfilling");

  const { data: proof } = await supabase
    .from("delivery_proofs")
    .select("id, submitted_at")
    .eq("order_id", orderId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!proof) throw new Error(`Order ${orderId} has no delivery proof to withdraw.`);

  const submittedAtMs = new Date(proof.submitted_at).getTime();
  if (Date.now() - submittedAtMs > WITHDRAW_PROOF_WINDOW_MS) {
    throw new WithdrawWindowExpiredError();
  }

  const moved = await tryTransition(supabase, orderId, "proof_submitted", "fulfilling", {}, {
    actorId: supplierUserId,
    actorRole: "supplier",
    reasonCategory: "proof_withdrawn",
    reasonText: null,
  });
  if (!moved) throw new InvalidOrderTransitionError(order.status, "fulfilling");

  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "audit_status",
    eventType: "proof_withdrawn",
    resourceType: "order",
    resourceId: orderId,
    title: "Delivery proof withdrawn",
    body: "Your supplier withdrew their delivery proof and will resubmit. Tap to view.",
    deepLink: `/buyer?order=${orderId}`,
  });

  return fetchOrder(supabase, orderId);
}

// ============================================================================
// Admin suspension (flow 10 / Decision 9), orthogonal to role. Blocks
// new orders immediately (createOrder's check above); in-flight orders
// are deliberately left untouched here, not force-cancelled, so a buyer
// mid-delivery isn't punished for a problem that's the supplier's alone.
// An admin can still force-cancel any SPECIFIC in-flight order through
// the existing dispute-resolution path if a particular one genuinely
// needs it.
// ============================================================================

export async function suspendSupplier(supabase: SupabaseClient, supplierUserId: number, adminId: number, reason: string): Promise<UserRow> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("users")
    // session_valid_after (Prompt 4, M5), a suspended supplier's existing
    // sessions are revoked immediately, not just blocked from new orders
    // going forward. Same mechanism logout uses (lib/authz.ts's
    // requireSession()), just triggered by an admin action instead.
    .update({ suspended_at: now, suspension_reason: reason, suspended_by: adminId, session_valid_after: now })
    .eq("id", supplierUserId)
    .eq("role", "supplier")
    .is("suspended_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`User ${supplierUserId} is not a supplier, or is already suspended.`);

  void notifyUser(supabase, {
    userId: supplierUserId,
    category: "security",
    eventType: "account_suspended",
    resourceType: "user",
    resourceId: supplierUserId,
    title: "Account suspended",
    body: "Your supplier account has been suspended. Existing orders are unaffected.",
    deepLink: "/supplier",
    critical: true,
  });

  return data as UserRow;
}

export async function unsuspendSupplier(supabase: SupabaseClient, supplierUserId: number): Promise<UserRow> {
  const { data, error } = await supabase
    .from("users")
    .update({ suspended_at: null, suspension_reason: null, suspended_by: null })
    .eq("id", supplierUserId)
    .eq("role", "supplier")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`User ${supplierUserId} is not a supplier.`);

  void notifyUser(supabase, {
    userId: supplierUserId,
    category: "security",
    eventType: "account_unsuspended",
    resourceType: "user",
    resourceId: supplierUserId,
    title: "Account reinstated",
    body: "Your supplier account is active again. You can receive new orders.",
    deepLink: "/supplier",
  });

  return data as UserRow;
}

// ============================================================================
// Unified timeline (cross-cutting requirement: "Timeline on the request
// shows every transition so both parties see the same history"), merges
// order_status_history, payment_events, and dispute_events into one
// ordered feed. Read-only; the route layer is responsible for the
// ownership check before calling this (same pattern as fetchOrder itself).
// ============================================================================

export interface TimelineEntry {
  type: "status" | "payment" | "dispute";
  timestamp: string;
  summary: string;
}

export async function getOrderTimeline(supabase: SupabaseClient, orderId: number): Promise<TimelineEntry[]> {
  const [{ data: statusRows }, { data: paymentRows }, { data: disputeRows }] = await Promise.all([
    supabase.from("order_status_history").select("*").eq("order_id", orderId).order("created_at"),
    supabase.from("payment_events").select("*").eq("order_id", orderId).order("created_at"),
    supabase.from("disputes").select("id, created_at, resolved_at, category, status").eq("order_id", orderId),
  ]);

  const entries: TimelineEntry[] = [];

  for (const row of statusRows ?? []) {
    const actor = row.actor_role === "system" ? "System" : row.actor_role === "admin" ? "Admin" : row.actor_role === "supplier" ? "Supplier" : "Buyer";
    const fromLabel = row.from_status ? row.from_status.replace(/_/g, " ") : "created";
    entries.push({
      type: "status",
      timestamp: row.created_at,
      summary: `${actor}: ${fromLabel} → ${String(row.to_status).replace(/_/g, " ")}${row.reason_text ? ` (${row.reason_text})` : ""}`,
    });
  }

  for (const row of paymentRows ?? []) {
    entries.push({
      type: "payment",
      timestamp: row.created_at,
      summary: `Payment: ${String(row.event_type).replace(/_/g, " ")}`,
    });
  }

  for (const row of disputeRows ?? []) {
    entries.push({ type: "dispute", timestamp: row.created_at, summary: `Dispute opened (${String(row.category).replace(/_/g, " ")})` });
    if (row.resolved_at) {
      entries.push({ type: "dispute", timestamp: row.resolved_at, summary: `Dispute resolved (${String(row.status).replace(/_/g, " ")})` });
    }
  }

  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return entries;
}

// ============================================================================
// System-initiated timeouts (flows 8a/8b/8c), "Funds must never be
// strandable by inaction from either side." Each helper processes every
// ELIGIBLE order in one pass and is safe to call as often as convenient
// (see app/api/cron/order-timeouts/route.ts): every individual transition
// still goes through tryTransition's compare-and-swap, so running this
// twice in a row, or two overlapping invocations, can't double-process
// the same order, only find zero newly-eligible rows the second time.
// Never an automatic refund/release on a timer with no human option to
// intervene first where real money is at stake (Decision 7), 8b and the
// unmet-verification-call branch of 8c both open a dispute for admin
// review instead of moving money themselves.
// ============================================================================

/** Shared by 8b and 8c's fallback branch, opens a system-initiated
 * dispute the same way rejectProof/reportEarlyIssue do, attributed to
 * `system` in order_status_history (the real record of who/what did
 * this). disputes.raised_by is a NOT NULL FK with no "system" user row to
 * point at, recorded as the buyer's own id (the party a refund would
 * benefit if this resolves that way), same posture as treating the
 * buyer's interest as what's being protected here, not a claim that they
 * personally clicked anything. */
async function systemOpenDisputeForStaleOrder(
  supabase: SupabaseClient,
  order: OrderRow,
  category: DisputeCategory,
  reasonText: string
): Promise<boolean> {
  const moved = await tryTransition(supabase, order.id, order.status, "disputed", {}, {
    actorId: null,
    actorRole: "system",
    reasonCategory: "timeout",
    reasonText,
  });
  if (!moved) return false;

  const { data: dispute, error } = await supabase
    .from("disputes")
    .insert({
      order_id: order.id,
      raised_by: order.buyer_id,
      dispute_type: "pre_approval_rejection" as DisputeType,
      category,
      description: reasonText,
      evidence_urls: [],
      status: "open",
    })
    .select("id")
    .single();

  if (error) {
    // The order already moved to `disputed`, logged loudly, but this
    // must not abort the rest of the batch over one order's dispute-row
    // insert failing.
    console.error(`systemOpenDisputeForStaleOrder: failed to insert disputes row for order ${order.id}:`, error);
    return true;
  }

  await supabase.from("dispute_events").insert({ dispute_id: dispute.id, actor_id: null, event_type: "opened_by_system" });
  notifyDisputeOpened(supabase, order);
  return true;
}

/** 8c's main branch, buyer went silent on submitted proof, but ONLY once
 * the mandatory verification call requirement is already satisfied.
 * Deliberately mirrors approveOrder rather than calling it: approveOrder
 * hard-checks buyerId ownership, which a system-initiated approval has no
 * real buyerId for, a separate, clearly-system-labeled function is
 * safer than loosening that check to accept a null caller. */
async function systemAutoApprove(supabase: SupabaseClient, paymentProvider: PaymentBoundary, order: OrderRow): Promise<boolean> {
  const approved = await tryTransition(supabase, order.id, "proof_submitted", "buyer_approved", {}, {
    actorId: null,
    actorRole: "system",
    reasonCategory: "timeout",
    reasonText: `Auto-approved after ${PROOF_NO_RESPONSE_TIMEOUT_MS / (24 * 60 * 60 * 1000)} days of buyer inactivity.`,
  });
  if (!approved) return false;

  const released = await tryTransition(supabase, order.id, "buyer_approved", "release_submitted");
  if (released) {
    try {
      const result = await paymentProvider.initiateEscrowRelease(order.id);
      await supabase.from("payment_events").insert({
        order_id: order.id,
        leg: "release",
        provider: "circle",
        provider_reference: result.releaseReference,
        event_type: result.status === "failed" ? "release_failed" : "release_initiated",
        provider_state: result.status,
      });
    } catch (err) {
      console.error(`systemAutoApprove: escrow release failed for order ${order.id}, stuck at release_submitted:`, err);
      await supabase.from("payment_events").insert({
        order_id: order.id,
        leg: "release",
        provider: "circle",
        provider_reference: null,
        event_type: "release_failed",
        provider_state: "error",
        raw_payload: { error: err instanceof Error ? err.message : String(err) },
      });
      // Don't rethrow, one order's release failure inside a batch job
      // must not abort the rest of the batch. Same "logged loudly, needs
      // a real retry action, not silently lost" posture approveOrder's
      // own comment states for the identical failure mode.
      return true;
    }
  }

  void notifyUser(supabase, {
    userId: order.buyer_id,
    category: "audit_status",
    eventType: "proof_auto_approved",
    resourceType: "order",
    resourceId: order.id,
    title: "Delivery auto-approved",
    body: "You didn't respond in time, so this delivery was automatically approved. Funds are being released.",
    deepLink: `/buyer?order=${order.id}`,
    critical: true,
  });
  getSupplierUserId(supabase, order.supplier_id).then((supplierUserId) => {
    if (supplierUserId == null) return;
    void notifyUser(supabase, {
      userId: supplierUserId,
      category: "audit_status",
      eventType: "proof_auto_approved",
      resourceType: "order",
      resourceId: order.id,
      title: "Delivery approved automatically",
      body: "The buyer didn't respond in time, so your delivery was auto-approved. Funds are being released.",
      deepLink: `/supplier?order=${order.id}`,
    });
  });

  return true;
}

export interface TimeoutRunResult {
  expiredUnfunded: number;
  staleFundedDisputed: number;
  autoApproved: number;
}

/** The one entry point the cron route calls. Processes all three timeout
 * types in one pass; returns counts for logging/observability, never
 * partial-failure detail beyond what's already console.error'd per-order
 * above, a bad row shouldn't stop the rest of the batch, and the route
 * layer doesn't need per-order detail to report success. */
export async function runOrderTimeouts(supabase: SupabaseClient, paymentProvider: PaymentBoundary): Promise<TimeoutRunResult> {
  const result: TimeoutRunResult = { expiredUnfunded: 0, staleFundedDisputed: 0, autoApproved: 0 };

  // 8a (Decision 6): unfunded order sitting too long. orders.created_at is
  // a reasonable proxy for "how long has this been unfunded", nothing
  // moves money here regardless, so the imprecision (a payment_failed
  // order's actual attempt could've happened well after creation) is
  // low-stakes.
  const unfundedCutoff = new Date(Date.now() - UNFUNDED_ORDER_EXPIRY_MS).toISOString();
  const { data: staleUnfunded } = await supabase
    .from("orders")
    .select("id, status")
    .in("status", ["pending_payment", "payment_failed"])
    .lt("created_at", unfundedCutoff);
  for (const row of staleUnfunded ?? []) {
    const moved = await tryTransition(supabase, row.id as number, row.status as OrderStatus, "expired", {}, {
      actorId: null,
      actorRole: "system",
      reasonCategory: "timeout",
      reasonText: `No payment after ${UNFUNDED_ORDER_EXPIRY_MS / (24 * 60 * 60 * 1000)} days.`,
    });
    if (moved) result.expiredUnfunded += 1;
  }

  // 8b (Decision 7): funded but no proof ever submitted. Uses
  // order_status_history's real "reached funded" timestamp, not
  // orders.created_at, which would be wrong here (a buyer can take days
  // to actually fund after creating the order), this one moves real
  // money if it later resolves against the supplier, so the precision
  // matters more than 8a's.
  const fundedCutoff = new Date(Date.now() - FUNDED_NO_PROOF_TIMEOUT_MS).toISOString();
  const { data: fundedTransitions } = await supabase
    .from("order_status_history")
    .select("order_id, created_at")
    .eq("to_status", "funded")
    .lt("created_at", fundedCutoff);
  for (const t of fundedTransitions ?? []) {
    const order = await fetchOrder(supabase, t.order_id as number).catch(() => null);
    if (!order || (order.status !== "funded" && order.status !== "fulfilling")) continue; // already moved on since
    const opened = await systemOpenDisputeForStaleOrder(
      supabase,
      order,
      "item_not_delivered",
      `No delivery proof submitted within ${FUNDED_NO_PROOF_TIMEOUT_MS / (24 * 60 * 60 * 1000)} days of funding.`
    );
    if (opened) result.staleFundedDisputed += 1;
  }

  // 8c (Decision 8): proof submitted, buyer never responded. Auto-approve
  // ONLY once BOTH mandatory call gates are already satisfied (enough
  // call time, AND the buyer confirmed the order code matched on
  // camera), silence is not a reason to also waive a safety-critical
  // gate. If either isn't satisfied, this falls back to the same
  // auto-dispute-for-review path as 8b rather than either silently
  // approving past the requirement or leaving the order stuck forever.
  const noResponseCutoff = new Date(Date.now() - PROOF_NO_RESPONSE_TIMEOUT_MS).toISOString();
  const { data: staleProofs } = await supabase.from("delivery_proofs").select("order_id, submitted_at").lt("submitted_at", noResponseCutoff);
  for (const proof of staleProofs ?? []) {
    const order = await fetchOrder(supabase, proof.order_id as number).catch(() => null);
    if (!order || order.status !== "proof_submitted") continue; // already approved/rejected/disputed since

    if ((order.verification_call_seconds ?? 0) >= MIN_VERIFICATION_CALL_SECONDS && order.call_code_confirmed_at) {
      const approved = await systemAutoApprove(supabase, paymentProvider, order);
      if (approved) result.autoApproved += 1;
    } else {
      const opened = await systemOpenDisputeForStaleOrder(
        supabase,
        order,
        "other",
        `Buyer did not respond within ${PROOF_NO_RESPONSE_TIMEOUT_MS / (24 * 60 * 60 * 1000)} days, and the mandatory verification call was never completed.`
      );
      if (opened) result.staleFundedDisputed += 1;
    }
  }

  return result;
}
