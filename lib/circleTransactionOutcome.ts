// lib/circleTransactionOutcome.ts
//
// One place that interprets a Circle transaction's `state` into
// "confirmed" / "terminal failure" / "still in flight", shared by
// lib/circleEscrowProvider.ts's poller AND app/api/webhooks/circle's
// webhook handler, so the two paths can never disagree about what a
// given state means. States verified directly against the installed
// @circle-fin/developer-controlled-wallets SDK's own `TransactionState`
// enum (CANCELLED, CONFIRMED, COMPLETE, DENIED, FAILED, INITIATED,
// PENDING_RISK_SCREENING, QUEUED, SENT), not guessed.
//
// A local, narrow shape rather than importing the SDK's own `Transaction`
// type: only `state`/`txHash`/`errorReason` are used here, and the
// bundled .d.ts doesn't cleanly re-export `Transaction` by that exact
// name at the package's top level (confirmed against the installed
// version — `Transactions`, plural, is what resolves there instead).
export interface CircleTransactionLike {
  state: string;
  txHash?: string;
  errorReason?: string;
}

export type CircleTransactionOutcome =
  | { kind: "confirmed"; txHash: string | undefined; state: string }
  | { kind: "failed"; state: string; errorReason: string | undefined }
  | { kind: "pending"; state: string };

export function resolveCircleTransactionOutcome(txn: CircleTransactionLike): CircleTransactionOutcome {
  if (txn.state === "COMPLETE" || txn.state === "CONFIRMED") {
    return { kind: "confirmed", txHash: txn.txHash, state: txn.state };
  }
  if (txn.state === "FAILED" || txn.state === "CANCELLED" || txn.state === "DENIED") {
    return { kind: "failed", state: txn.state, errorReason: txn.errorReason };
  }
  // QUEUED, SENT, INITIATED, PENDING_RISK_SCREENING, or any future state
  // Circle adds that this app doesn't recognize yet, all treated the
  // same way: not done, keep watching, never guess at a terminal outcome.
  return { kind: "pending", state: txn.state };
}
