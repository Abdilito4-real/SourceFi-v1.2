"use client";

// components/OrderDetailsModal.tsx
//
// Supersedes RequestDetailsModal.tsx + TransactionLedger.tsx — one modal
// that fetches the full order (GET /api/orders/[id]: order + payment
// events + delivery proofs + disputes + rating) and renders whatever
// action is legal next, by (role, status). Every button here calls a
// route that's independently requireRole()-checked server-side — this
// component enables/disables buttons for UX only, per CLAUDE.md's rule
// that the client never IS the authorization boundary.
//
// Buyer-facing copy never says USDC, Circle, or Yellow Card — see
// components/ui/StatusBadge.tsx's same rule. The buyer sees "processing
// your payment", not the underlying rails (design doc Section 3).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Clock, Star, AlertTriangle, Image as ImageIcon, Receipt, Video } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import StatusBadge from "./ui/StatusBadge";
import { Label, Input, Textarea } from "./ui/Field";
import Select from "./ui/Select";
import Skeleton from "./ui/Skeleton";
import JitsiMeetRoom from "./JitsiMeetRoom";
import { formatMoney } from "../lib/money";
import type { DeliveryProofRow, DisputeCategory, DisputeRow, OrderRow, PaymentEventRow, RatingRow, Role } from "../lib/types";

// Post-funding, pre-approval — the window where a live call between
// buyer and supplier actually makes sense: funds are already in escrow
// so there's something real to verify, and approval (which fires the
// release) hasn't happened yet. Not offered before `funded` (nothing to
// inspect yet) or after approval (the call's whole purpose — verifying
// before releasing — has already passed).
const LIVE_CALL_ELIGIBLE_STATUSES = new Set(["funded", "fulfilling", "proof_submitted"]);

// Mirrors lib/orderService.ts's MIN_VERIFICATION_CALL_SECONDS — that
// server-side value is the actual enforcement (approveOrder rejects
// early otherwise); this client-side copy is only for showing progress
// and disabling the button before wasting a round trip. Kept in sync by
// hand, same posture as the live-verification-check duplication between
// app/api/suppliers/route.ts and the is_supplier_currently_verified()
// Postgres function — no codegen linking them.
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
// resolving — the modal polls while in one of these so the buyer/supplier
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
}

export interface OrderDetailsModalProps {
  orderId: number;
  role: Role;
  canTransact: boolean;
  onClose: () => void;
  onOrderChange?: (order: OrderRow) => void;
  showNotification: (type: "success" | "error" | "info", message: string) => void;
}

export default function OrderDetailsModal({ orderId, role, canTransact, onClose, onOrderChange, showNotification }: OrderDetailsModalProps) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [showApproveConfirm, setShowApproveConfirm] = useState(false);
  const [showCall, setShowCall] = useState(false);
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
  // When the CURRENT in-flight streak started, and a ticking clock to
  // measure it — a bare spinner with no escalation is exactly what
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

  // Poll while an async payment step is in flight — the stub provider
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

  // Tracks how long the CURRENT in-flight status has persisted — resets
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
  // unrelated buttons) or show a toast every time — it happens silently
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

  return (
    <Modal open onClose={onClose} size="lg" className="max-h-[90vh] overflow-y-auto">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-xs tracking-wide text-accent-text">{order.order_code}</div>
          <h2 className="font-display text-xl font-semibold text-text-primary">{order.title}</h2>
        </div>
        <StatusBadge status={order.status} />
      </div>

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

      {/* In-flight processing states — no jargon, just "this is happening".
          Escalates past a plain spinner once it's run long enough that
          "still normal" starts to look like "actually stuck" — a bare
          indefinite spinner with no signal either way is exactly what
          produced the "did this hang?" confusion. */}
      {IN_FLIGHT_STATUSES.has(order.status) && (
        <div className="mt-5 flex flex-col gap-2.5 rounded-lg border border-border bg-accent-soft px-4 py-3 text-sm text-accent-text">
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
                This is taking longer than usual ({inFlightElapsedSeconds}s) — it can still complete normally, but if it
                doesn't resolve soon, that's worth flagging rather than waiting indefinitely.
              </span>
              <Button size="sm" variant="secondary" onClick={load}>
                Check again
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Buyer: fund order */}
      {isBuyer && (order.status === "pending_payment" || order.status === "payment_failed") && (
        <div className="mt-5">
          {order.status === "payment_failed" && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-xs text-danger-text">
              <AlertTriangle size={14} /> Your last payment attempt didn't go through. You can try again.
            </div>
          )}
          <Button fullWidth loading={acting} onClick={() => runAction("/fund", undefined, "Payment started.")}>
            Fund order — {formatMoney(order.amount_minor, "NGN")}
          </Button>
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
        </div>
      )}
      {isSupplier && order.status !== "funded" && order.status !== "fulfilling" && order.status !== "pending_payment" && !proof && (
        <div className="mt-5 text-sm text-text-secondary">Waiting on the buyer to fund this order before you can begin.</div>
      )}

      {/* Buyer: waiting on fulfillment — with an out if something's
          already wrong before any proof has even been submitted (design
          doc's "rare, allowed" funded/fulfilling -> disputed edge). */}
      {isBuyer && (order.status === "funded" || order.status === "fulfilling") && (
        <div className="mt-5">
          <div className="rounded-xl border border-border bg-surface-sunken p-4 text-sm text-text-secondary">
            {order.status === "fulfilling" ? "Your supplier is preparing this order." : "Waiting on your supplier to begin fulfilling this order."}
          </div>
          {!showEarlyIssueForm ? (
            <button type="button" onClick={() => setShowEarlyIssueForm(true)} className="mt-3 text-xs font-semibold text-danger-text underline">
              Something's already wrong — report it now
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
                      "Reported — this order is now under review."
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
        </div>
      )}

      {/* Live verification call — both buyer and supplier can join the
          same room to walk through the delivery together in real time
          before the buyer decides whether to approve. Not embedded by
          default (costs bandwidth/load time — metered mobile data is a
          real constraint here), only once someone actually asks for it. */}
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
                ? `✓ ${Math.floor(verificationCallSeconds / 60)}:${(verificationCallSeconds % 60).toString().padStart(2, "0")} verified — requirement met`
                : `${Math.floor(verificationCallSeconds / 60)}:${(verificationCallSeconds % 60).toString().padStart(2, "0")} / 5:00 verified`}
            </span>
          </div>
          {showCall && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                  Live call — share this order with your {isBuyer ? "supplier" : "buyer"} to meet here
                </span>
                <button type="button" onClick={() => setShowCall(false)} className="text-xs font-semibold text-text-secondary underline hover:text-text-primary">
                  Hide
                </button>
              </div>
              {order.verification_call_room_id ? (
                <JitsiMeetRoom
                  roomId={order.verification_call_room_id}
                  displayLabel={order.order_code}
                  onSegmentComplete={reportCallSegment}
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

      {/* Buyer: accept delivery — the only action here now (Reject was
          removed per explicit product direction; a buyer with a problem
          uses "Something's already wrong" above or a post-settlement
          report instead of a separate reject-with-reason flow). Suspended
          until the verification call requirement clears, and still two
          steps once it does — releasing funds is irreversible once the
          transfer confirms, so a single click isn't enough. (The confirm
          step is a review/confirmation step, not a new authentication
          factor — the actual authorization boundary is still the existing
          session check on the /approve route itself, same as every other
          action here; the call requirement itself IS enforced server-side,
          see lib/orderService.ts's approveOrder.) */}
      {isBuyer && order.status === "proof_submitted" && (
        <div className="mt-5">
          {!callRequirementMet && !showApproveConfirm && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2.5 text-xs text-warning-text">
              <Video size={14} className="mt-0.5 shrink-0" />
              <span>
                Accepting delivery is suspended until you complete a live verification call of at least 5 minutes with your
                supplier —{" "}
                <strong>
                  {Math.floor(verificationCallSeconds / 60)}:{(verificationCallSeconds % 60).toString().padStart(2, "0")} / 5:00
                </strong>{" "}
                so far.
              </span>
            </div>
          )}
          {showApproveConfirm ? (
            <div className="flex flex-col gap-3 rounded-xl border border-accent bg-accent-soft p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Confirm release</div>
              <p className="text-sm leading-relaxed text-text-primary">
                You're about to release <strong>{formatMoney(order.amount_minor, "NGN")}</strong> to{" "}
                <strong>{order.supplier_business_name || "this supplier"}</strong>. This can't be undone once the transfer
                confirms — only continue if you've reviewed the delivery proof above and you're satisfied.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  loading={acting}
                  onClick={() => runAction("/approve", undefined, "Order accepted — releasing funds to your supplier.")}
                >
                  <CheckCircle2 size={15} /> Yes, release {formatMoney(order.amount_minor, "NGN")}
                </Button>
                <Button variant="ghost" disabled={acting} onClick={() => setShowApproveConfirm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <span title={callRequirementMet ? undefined : "Complete the 5-minute verification call above first."}>
              <Button fullWidth disabled={!callRequirementMet} onClick={() => setShowApproveConfirm(true)}>
                <CheckCircle2 size={15} /> Accept delivery
              </Button>
            </span>
          )}
        </div>
      )}

      {/* Dispute status, visible to whoever's involved */}
      {activeDispute && (
        <div className="mt-5 rounded-xl border border-danger bg-danger-soft p-4">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-danger-text">
            <Clock size={13} /> {activeDispute.dispute_type === "post_settlement_report" ? "Issue reported — under review" : "Under dispute review"}
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
            <CheckCircle2 size={15} /> Order complete — supplier has been paid.
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
              You rated this supplier {rating.score}/5{rating.comment ? ` — "${rating.comment}"` : ""}.
              {!rating.on_chain_confirmed_at && (
                <span className="mt-1 block text-xs text-text-tertiary">Recorded — awaiting on-chain confirmation.</span>
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
                    Report an issue — this order stays complete; an admin reviews separately.
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
    </Modal>
  );
}
