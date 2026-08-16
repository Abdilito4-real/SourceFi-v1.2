// The one place that says which orders.status transitions are legal.
// No free-form status writes from the client: every status-changing
// action calls assertTransition() before its DB update. The route's own
// compare-and-swap (`.eq("status", from)`) still resolves races at the
// DB level, this just keeps each action's expected "from" state
// explicit and centralized instead of duplicated across N .eq() calls.
//
// Full annotated state diagram: docs/marketplace-payments-design.md
// Section D.1. Section D.0 explains why buyer_approved /
// release_submitted / release_processing / escrow_released are four
// separate states, not one.
import type { OrderStatus } from "./types";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  // A failed payment can cancel outright instead of retrying.
  pending_payment: ["payment_processing", "cancelled", "expired"],
  payment_processing: ["payment_failed", "converting"],
  payment_failed: ["payment_processing", "cancelled"],
  converting: ["escrow_depositing"],
  escrow_depositing: ["funded"],

  // `fulfilling` is optional UX, a supplier can submit proof directly
  // from `funded`. Both allow a direct dispute before proof exists.
  //
  // `refund_processing` is the one clean non-dispute exit from a funded
  // order: the buyer's own cancellation (cancelFundedOrder, fee
  // applies) or the supplier's voluntary abandonment (abandonOrder,
  // full refund). Same target state either way, the caller context is
  // recorded in order_cancellations instead.
  funded: ["fulfilling", "proof_submitted", "disputed", "refund_processing"],
  fulfilling: ["proof_submitted", "disputed", "refund_processing"],

  // A supplier can withdraw their own proof within a short window (see
  // WITHDRAW_PROOF_WINDOW_MS) to fix a mistake and resubmit. No funds
  // have settled yet, so this is a pure workflow reversal.
  proof_submitted: ["buyer_approved", "rejected", "fulfilling"],
  // rejected always routes to disputed, it never sits unresolved.
  rejected: ["disputed"],

  // buyer_approved is INTENT only, no funds have moved yet. Never add a
  // direct buyer_approved -> escrow_released transition.
  buyer_approved: ["release_submitted"],
  release_submitted: ["release_processing", "disputed"],
  release_processing: ["escrow_released", "disputed"],

  // escrow_released means Circle's transfer reached CONFIRMED/COMPLETE
  // with a real txHash. Not the same as the supplier being paid in NGN,
  // that's settlement_processing -> settled, via Yellow Card.
  escrow_released: ["settlement_processing"],
  settlement_processing: ["settled", "disputed"],

  // Terminal. A post-settlement problem is a new disputes row
  // (dispute_type = 'post_settlement_report'), never a transition out
  // of this status. Do not add settled -> disputed here.
  settled: [],

  disputed: ["refund_processing", "release_submitted"],
  refund_processing: ["refunded"],

  refunded: [],
  cancelled: [],
  expired: [],
};

export class InvalidOrderTransitionError extends Error {
  /** `from`/`to` are exposed so callers can tell a genuine illegal
   * transition apart from `from === to` (a retry landing after the
   * order already advanced, see fund/route.ts and approve/route.ts). */
  readonly from: OrderStatus;
  readonly to: OrderStatus;

  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Cannot transition an order from "${from}" to "${to}".`);
    this.name = "InvalidOrderTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** Throws InvalidOrderTransitionError if `to` isn't a legal next status
 * from `from`. Route handlers still do the real compare-and-swap on the
 * DB update, this just keeps the expected "from" state explicit. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}

/** Statuses with no legal outgoing transition, i.e. the order is done. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = (
  Object.keys(TRANSITIONS) as OrderStatus[]
).filter((status) => TRANSITIONS[status].length === 0);

/** Statuses where a buyer can dispute before settlement (funds still
 * in escrow), used to pick the dispute_type to stamp. `proof_submitted`
 * goes through reject first (`proof_submitted -> rejected -> disputed`)
 * to capture the rejection reason. */
export const PRE_SETTLEMENT_DISPUTE_ELIGIBLE_STATUSES: OrderStatus[] = [
  "funded",
  "fulfilling",
  "proof_submitted",
  "rejected",
];

/** Statuses `approveOrder` produces or leads to. A retry landing after
 * the order already advanced throws with `from` set to one of these
 * (not `to`, unlike fundOrder's retry case). approve/route.ts uses
 * this to give that case a friendly "already in progress" response. */
export const POST_APPROVAL_STATUSES: OrderStatus[] = [
  "buyer_approved",
  "release_submitted",
  "release_processing",
  "escrow_released",
  "settlement_processing",
  "settled",
];
