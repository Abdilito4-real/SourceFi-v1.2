// lib/paymentBoundary.ts
//
// docs/marketplace-payments-design.md Section E — the contract between
// this application layer and the payment/blockchain layer (Yellow Card +
// Circle + smart contracts), which is explicitly NOT this codebase's
// responsibility to implement (see the design doc's Section 9 / "My
// Responsibilities"). Nothing in app/ ever imports a Yellow Card or
// Circle SDK directly — every route that moves money calls one of these
// four functions and reacts to reportPaymentStatus updates, whether
// those arrive by webhook or by a poll job. That's what makes it
// possible to build and test the entire order/ledger/dispute/rating flow
// against StubPaymentProvider below before the real integration exists,
// and to swap it in later without touching route code.
import type { DisputeType, PaymentLeg, PaymentProvider } from "./types";

export interface FundingResult {
  paymentReference: string;
  status: "processing" | "failed";
}

export interface ReleaseResult {
  releaseReference: string;
  status: "processing" | "failed";
}

export interface RefundResult {
  refundReference: string;
  status: "processing" | "failed";
}

export interface RatingSubmissionResult {
  txHash: string | null;
  status: "submitted" | "confirmed";
}

/** The shape both a webhook handler and a poll job normalize provider
 * responses into before handing them to the order-service layer (Stage 4
 * of the pivot) — which is what actually writes payment_events,
 * advances orders.status via lib/orderStateMachine.ts, and calls
 * lib/ledger.ts once a leg is truly confirmed. txHash is only ever
 * present once a transfer has ACTUALLY reached a confirmed state on the
 * provider's side — never synthesized here or anywhere downstream (see
 * design doc Section D.0). */
export interface PaymentStatusEvent {
  orderId: number;
  leg: PaymentLeg;
  provider: PaymentProvider;
  providerReference: string;
  providerState: string;
  txHash?: string;
  amountMinor?: number;
  currency?: string;
}

/** The full boundary. An implementation of this interface is the ONLY
 * thing route code is allowed to depend on for money movement — never a
 * concrete Yellow Card/Circle client. */
export interface PaymentBoundary {
  /** Called when the buyer clicks "Fund Order". */
  initiateOrderFunding(orderId: number): Promise<FundingResult>;
  /** Called when the buyer approves delivery proof. */
  initiateEscrowRelease(orderId: number): Promise<ReleaseResult>;
  /** Called after an admin rules a dispute for the buyer. */
  initiateRefund(orderId: number, amountMinor: number): Promise<RefundResult>;
  /** Called after a settled order's buyer submits a rating. */
  submitRatingOnChain(
    orderId: number,
    supplierId: number,
    score: number,
    comment: string | null
  ): Promise<RatingSubmissionResult>;
}

/** A deliberately fake, deterministic implementation — no network calls,
 * no credentials required. Exists so the order routes (Stage 3 cont'd /
 * Stage 4 of the pivot) and their tests can exercise the ENTIRE
 * pending_payment -> ... -> settled lifecycle without Yellow Card or
 * Circle existing yet, per the design doc's stated goal of incremental
 * integration. Swap PaymentBoundary implementations via
 * getPaymentProvider() below — never by editing route code.
 *
 * Behavior: every `initiate*` call immediately reports "processing" (this
 * always matches reality — no payment API confirms synchronously, see
 * design doc Section D.0) and schedules a fake confirmation a few
 * milliseconds later via the injected `onStatusUpdate` callback, so a
 * caller who wires that callback up to the real order-service state
 * transitions sees the exact same shape of event sequence a real
 * provider integration would produce. */
export class StubPaymentProvider implements PaymentBoundary {
  private readonly onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void;
  private readonly simulatedDelayMs: number;
  private counter = 0;

  constructor(onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void, simulatedDelayMs = 10) {
    this.onStatusUpdate = onStatusUpdate;
    this.simulatedDelayMs = simulatedDelayMs;
  }

  private nextReference(prefix: string): string {
    this.counter += 1;
    return `${prefix}-stub-${Date.now()}-${this.counter}`;
  }

  private fakeTxHash(): string {
    return "0x" + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  async initiateOrderFunding(orderId: number): Promise<FundingResult> {
    const paymentReference = this.nextReference("fund");
    void this.scheduleConfirmation(orderId, "funding", "yellow_card", paymentReference);
    return { paymentReference, status: "processing" };
  }

  async initiateEscrowRelease(orderId: number): Promise<ReleaseResult> {
    const releaseReference = this.nextReference("release");
    void this.scheduleConfirmation(orderId, "release", "circle", releaseReference).then(() => {
      // lib/orderService.ts's handleReleaseConfirmed auto-advances
      // escrow_released -> settlement_processing and then waits for a
      // SEPARATE leg='settlement' event — by design (Section E), there's
      // no initiateSettlement boundary call, because a real Yellow Card
      // integration reports that back on its own timeline once the NGN
      // payout actually completes, not something we initiate. The stub
      // has no real Yellow Card to ever send that follow-up event on its
      // own, though — without simulating it here, EVERY order would hang
      // in settlement_processing forever, which is exactly the bug this
      // fixes (an order stuck on "Processing the payment to your
      // supplier" indefinitely). This compressed immediate chaining is
      // stub-only; a real integration's settlement event arrives
      // independently, whenever the actual payout clears.
      const settlementReference = this.nextReference("settlement");
      void this.scheduleConfirmation(orderId, "settlement", "yellow_card", settlementReference);
    });
    return { releaseReference, status: "processing" };
  }

  async initiateRefund(orderId: number, _amountMinor: number): Promise<RefundResult> {
    const refundReference = this.nextReference("refund");
    void this.scheduleConfirmation(orderId, "refund", "yellow_card", refundReference);
    return { refundReference, status: "processing" };
  }

  async submitRatingOnChain(
    _orderId: number,
    _supplierId: number,
    _score: number,
    _comment: string | null
  ): Promise<RatingSubmissionResult> {
    // Deliberately NOT auto-confirmed like the other three — see design
    // doc Open Question 10: on-chain ratings mechanics (which
    // chain/contract) aren't decided yet. This stub returns "submitted",
    // never "confirmed", so calling code can't accidentally treat a
    // rating as independently verifiable before a real contract exists.
    return { txHash: null, status: "submitted" };
  }

  private async scheduleConfirmation(
    orderId: number,
    leg: PaymentLeg,
    provider: PaymentProvider,
    providerReference: string
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.simulatedDelayMs));
    await this.onStatusUpdate({
      orderId,
      leg,
      provider,
      providerReference,
      providerState: provider === "circle" ? "CONFIRMED" : "confirmed",
      txHash: provider === "circle" ? this.fakeTxHash() : undefined,
    });
  }
}

/** dispute_type values that are eligible to actually trigger
 * initiateRefund automatically once an admin rules for the buyer, vs.
 * ones where the ruling is recorded but money movement stays a manual
 * step until Stage 9's real integration exists — see design doc Open
 * Question 9. Not wired into anything yet; exported so the
 * dispute-resolution route (Stage 3 cont'd) has one place to check
 * rather than an inline decision. */
export const AUTO_REFUND_ELIGIBLE_DISPUTE_TYPES: DisputeType[] = ["pre_approval_rejection"];
