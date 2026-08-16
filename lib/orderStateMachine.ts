// lib/orderStateMachine.ts
//
// The one place that says which orders.status transitions are legal —
// same discipline as lib/requestStateMachine.ts before it: "no free-form
// status writes from the client." Every status-changing action in the
// order/payment routes calls assertTransition() before its update,
// instead of encoding "which prior status is this action allowed to fire
// from" as a magic string inline. Route handlers still use a
// compare-and-swap `.eq("status", from)` on the actual DB update — this
// doesn't replace that (races are still only resolved at the DB level) —
// it's what makes each action's expected "from" state explicit and
// centrally defined instead of an assumption baked separately into N
// different .eq() calls.
//
// See docs/marketplace-payments-design.md Section D.1 for the full
// annotated state diagram this map encodes, and Section D.0 for why
// buyer_approved / release_submitted / release_processing / escrow_released
// are four separate states rather than one — verified directly against
// the installed Circle SDK types, not assumed.
import type { OrderStatus } from "./types";

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["payment_processing", "cancelled", "expired"],
  payment_processing: ["payment_failed", "converting"],
  payment_failed: ["payment_processing"],
  converting: ["escrow_depositing"],
  escrow_depositing: ["funded"],

  // `fulfilling` is optional UX (design doc Section D.1) — a supplier can
  // submit proof directly from `funded` without ever passing through it.
  funded: ["fulfilling", "proof_submitted", "disputed"],
  fulfilling: ["proof_submitted"],

  proof_submitted: ["buyer_approved", "rejected"],
  // rejected is NOT terminal — it always routes to disputed automatically
  // (design doc's transition table), never sits unresolved.
  rejected: ["disputed"],

  // buyer_approved is INTENT only — no funds have moved. Do not add a
  // direct buyer_approved -> escrow_released transition, ever: that is
  // precisely the bug this whole redesign exists to fix (Section D.0).
  buyer_approved: ["release_submitted"],
  release_submitted: ["release_processing", "disputed"],
  release_processing: ["escrow_released", "disputed"],

  // escrow_released means Circle's transfer reached CONFIRMED/COMPLETE
  // with a real txHash on file — see design doc D.0. It is NOT the same
  // as the supplier having been paid in NGN; that's settlement_processing
  // -> settled, a separate async leg through Yellow Card.
  escrow_released: ["settlement_processing"],
  settlement_processing: ["settled", "disputed"],

  // Terminal. A post-settlement problem is a NEW disputes row
  // (dispute_type = 'post_settlement_report'), never a transition out of
  // this status — see design doc's explicit note under the D.1 diagram.
  // Do not add settled -> disputed here; that would silently reintroduce
  // the "conflating a normal outcome with an open question" mistake this
  // design document was written to avoid.
  settled: [],

  disputed: ["refund_processing", "release_submitted"],
  refund_processing: ["refunded"],

  refunded: [],
  cancelled: [],
  expired: [],
};

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Cannot transition an order from "${from}" to "${to}".`);
    this.name = "InvalidOrderTransitionError";
  }
}

/** Throws InvalidOrderTransitionError if `to` isn't a legal next status
 * from `from`. Route handlers still perform a compare-and-swap
 * `.eq("status", from)` on the actual DB update — this doesn't replace
 * that (races are still only resolved at the DB level) — it's what
 * makes each action's expected "from" state explicit and centrally
 * defined instead of an assumption baked separately into N different
 * .eq() calls, same pattern as assertTransition in
 * lib/requestStateMachine.ts. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
}

/** Statuses with no legal outgoing transition — useful for route/UI code
 * that needs to know "is this order done, one way or another" without
 * re-deriving the list from TRANSITIONS by hand. */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = (
  Object.keys(TRANSITIONS) as OrderStatus[]
).filter((status) => TRANSITIONS[status].length === 0);

/** Statuses where a buyer can open a dispute against the order WITHOUT
 * it being a post-settlement report — i.e. dispute_type would be
 * 'pre_approval_rejection'-adjacent (before or during review, funds
 * still in escrow). Route handlers use this to decide which dispute_type
 * to stamp, not to gate whether the order.status itself changes (only
 * `funded` and `rejected` actually transition the order's own status
 * into `disputed`; a dispute filed in another pre-settlement state is
 * still a disputes row, but see design doc Section D.1 — only those two
 * edges exist on the order itself). */
export const PRE_SETTLEMENT_DISPUTE_ELIGIBLE_STATUSES: OrderStatus[] = [
  "funded",
  "fulfilling",
  "proof_submitted",
  "rejected",
];
