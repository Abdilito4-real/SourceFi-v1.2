"use client";

// components/OrderDetailsModal.tsx
//
// Supersedes RequestDetailsModal.tsx + TransactionLedger.tsx, one modal
// that fetches the full order (GET /api/orders/[id]: order + payment
// events + delivery proofs + disputes + rating) and renders whatever
// action is legal next, by (role, status). Every button here calls a
// route that's independently requireRole()-checked server-side, this
// component enables/disables buttons for UX only, per CLAUDE.md's rule
// that the client never IS the authorization boundary.
//
// Buyer-facing copy never says USDC, Circle, or Yellow Card, see
// components/ui/StatusBadge.tsx's same rule. The buyer sees "processing
// your payment", not the underlying rails (design doc Section 3).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Clock, Star, AlertTriangle, Image as ImageIcon, Receipt, Video, History } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import StatusBadge from "./ui/StatusBadge";
import { Label, Input, Textarea } from "./ui/Field";
import Select from "./ui/Select";
import Skeleton from "./ui/Skeleton";
import ConfirmDialog from "./ui/ConfirmDialog";
import ErrorPanel from "./ui/ErrorPanel";
import TransactionProgress, { type TransactionStep } from "./ui/TransactionProgress";
import JitsiMeetRoom from "./JitsiMeetRoom";
import { formatMoney, CANCELLATION_FEE_MINOR, TYPED_CONFIRMATION_THRESHOLD_MINOR } from "../lib/money";
import { useNetworkStatus } from "../lib/useNetworkStatus";
import { playIncomingCallChime } from "../lib/callSound";
import type {
  BuyerCancellationCategory,
  DeliveryProofRow,
  DisputeCategory,
  DisputeRow,
  JaasCallConfig,
  OrderRow,
  OrderStatus,
  PaymentEventRow,
  RatingRow,
  Role,
  SupplierExitCategory,
} from "../lib/types";

const BUYER_CANCELLATION_CATEGORIES: { value: BuyerCancellationCategory; label: string }[] = [
  { value: "changed_mind", label: "Changed my mind" },
  { value: "found_alternative", label: "Found an alternative" },
  { value: "no_longer_needed", label: "No longer needed" },
  { value: "price_disagreement", label: "Price disagreement" },
  { value: "other", label: "Other" },
];

const SUPPLIER_EXIT_CATEGORIES: { value: SupplierExitCategory; label: string }[] = [
  { value: "cannot_fulfill", label: "Can't fulfill this order" },
  { value: "schedule_conflict", label: "Schedule conflict" },
  { value: "pricing_error", label: "Pricing error" },
  { value: "other", label: "Other" },
];

// Mirrors lib/orderService.ts's WITHDRAW_PROOF_WINDOW_MS, client-side
// copy for showing/hiding the Withdraw button and a countdown; the server
// route is the actual enforcement.
const WITHDRAW_PROOF_WINDOW_MS = 30 * 60 * 1000;

// Post-funding, pre-approval, the window where a live call between
// buyer and supplier actually makes sense: funds are already in escrow
// so there's something real to verify, and approval (which fires the
// release) hasn't happened yet. Not offered before `funded` (nothing to
// inspect yet) or after approval (the call's whole purpose, verifying
// before releasing, has already passed).
const LIVE_CALL_ELIGIBLE_STATUSES = new Set(["funded", "fulfilling", "proof_submitted"]);

// Mirrors lib/orderService.ts's MIN_VERIFICATION_CALL_SECONDS, that
// server-side value is the actual enforcement (approveOrder rejects
// early otherwise); this client-side copy is only for showing progress
// and disabling the button before wasting a round trip. Kept in sync by
// hand, same posture as the live-verification-check duplication between
// app/api/suppliers/route.ts and the is_supplier_currently_verified()
// Postgres function, no codegen linking them.
const MIN_VERIFICATION_CALL_SECONDS = 5 * 60;

const DISPUTE_CATEGORIES: { value: DisputeCategory; label: string }[] = [
  { value: "item_not_as_described", label: "Item not as described" },
  { value: "item_not_delivered", label: "Item not delivered" },
  { value: "quality_issue", label: "Quality issue" },
  { value: "wrong_quantity", label: "Wrong quantity" },
  { value: "damaged_in_transit", label: "Damaged in transit" },
  { value: "other", label: "Other" },
];

// Statuses where the underlying payment/blockchain state is still
// resolving, the modal polls while in one of these so the buyer/supplier
// see the outcome without having to close and reopen it.
const IN_FLIGHT_STATUSES = new Set([
  "payment_processing",
  "converting",
  "escrow_depositing",
  "release_submitted",
  "release_processing",
  "settlement_processing",
  "refund_processing",
]);

interface OrderDetail {
  order: OrderRow;
  paymentEvents: PaymentEventRow[];
  deliveryProofs: DeliveryProofRow[];
  disputes: DisputeRow[];
  rating: RatingRow | null;
  /** Present only once JaaS is configured server-side, see
   * lib/jaasAuth.ts. Null falls back to the free meet.jit.si join. */
  callConfig: JaasCallConfig | null;
}

/** submitted/processing progress for whichever leg (payment or release) is
 * currently in flight, feedback-layer rule: distinguish these three
 * states clearly, not just a bare spinner. Never returns "confirmed": once
 * a leg actually confirms, order.status leaves IN_FLIGHT_STATUSES
 * entirely and the terminal-state banners below (funded/escrow_released/
 * settled) take over as that confirmation. */
function getInFlightProgress(status: OrderStatus): { legLabel: string; step: TransactionStep } | null {
  switch (status) {
    case "payment_processing":
      return { legLabel: "Payment", step: "submitted" };
    case "converting":
    case "escrow_depositing":
      return { legLabel: "Payment", step: "processing" };
    case "release_submitted":
      return { legLabel: "Release", step: "submitted" };
    case "release_processing":
    case "settlement_processing":
      return { legLabel: "Release", step: "processing" };
    case "refund_processing":
      return { legLabel: "Refund", step: "processing" };
    default:
      return null;
  }
}

interface FinancialError {
  title: string;
  detail?: string;
  fundPosition: string;
  referenceCode?: string;
}

export interface OrderDetailsModalProps {
  orderId: number;
  role: Role;
  canTransact: boolean;
  onClose: () => void;
  onOrderChange?: (order: OrderRow) => void;
  showNotification: (type: "success" | "error" | "info", message: string) => void;
  /** Fired right after a successful /fund call, the "moment value is
   * obvious" push-notification soft prompt (feedback-layer Prompt 2)
   * hooks in here, not on page load. Buyer-side only; nothing calls this
   * for a supplier/admin viewer. */
  onFunded?: () => void;
  /** Set when this modal was opened from a "Join call" push notification
   * (deep link's ?call=1, see lib/orderService.ts's setCallPresence and
   * worker/index.ts), auto-opens the call panel once the order loads
   * instead of making the user find and click into it themselves. */
  autoJoinCall?: boolean;
  /** Fired once the auto-join above has actually happened, so the caller
   * can clear its own flag, a later order opened in the same session
   * (without a fresh ?call=1) shouldn't inherit it. */
  onAutoJoinCallHandled?: () => void;
}

export default function OrderDetailsModal({
  orderId,
  role,
  canTransact,
  onClose,
  onOrderChange,
  showNotification,
  onFunded,
  autoJoinCall,
  onAutoJoinCallHandled,
}: OrderDetailsModalProps) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [showFundConfirm, setShowFundConfirm] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [fundError, setFundError] = useState<FinancialError | null>(null);
  const [approveError, setApproveError] = useState<FinancialError | null>(null);
  const [showCall, setShowCall] = useState(false);
  const [incomingCallBannerOpen, setIncomingCallBannerOpen] = useState(false);
  const prevCounterpartyInCallRef = useRef(false);
  const online = useNetworkStatus();
  const [proofPhotoUrl, setProofPhotoUrl] = useState("");
  const [proofReceiptUrl, setProofReceiptUrl] = useState("");
  const [proofNotes, setProofNotes] = useState("");
  const [ratingScore, setRatingScore] = useState(5);
  const [ratingComment, setRatingComment] = useState("");
  const [showReportIssue, setShowReportIssue] = useState(false);
  const [issueCategory, setIssueCategory] = useState<DisputeCategory>("quality_issue");
  const [issueDescription, setIssueDescription] = useState("");
  const [showEarlyIssueForm, setShowEarlyIssueForm] = useState(false);
  const [earlyIssueCategory, setEarlyIssueCategory] = useState<DisputeCategory>("item_not_delivered");
  const [earlyIssueDescription, setEarlyIssueDescription] = useState("");
  // Termination flows (Prompt 3).
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelCategory, setCancelCategory] = useState<BuyerCancellationCategory>("changed_mind");
  const [cancelDescription, setCancelDescription] = useState("");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelError, setCancelError] = useState<FinancialError | null>(null);
  const [showAbandonForm, setShowAbandonForm] = useState(false);
  const [abandonCategory, setAbandonCategory] = useState<SupplierExitCategory>("cannot_fulfill");
  const [abandonDescription, setAbandonDescription] = useState("");
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);
  const [abandonError, setAbandonError] = useState<FinancialError | null>(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectCategory, setRejectCategory] = useState<DisputeCategory>("item_not_as_described");
  const [rejectDescription, setRejectDescription] = useState("");
  const [rejectEvidenceUrl, setRejectEvidenceUrl] = useState("");
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [timelineEntries, setTimelineEntries] = useState<{ type: string; timestamp: string; summary: string }[] | null>(null);
  const [loadingTimeline, setLoadingTimeline] = useState(false);
  // When the CURRENT in-flight streak started, and a ticking clock to
  // measure it, a bare spinner with no escalation is exactly what
  // "hung" felt like from a stuck settlement (see
  // lib/paymentBoundary.ts's fix for the actual cause). This doesn't fix
  // a real provider hanging, but it stops leaving the buyer staring at
  // an indefinite spinner with zero signal that anything's unusual.
  const [inFlightSince, setInFlightSince] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orders/${orderId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load order.");
      setDetail(data);
      onOrderChange?.(data.order);
    } catch (err) {
      showNotification("error", err instanceof Error ? err.message : "Failed to load order.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  // Answering a call, not just opening the order it's attached to: once
  // the order has actually loaded and is in a state the call is legal
  // for, open the call panel immediately rather than requiring an extra
  // click on top of the one that already brought the user here.
  useEffect(() => {
    if (!autoJoinCall || !detail) return;
    if (LIVE_CALL_ELIGIBLE_STATUSES.has(detail.order.status)) setShowCall(true);
    onAutoJoinCallHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoJoinCall, detail]);

  // Poll while an async payment step is in flight, the stub provider
  // resolves in milliseconds, but a real Yellow Card/Circle integration
  // won't, so this is genuinely needed, not just cosmetic (design doc
  // Section D.5: poll is the recommended confirmation mechanism for this
  // stage).
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (detail && IN_FLIGHT_STATUSES.has(detail.order.status)) {
      pollRef.current = setInterval(load, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [detail, load]);

  // Tracks how long the CURRENT in-flight status has persisted, resets
  // the moment the status actually changes (a fresh leg starting is not
  // "still stuck on the last one").
  useEffect(() => {
    const status = detail?.order.status;
    if (status && IN_FLIGHT_STATUSES.has(status)) {
      setInFlightSince((prev) => prev ?? Date.now());
    } else {
      setInFlightSince(null);
    }
  }, [detail?.order.status]);

  useEffect(() => {
    if (inFlightSince === null) return;
    const tick = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [inFlightSince]);

  const inFlightElapsedSeconds = inFlightSince !== null ? Math.floor((nowTick - inFlightSince) / 1000) : 0;
  const isTakingLong = inFlightElapsedSeconds >= 20;

  // Deliberately separate from runAction: reporting a completed call
  // segment shouldn't toggle the shared `acting` state (which disables
  // unrelated buttons) or show a toast every time, it happens silently
  // in the background as segments end, sometimes more than once per
  // session if the call drops and reconnects.
  const reportCallSegment = async (seconds: number) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/call-progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secondsElapsed: seconds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to record call progress.");
      await load();
    } catch (err) {
      showNotification("error", err instanceof Error ? err.message : "Failed to record call progress.");
    }
  };

  // Immediate join/leave presence, best-effort, silent: a failure here
  // just means the other party doesn't get an incoming-call prompt this
  // time, not worth interrupting the call itself over.
  const reportCallPresence = useCallback(
    (active: boolean) => {
      fetch(`/api/orders/${orderId}/call-presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      }).catch(() => {});
    },
    [orderId]
  );

  // Polls while a live call is actually possible, so a fresh
  // buyer_call_active_since/supplier_call_active_since from the OTHER
  // party shows up here without requiring this order to already be
  // mid-payment (the existing in-flight poll below doesn't cover this
  // window at all).
  useEffect(() => {
    const status = detail?.order.status;
    const eligible = status && LIVE_CALL_ELIGIBLE_STATUSES.has(status) && (role === "buyer" || role === "supplier") && canTransact;
    if (!eligible) return;
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [detail?.order.status, role, canTransact, load]);

  // Chime + banner on the RISING edge only (not on every poll tick while
  // it stays true), and never while this party already has the call
  // panel open, they don't need an "incoming call" prompt for a call
  // they're already in.
  const counterpartyCallActiveSince =
    role === "buyer" ? detail?.order.supplier_call_active_since : role === "supplier" ? detail?.order.buyer_call_active_since : null;
  const counterpartyInCall = Boolean(counterpartyCallActiveSince && Date.now() - new Date(counterpartyCallActiveSince).getTime() < 45_000);

  useEffect(() => {
    if (counterpartyInCall && !prevCounterpartyInCallRef.current && !showCall) {
      setIncomingCallBannerOpen(true);
      playIncomingCallChime();
    }
    if (!counterpartyInCall) setIncomingCallBannerOpen(false);
    prevCounterpartyInCallRef.current = counterpartyInCall;
  }, [counterpartyInCall, showCall]);

  const runAction = async (path: string, body?: unknown, successMessage?: string) => {
    setActing(true);
    try {
      const res = await fetch(`/api/orders/${orderId}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Action failed.");
      if (successMessage) showNotification("success", successMessage);
      await load();
      return true;
    } catch (err) {
      showNotification("error", err instanceof Error ? err.message : "Action failed.");
      return false;
    } finally {
      setActing(false);
    }
  };

  // Fund/approve specifically: distinct from runAction above because a
  // failure here needs PERSISTENT on-screen state, not just a toast, "a
  // toast that disappears while the user is scrolled elsewhere is not a
  // receipt" applies just as much to a failure as a success. setError puts
  // the failure into an <ErrorPanel> that stays until the user dismisses
  // it or retries, and always states the fund position explicitly rather
  // than leaving the buyer to assume the worst.
  const runFinancialAction = async (
    path: string,
    body: unknown | undefined,
    opts: { successMessage: string; fundPosition: string; setError: (e: FinancialError | null) => void }
  ) => {
    opts.setError(null);
    setActing(true);
    try {
      const res = await fetch(`/api/orders/${orderId}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        opts.setError({
          title: data.error || "That didn't go through.",
          fundPosition: opts.fundPosition,
          referenceCode: data.referenceCode,
        });
        return false;
      }
      if (data.alreadyInProgress) {
        // The first attempt already moved the order forward, not a
        // failure. Just refresh and show the real server-side status.
        showNotification("info", "Already in progress, refreshing status.");
        await load();
        return true;
      }
      showNotification("success", opts.successMessage);
      await load();
      return true;
    } catch {
      // fetch itself threw, network drop, not a server response at all.
      opts.setError({
        title: "Couldn't reach the server.",
        detail: "Check your connection and try again.",
        fundPosition: opts.fundPosition,
      });
      return false;
    } finally {
      setActing(false);
    }
  };

  const loadTimeline = async () => {
    setLoadingTimeline(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/timeline`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load timeline.");
      setTimelineEntries(data.timeline ?? []);
    } catch (err) {
      showNotification("error", err instanceof Error ? err.message : "Failed to load timeline.");
    } finally {
      setLoadingTimeline(false);
    }
  };

  // Cancel (flows 1 & 4), one route, server picks the right consequence
  // by current status. Client mirrors that split only for copy/typed-
  // confirmation purposes; the server is the actual authority.
  const runCancel = async () => {
    const isFundedCancel = detail?.order.status === "funded" || detail?.order.status === "fulfilling";
    const ok = await runFinancialAction("/cancel", { category: cancelCategory, description: cancelDescription.trim() || null }, {
      successMessage: "Order cancelled.",
      fundPosition: isFundedCancel ? "Your refund is being processed." : "No money has left your account.",
      setError: setCancelError,
    });
    setShowCancelConfirm(false);
    if (ok) {
      setShowCancelForm(false);
      setCancelDescription("");
    }
  };

  // Abandon (flow 6), supplier-side, always a full refund.
  const runAbandon = async () => {
    const ok = await runFinancialAction("/abandon", { category: abandonCategory, description: abandonDescription.trim() || null }, {
      successMessage: "Order cancelled. The buyer will be refunded in full.",
      fundPosition: "The buyer's funds are still in escrow and will be refunded.",
      setError: setAbandonError,
    });
    setShowAbandonConfirm(false);
    if (ok) {
      setShowAbandonForm(false);
      setAbandonDescription("");
    }
  };

  // Reject (flow 3, reinstated), freezes funds, opens a dispute. Not a
  // financial action in the runFinancialAction sense (nothing settles
  // here), so it reuses the plain runAction path like the other
  // dispute-opening flows in this file.
  const runReject = async () => {
    const ok = await runAction(
      "/reject",
      {
        category: rejectCategory,
        description: rejectDescription.trim() || null,
        evidenceUrls: rejectEvidenceUrl.trim() ? [rejectEvidenceUrl.trim()] : [],
      },
      "Delivery proof rejected. This order is now under dispute review."
    );
    setShowRejectConfirm(false);
    if (ok) {
      setShowRejectForm(false);
      setRejectDescription("");
      setRejectEvidenceUrl("");
    }
  };

  const runWithdrawProof = async () => {
    const ok = await runAction("/withdraw-proof", undefined, "Delivery proof withdrawn. You can resubmit.");
    setShowWithdrawConfirm(false);
    return ok;
  };

  if (loading || !detail) {
    return (
      <Modal open onClose={onClose} size="lg">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-4 h-24 w-full" />
        </div>
      </Modal>
    );
  }

  const { order, deliveryProofs, disputes, rating } = detail;
  const proof = deliveryProofs[0];
  const activeDispute = disputes.find((d) => d.status === "open" || d.status === "under_review");
  const isBuyer = role === "buyer" && canTransact;
  const isSupplier = role === "supplier" && canTransact;
  const listingUnitPriceMinor = order.listing_unit_price_minor ?? null;
  const listingUnit = order.listing_unit ?? null;
  const verificationCallSeconds = order.verification_call_seconds ?? 0;
  const callRequirementMet = verificationCallSeconds >= MIN_VERIFICATION_CALL_SECONDS;
  const inFlightProgress = getInFlightProgress(order.status);
  const needsTypedConfirm = order.amount_minor >= TYPED_CONFIRMATION_THRESHOLD_MINOR;
  const formattedAmount = formatMoney(order.amount_minor, "NGN");

  return (
    <Modal open onClose={onClose} size="lg" className="max-h-[90vh] overflow-y-auto" dismissible={!acting}>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-xs tracking-wide text-accent-text">{order.order_code}</div>
          <h2 className="font-display text-xl font-semibold text-text-primary">{order.title}</h2>
        </div>
        <StatusBadge status={order.status} />
      </div>

      {incomingCallBannerOpen && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent bg-accent-soft px-4 py-3">
          <span className="flex items-center gap-2.5 text-sm font-semibold text-accent-text">
            <Video size={16} className="pulse-dot shrink-0" />
            Your {isBuyer ? "supplier" : "buyer"} is on a live verification call right now.
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                setShowCall(true);
                setIncomingCallBannerOpen(false);
              }}
            >
              Join now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIncomingCallBannerOpen(false)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-border bg-surface-sunken p-4 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Total amount</div>
          <div className="mt-0.5 font-semibold text-text-primary">{formatMoney(order.amount_minor, "NGN")}</div>
          {listingUnitPriceMinor != null && (
            <div className="mt-0.5 text-xs text-text-tertiary">
              {formatMoney(listingUnitPriceMinor, "NGN")}
              {listingUnit ? ` ${listingUnit}` : ""} × {order.quantity?.match(/^\d+(\.\d+)?/)?.[0] || "?"}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Supplier</div>
          <div className="mt-0.5 text-text-primary">{order.supplier_business_name || "—"}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Delivery location</div>
          <div className="mt-0.5 text-text-primary">{order.delivery_location}</div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Quantity</div>
          <div className="mt-0.5 text-text-primary">{order.quantity || "—"}</div>
        </div>
      </div>

      {order.description && <p className="mt-4 text-sm leading-relaxed text-text-secondary">{order.description}</p>}

      {/* In-flight state: no jargon, just "this is happening". Escalates
          past a plain spinner once it's run long enough to look stuck. */}
      {IN_FLIGHT_STATUSES.has(order.status) && (
        <div className="mt-5 flex flex-col gap-3 rounded-lg border border-border bg-accent-soft px-4 py-3 text-sm text-accent-text">
          {inFlightProgress && (
            <TransactionProgress state={inFlightProgress.step} labels={{ submitted: `${inFlightProgress.legLabel} submitted` }} />
          )}
          <div className="flex items-center gap-2.5">
            <Loader2 size={15} className="spin-icon shrink-0" />
            {order.status === "payment_processing" || order.status === "converting" || order.status === "escrow_depositing"
              ? "Processing your payment. This usually takes a few moments."
              : order.status === "refund_processing"
              ? "Processing your refund."
              : "Processing the payment to your supplier."}
          </div>
          {isTakingLong && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning bg-warning-soft px-3 py-2 text-xs text-warning-text">
              <span>
                This is taking longer than usual ({inFlightElapsedSeconds}s). It can still complete normally, but
                flag it if it doesn't resolve soon.
              </span>
              <Button size="sm" variant="secondary" onClick={load}>
                Check again
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Buyer: fund order. Irreversible, so this needs a confirmation
          step, not a single tap; above the threshold it needs the
          amount typed back too. */}
      {isBuyer && (order.status === "pending_payment" || order.status === "payment_failed") && (
        <div className="mt-5">
          {order.status === "payment_failed" && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-xs text-danger-text">
              <AlertTriangle size={14} /> Your last payment attempt didn't go through. No money has left your account, you can try again.
            </div>
          )}
          {fundError && (
            <div className="mb-3">
              <ErrorPanel
                title={fundError.title}
                detail={fundError.detail}
                fundPosition={fundError.fundPosition}
                referenceCode={fundError.referenceCode}
                retrying={acting}
                onRetry={() =>
                  runFinancialAction("/fund", undefined, {
                    successMessage: "Payment started.",
                    fundPosition: "No money has left your account.",
                    setError: setFundError,
                  })
                }
                onDismiss={() => setFundError(null)}
              />
            </div>
          )}
          {!online && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-xs text-warning-text">
              <AlertTriangle size={14} /> You&rsquo;re offline. Funding escrow needs a connection. Reconnect and try again.
            </div>
          )}
          <Button fullWidth disabled={!online} onClick={() => setShowFundConfirm(true)}>
            Fund order: {formattedAmount}
          </Button>
          <ConfirmDialog
            open={showFundConfirm}
            title="Confirm payment"
            body={
              <>
                You&rsquo;re about to pay <strong>{formattedAmount}</strong> for this order. The funds move into escrow
                and are held there. Your supplier is only paid once you approve the delivery. This starts a real
                payment; make sure the amount and supplier are right before confirming.
                <p className="mt-2 text-xs text-text-tertiary">
                  Cancellation policy: cancelling before your supplier submits proof refunds everything except a{" "}
                  {formatMoney(CANCELLATION_FEE_MINOR, "NGN")} fee. Cancelling now, before funding, is always free.
                </p>
              </>
            }
            confirmLabel={`Yes, pay ${formattedAmount}`}
            loading={acting}
            requireTypedConfirmation={needsTypedConfirm ? formattedAmount : undefined}
            onConfirm={async () => {
              // Close either way, success or failure: on failure the
              // persistent ErrorPanel above needs to be visible (it's
              // hidden behind this dialog while open), and its own Retry
              // button re-runs the same action without asking the user to
              // re-confirm intent they already gave once.
              const ok = await runFinancialAction("/fund", undefined, {
                successMessage: "Payment started.",
                fundPosition: "No money has left your account.",
                setError: setFundError,
              });
              setShowFundConfirm(false);
              if (ok) onFunded?.();
            }}
            onCancel={() => setShowFundConfirm(false)}
          />

          {/* Flow 1: cancel before funding, free, no dispute. */}
          {!showCancelForm ? (
            <button type="button" onClick={() => setShowCancelForm(true)} className="mt-3 text-xs font-semibold text-text-secondary underline hover:text-text-primary">
              Cancel this order instead
            </button>
          ) : (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Cancel order</div>
              <Select value={cancelCategory} onChange={(e) => setCancelCategory(e.target.value as BuyerCancellationCategory)}>
                {BUYER_CANCELLATION_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <Textarea value={cancelDescription} onChange={(e) => setCancelDescription(e.target.value)} placeholder="Optional: anything else we should know?" />
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => setShowCancelConfirm(true)}>
                  Cancel order
                </Button>
                <Button variant="ghost" onClick={() => setShowCancelForm(false)}>
                  Never mind
                </Button>
              </div>
            </div>
          )}
          {cancelError && (
            <div className="mt-3">
              <ErrorPanel
                title={cancelError.title}
                detail={cancelError.detail}
                fundPosition={cancelError.fundPosition}
                referenceCode={cancelError.referenceCode}
                retrying={acting}
                onRetry={runCancel}
                onDismiss={() => setCancelError(null)}
              />
            </div>
          )}
          <ConfirmDialog
            open={showCancelConfirm}
            tone="danger"
            title="Confirm cancellation"
            body={<>You&rsquo;re about to cancel this order. No payment has been made yet, so nothing is charged and nothing needs to be refunded.</>}
            confirmLabel="Yes, cancel order"
            loading={acting}
            onConfirm={runCancel}
            onCancel={() => setShowCancelConfirm(false)}
          />
        </div>
      )}

      {/* Supplier: submit delivery proof */}
      {isSupplier && (order.status === "funded" || order.status === "fulfilling") && (
        <div className="mt-5 flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Submit delivery proof</div>
          <div>
            <Label htmlFor="proof-photo">Photo URL</Label>
            <Input id="proof-photo" placeholder="https://…" value={proofPhotoUrl} onChange={(e) => setProofPhotoUrl(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="proof-receipt">Receipt URL (optional)</Label>
            <Input id="proof-receipt" placeholder="https://…" value={proofReceiptUrl} onChange={(e) => setProofReceiptUrl(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="proof-notes">Notes</Label>
            <Textarea id="proof-notes" value={proofNotes} onChange={(e) => setProofNotes(e.target.value)} placeholder="Delivered to site, spoke with foreman…" />
          </div>
          <Button
            loading={acting}
            disabled={!proofPhotoUrl.trim() && !proofReceiptUrl.trim()}
            onClick={() =>
              runAction(
                "/proof",
                { photoUrls: proofPhotoUrl.trim() ? [proofPhotoUrl.trim()] : [], receiptUrl: proofReceiptUrl.trim() || null, notes: proofNotes.trim() || null },
                "Delivery proof submitted."
              )
            }
          >
            Submit proof
          </Button>

          {/* Flow 6: supplier exits before proof. Full refund, no fee,
              recorded as a strike (2nd within 90 days blocks new orders). */}
          {!showAbandonForm ? (
            <button type="button" onClick={() => setShowAbandonForm(true)} className="self-start text-xs font-semibold text-danger-text underline">
              Can&rsquo;t fulfill this order?
            </button>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-danger bg-danger-soft p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-danger-text">Cancel this order</div>
              <Select value={abandonCategory} onChange={(e) => setAbandonCategory(e.target.value as SupplierExitCategory)}>
                {SUPPLIER_EXIT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <Textarea value={abandonDescription} onChange={(e) => setAbandonDescription(e.target.value)} placeholder="Optional: anything else we should know?" />
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => setShowAbandonConfirm(true)}>
                  Cancel order
                </Button>
                <Button variant="ghost" onClick={() => setShowAbandonForm(false)}>
                  Never mind
                </Button>
              </div>
            </div>
          )}
          {abandonError && (
            <ErrorPanel
              title={abandonError.title}
              detail={abandonError.detail}
              fundPosition={abandonError.fundPosition}
              referenceCode={abandonError.referenceCode}
              retrying={acting}
              onRetry={runAbandon}
              onDismiss={() => setAbandonError(null)}
            />
          )}
          <ConfirmDialog
            open={showAbandonConfirm}
            tone="danger"
            title="Confirm cancellation"
            body={
              <>
                You&rsquo;re about to cancel this order. The buyer will be refunded the full{" "}
                <strong>{formattedAmount}</strong>, no fee, since this wasn&rsquo;t their choice. This will be recorded
                against your account; repeated cancellations can temporarily block you from new orders.
              </>
            }
            confirmLabel="Yes, cancel order"
            loading={acting}
            onConfirm={runAbandon}
            onCancel={() => setShowAbandonConfirm(false)}
          />
        </div>
      )}
      {isSupplier && order.status !== "funded" && order.status !== "fulfilling" && order.status !== "pending_payment" && !proof && (
        <div className="mt-5 text-sm text-text-secondary">Waiting on the buyer to fund this order before you can begin.</div>
      )}

      {/* Buyer: waiting on fulfillment, with an out if something's
          already wrong before proof is submitted. */}
      {isBuyer && (order.status === "funded" || order.status === "fulfilling") && (
        <div className="mt-5">
          <div className="rounded-xl border border-border bg-surface-sunken p-4 text-sm text-text-secondary">
            {order.status === "fulfilling" ? "Your supplier is preparing this order." : "Waiting on your supplier to begin fulfilling this order."}
          </div>
          {!showEarlyIssueForm ? (
            <button type="button" onClick={() => setShowEarlyIssueForm(true)} className="mt-3 text-xs font-semibold text-danger-text underline">
              Something's already wrong, report it now
            </button>
          ) : (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-danger bg-danger-soft p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-danger-text">Report a problem</div>
              <Select value={earlyIssueCategory} onChange={(e) => setEarlyIssueCategory(e.target.value as DisputeCategory)}>
                {DISPUTE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <Textarea value={earlyIssueDescription} onChange={(e) => setEarlyIssueDescription(e.target.value)} placeholder="What's wrong?" required />
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  loading={acting}
                  disabled={!earlyIssueDescription.trim()}
                  onClick={() =>
                    runAction(
                      "/report-early-issue",
                      { category: earlyIssueCategory, description: earlyIssueDescription },
                      "Reported. This order is now under review."
                    )
                  }
                >
                  Submit report
                </Button>
                <Button variant="ghost" disabled={acting} onClick={() => setShowEarlyIssueForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Flow 4: a clean exit, no fault alleged, skips the dispute
              path. Refund minus the disclosed CANCELLATION_FEE_MINOR. */}
          {!showCancelForm ? (
            <button type="button" onClick={() => setShowCancelForm(true)} className="mt-3 text-xs font-semibold text-text-secondary underline hover:text-text-primary">
              Cancel this order
            </button>
          ) : (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Cancel order</div>
              <p className="text-xs text-text-secondary">
                You&rsquo;ll be refunded {formatMoney(order.amount_minor - CANCELLATION_FEE_MINOR, "NGN")} of your{" "}
                {formattedAmount} payment. A {formatMoney(CANCELLATION_FEE_MINOR, "NGN")} fee applies once an order is
                funded, disclosed before you paid.
              </p>
              <Select value={cancelCategory} onChange={(e) => setCancelCategory(e.target.value as BuyerCancellationCategory)}>
                {BUYER_CANCELLATION_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <Textarea value={cancelDescription} onChange={(e) => setCancelDescription(e.target.value)} placeholder="Optional: anything else we should know?" />
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => setShowCancelConfirm(true)}>
                  Cancel order
                </Button>
                <Button variant="ghost" onClick={() => setShowCancelForm(false)}>
                  Never mind
                </Button>
              </div>
            </div>
          )}
          {cancelError && (
            <div className="mt-3">
              <ErrorPanel
                title={cancelError.title}
                detail={cancelError.detail}
                fundPosition={cancelError.fundPosition}
                referenceCode={cancelError.referenceCode}
                retrying={acting}
                onRetry={runCancel}
                onDismiss={() => setCancelError(null)}
              />
            </div>
          )}
          <ConfirmDialog
            open={showCancelConfirm}
            tone="danger"
            title="Confirm cancellation"
            body={
              <>
                You&rsquo;re about to cancel this order. <strong>{formatMoney(order.amount_minor - CANCELLATION_FEE_MINOR, "NGN")}</strong> will
                be refunded to you; <strong>{formatMoney(CANCELLATION_FEE_MINOR, "NGN")}</strong> is retained as the
                disclosed cancellation fee. This can&rsquo;t be undone.
              </>
            }
            confirmLabel="Yes, cancel order"
            loading={acting}
            requireTypedConfirmation={needsTypedConfirm ? formattedAmount : undefined}
            onConfirm={runCancel}
            onCancel={() => setShowCancelConfirm(false)}
          />
        </div>
      )}

      {/* Delivery proof review (both roles can see it once submitted) */}
      {proof && (
        <div className="mt-5 rounded-xl border border-border p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">Delivery proof</div>
          <div className="flex flex-wrap gap-2 text-sm text-text-secondary">
            {proof.photo_urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 hover:border-border-strong">
                <ImageIcon size={13} /> Photo
              </a>
            ))}
            {proof.receipt_url && (
              <a href={proof.receipt_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 hover:border-border-strong">
                <Receipt size={13} /> Receipt
              </a>
            )}
          </div>
          {proof.notes && <p className="mt-2 text-sm leading-relaxed text-text-secondary">{proof.notes}</p>}

          {/* Flow 7: supplier can withdraw within a short window to fix a
              mistake before the buyer reviews it. No fund movement.
              Window enforced server-side; this just hides the option
              once it's closed. */}
          {isSupplier && order.status === "proof_submitted" && Date.now() - new Date(proof.submitted_at).getTime() < WITHDRAW_PROOF_WINDOW_MS && (
            <div className="mt-3 border-t border-border pt-3">
              <button type="button" onClick={() => setShowWithdrawConfirm(true)} className="text-xs font-semibold text-text-secondary underline hover:text-text-primary">
                Made a mistake? Withdraw and resubmit
              </button>
              <ConfirmDialog
                open={showWithdrawConfirm}
                title="Withdraw delivery proof?"
                body={<>You&rsquo;ll be able to resubmit right away. No funds are affected either way.</>}
                confirmLabel="Yes, withdraw"
                loading={acting}
                onConfirm={runWithdrawProof}
                onCancel={() => setShowWithdrawConfirm(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* Live verification call, buyer and supplier can join the same
          room before the buyer approves. Not embedded by default,
          metered mobile data is a real constraint, loads on request. */}
      {(isBuyer || isSupplier) && LIVE_CALL_ELIGIBLE_STATUSES.has(order.status) && (
        <div className="mt-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            {!showCall && (
              <Button variant="secondary" onClick={() => setShowCall(true)}>
                <Video size={15} /> {verificationCallSeconds > 0 ? "Continue" : "Start"} live verification call
              </Button>
            )}
            <span className={`text-xs font-semibold ${callRequirementMet ? "text-success-text" : "text-text-secondary"}`}>
              {callRequirementMet
                ? `✓ ${Math.floor(verificationCallSeconds / 60)}:${(verificationCallSeconds % 60).toString().padStart(2, "0")} verified, requirement met`
                : `${Math.floor(verificationCallSeconds / 60)}:${(verificationCallSeconds % 60).toString().padStart(2, "0")} / 5:00 verified`}
            </span>
          </div>
          {showCall && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                  Live call: share this order with your {isBuyer ? "supplier" : "buyer"} to meet here
                </span>
                <button type="button" onClick={() => setShowCall(false)} className="text-xs font-semibold text-text-secondary underline hover:text-text-primary">
                  Hide
                </button>
              </div>
              {order.verification_call_room_id ? (
                <JitsiMeetRoom
                  roomId={order.verification_call_room_id}
                  displayLabel={order.order_code}
                  displayName={isBuyer ? "SourceFi Buyer" : "SourceFi Supplier"}
                  onSegmentComplete={reportCallSegment}
                  onJoined={() => reportCallPresence(true)}
                  onLeft={() => reportCallPresence(false)}
                  callConfig={detail.callConfig}
                />
              ) : (
                <div className="mt-3 flex h-[320px] w-full items-center justify-center rounded-xl border border-border bg-black text-sm text-white/70">
                  Setting up your private call room…
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Buyer: accept or reject delivery. Accept stays disabled until the
          verification call requirement is met (enforced server-side in
          orderService.ts's approveOrder). Releasing funds is irreversible,
          so it also needs an explicit confirm step. */}
      {isBuyer && order.status === "proof_submitted" && (
        <div className="mt-5">
          {!callRequirementMet && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2.5 text-xs text-warning-text">
              <Video size={14} className="mt-0.5 shrink-0" />
              <span>
                Accepting delivery is suspended until you complete a live verification call of at least 5 minutes with your
                supplier:{" "}
                <strong>
                  {Math.floor(verificationCallSeconds / 60)}:{(verificationCallSeconds % 60).toString().padStart(2, "0")} / 5:00
                </strong>{" "}
                so far.
              </span>
            </div>
          )}
          {approveError && (
            <div className="mb-3">
              <ErrorPanel
                title={approveError.title}
                detail={approveError.detail}
                fundPosition={approveError.fundPosition}
                referenceCode={approveError.referenceCode}
                retrying={acting}
                onRetry={() =>
                  runFinancialAction("/approve", undefined, {
                    successMessage: "Order accepted. Releasing funds to your supplier.",
                    fundPosition: "Your funds are still held in escrow, nothing has been released.",
                    setError: setApproveError,
                  })
                }
                onDismiss={() => setApproveError(null)}
              />
            </div>
          )}
          {!online && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-xs text-warning-text">
              <AlertTriangle size={14} /> You&rsquo;re offline. Releasing funds needs a connection. Reconnect and try again.
            </div>
          )}
          <span title={callRequirementMet ? undefined : "Complete the 5-minute verification call above first."}>
            <Button fullWidth disabled={!callRequirementMet || !online} onClick={() => setShowApproveConfirm(true)}>
              <CheckCircle2 size={15} /> Accept delivery
            </Button>
          </span>
          <ConfirmDialog
            open={showApproveConfirm}
            tone="danger"
            title="Confirm release"
            body={
              <>
                You&rsquo;re about to release <strong>{formattedAmount}</strong> to{" "}
                <strong>{order.supplier_business_name || "this supplier"}</strong>. This can&rsquo;t be undone once the
                transfer confirms. Only continue if you&rsquo;ve reviewed the delivery proof above and you&rsquo;re
                satisfied.
              </>
            }
            confirmLabel={`Yes, release ${formattedAmount}`}
            loading={acting}
            requireTypedConfirmation={needsTypedConfirm ? formattedAmount : undefined}
            onConfirm={async () => {
              await runFinancialAction("/approve", undefined, {
                successMessage: "Order accepted. Releasing funds to your supplier.",
                fundPosition: "Your funds are still held in escrow, nothing has been released.",
                setError: setApproveError,
              });
              setShowApproveConfirm(false);
            }}
            onCancel={() => setShowApproveConfirm(false)}
          />

          {!showRejectForm ? (
            <button type="button" onClick={() => setShowRejectForm(true)} className="mt-3 text-xs font-semibold text-danger-text underline">
              Something's wrong with this delivery
            </button>
          ) : (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-danger bg-danger-soft p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-danger-text">Reject delivery</div>
              <p className="text-xs leading-relaxed text-danger-text">
                This freezes the funds and opens a dispute. Nothing releases to your supplier until an admin reviews it.
              </p>
              <Select value={rejectCategory} onChange={(e) => setRejectCategory(e.target.value as DisputeCategory)}>
                {DISPUTE_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
              <Textarea value={rejectDescription} onChange={(e) => setRejectDescription(e.target.value)} placeholder="What's wrong?" required />
              <div>
                <Label htmlFor="reject-evidence">Supporting evidence (photo/document URL)</Label>
                <Input id="reject-evidence" placeholder="https://…" value={rejectEvidenceUrl} onChange={(e) => setRejectEvidenceUrl(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Button variant="danger" disabled={!rejectDescription.trim()} onClick={() => setShowRejectConfirm(true)}>
                  Reject delivery
                </Button>
                <Button variant="ghost" disabled={acting} onClick={() => setShowRejectForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <ConfirmDialog
            open={showRejectConfirm}
            tone="danger"
            title="Confirm rejection"
            body={
              <>
                Rejecting freezes <strong>{formattedAmount}</strong> in escrow and opens a dispute. Neither you nor your
                supplier can move these funds until an admin reviews it. This can&rsquo;t be undone once submitted.
              </>
            }
            confirmLabel="Yes, reject delivery"
            loading={acting}
            onConfirm={runReject}
            onCancel={() => setShowRejectConfirm(false)}
          />
        </div>
      )}

      {/* Dispute status, visible to whoever's involved */}
      {activeDispute && (
        <div className="mt-5 rounded-xl border border-danger bg-danger-soft p-4">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-danger-text">
            <Clock size={13} /> {activeDispute.dispute_type === "post_settlement_report" ? "Issue reported, under review" : "Under dispute review"}
          </div>
          <p className="text-sm text-text-secondary">{activeDispute.description}</p>
          <p className="mt-2 text-xs text-text-tertiary">
            An admin will review this and rule for the {isBuyer ? "buyer or supplier" : "buyer or you"}. You'll be notified once resolved.
          </p>
        </div>
      )}

      {/* Terminal states */}
      {order.status === "escrow_released" && (
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-success bg-success-soft px-4 py-3 text-sm text-success-text">
          <CheckCircle2 size={15} /> Funds released. Paying your supplier now.
        </div>
      )}
      {order.status === "settled" && (
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-center gap-2 rounded-lg border border-success bg-success-soft px-4 py-3 text-sm text-success-text">
            <CheckCircle2 size={15} /> Order complete, supplier has been paid.
          </div>

          {isBuyer && !rating && (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Rate this supplier</div>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" onClick={() => setRatingScore(n)} aria-label={`${n} star${n === 1 ? "" : "s"}`}>
                    <Star size={22} className={n <= ratingScore ? "fill-accent text-accent" : "text-border-strong"} />
                  </button>
                ))}
              </div>
              <Textarea placeholder="Optional comment" value={ratingComment} onChange={(e) => setRatingComment(e.target.value)} />
              <Button
                loading={acting}
                onClick={() => runAction("/rating", { score: ratingScore, comment: ratingComment.trim() || null }, "Thanks for rating this supplier.")}
              >
                Submit rating
              </Button>
            </div>
          )}
          {isBuyer && rating && (
            <div className="rounded-xl border border-border p-4 text-sm text-text-secondary">
              You rated this supplier {rating.score}/5{rating.comment ? `: "${rating.comment}"` : ""}.
              {!rating.on_chain_confirmed_at && (
                <span className="mt-1 block text-xs text-text-tertiary">Recorded, awaiting on-chain confirmation.</span>
              )}
            </div>
          )}

          {isBuyer && (
            <div>
              {!showReportIssue ? (
                <button type="button" onClick={() => setShowReportIssue(true)} className="text-xs font-semibold text-danger-text underline">
                  Report an issue with this order
                </button>
              ) : (
                <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                    Report an issue. This order stays complete; an admin reviews separately.
                  </div>
                  <Select value={issueCategory} onChange={(e) => setIssueCategory(e.target.value as DisputeCategory)}>
                    {DISPUTE_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                  <Textarea value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} placeholder="What went wrong?" required />
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      loading={acting}
                      disabled={!issueDescription.trim()}
                      onClick={async () => {
                        const ok = await runAction("/report-issue", { category: issueCategory, description: issueDescription }, "Issue reported. An admin will review it.");
                        if (ok) setShowReportIssue(false);
                      }}
                    >
                      Submit report
                    </Button>
                    <Button variant="ghost" disabled={acting} onClick={() => setShowReportIssue(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {order.status === "refunded" && (
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
          <Badge tone="neutral">Refunded</Badge> This order was refunded to the buyer.
        </div>
      )}
      {order.status === "cancelled" && <div className="mt-5 text-sm text-text-secondary">This order was cancelled.</div>}
      {order.status === "expired" && <div className="mt-5 text-sm text-text-secondary">This order expired.</div>}

      {/* Timeline: every transition, always available, any status, both
          roles. Fetched lazily since most views don't need it. */}
      <div className="mt-6 border-t border-border pt-4">
        <button
          type="button"
          onClick={() => {
            setShowTimeline((v) => !v);
            if (!showTimeline && timelineEntries === null) loadTimeline();
          }}
          className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary hover:text-text-primary"
        >
          <History size={13} /> {showTimeline ? "Hide" : "View"} order history
        </button>
        {showTimeline && (
          <div className="mt-3">
            {loadingTimeline ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : timelineEntries && timelineEntries.length > 0 ? (
              <ol className="flex flex-col gap-2 border-l border-border pl-4">
                {timelineEntries.map((entry, i) => (
                  <li key={i} className="text-xs text-text-secondary">
                    <span className="font-mono text-[10px] text-text-tertiary">{new Date(entry.timestamp).toLocaleString()}</span>
                    <br />
                    {entry.summary}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-text-tertiary">No history yet.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
