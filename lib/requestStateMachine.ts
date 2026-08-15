// lib/requestStateMachine.ts
//
// The one place that says which sourcing_requests.status transitions are
// legal — Stage 5's explicit ask: "no free-form status writes from the
// client." Every status-changing action in app/api/escrow/route.ts calls
// assertTransition() before its update instead of encoding "which prior
// status is this action allowed to fire from" as a magic string inline.
//
// This is the CURRENT app's eight-state machine (see lib/types.ts's
// RequestStatus) — not a preview of Stage 6's richer state list
// (funded/verification_in_progress/audit_submitted/approved/refunded/
// timeouts). Stage 6 defines its own rules around that list when it gets
// there; adopting it early here would mean guessing at rules that don't
// exist yet.
//
// disputed/cancelled/expired have no route that transitions INTO them yet
// (Stage 8 builds dispute filing; nothing currently cancels or expires a
// request) — they're included as valid destinations so the schema and this
// map are ready for that stage, not because something reachable today
// uses them.
import type { RequestStatus } from "./types";

const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  open: ["claimed", "cancelled", "expired"],
  claimed: ["escrow", "cancelled", "expired"],
  escrow: ["verified", "disputed"],
  verified: ["escrow_released", "disputed"],
  escrow_released: [],
  disputed: [],
  cancelled: [],
  expired: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: RequestStatus, to: RequestStatus) {
    super(`Cannot transition a sourcing request from "${from}" to "${to}".`);
    this.name = "InvalidTransitionError";
  }
}

/** Throws InvalidTransitionError if `to` isn't a legal next state from
 * `from`. Route handlers still use a compare-and-swap `.eq("status", from)`
 * on the actual DB update — this doesn't replace that (races are still
 * only resolved at the DB level) — it's what makes each action's expected
 * "from" state explicit and centrally defined instead of an assumption
 * baked separately into N different .eq() calls. */
export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
