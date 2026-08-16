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
import { CheckCircle2, XCircle, Loader2, Clock, Star, AlertTriangle, Image as ImageIcon, Receipt } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import StatusBadge from "./ui/StatusBadge";
import { Label, Input, Textarea } from "./ui/Field";
import Select from "./ui/Select";
import Skeleton from "./ui/Skeleton";
import { formatMoney } from "../lib/money";
import type { DeliveryProofRow, DisputeCategory, DisputeRow, OrderRow, PaymentEventRow, RatingRow, Role } from "../lib/types";

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
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectCategory, setRejectCategory] = useState<DisputeCategory>("item_not_as_described");
  const [rejectDescription, setRejectDescription] = useState("");
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

      {/* In-flight processing states — no jargon, just "this is happening" */}
      {IN_FLIGHT_STATUSES.has(order.status) && (
        <div className="mt-5 flex items-center gap-2.5 rounded-lg border border-border bg-accent-soft px-4 py-3 text-sm text-accent-text">
          <Loader2 size={15} className="spin-icon shrink-0" />
          {order.status === "payment_processing" || order.status === "converting" || order.status === "escrow_depositing"
            ? "Processing your payment. This usually takes a few moments."
            : order.status === "refund_processing"
            ? "Processing your refund."
            : "Processing the payment to your supplier."}
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

      {/* Buyer: approve or reject */}
      {isBuyer && order.status === "proof_submitted" && (
        <div className="mt-5">
          {!showRejectForm ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button fullWidth loading={acting} onClick={() => runAction("/approve", undefined, "Order approved — releasing funds to your supplier.")}>
                <CheckCircle2 size={15} /> Approve delivery
              </Button>
              <Button fullWidth variant="secondary" disabled={acting} onClick={() => setShowRejectForm(true)}>
                <XCircle size={15} /> Reject delivery
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-danger bg-danger-soft p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-danger-text">Reject delivery proof</div>
              <div>
                <Label htmlFor="reject-category">Reason</Label>
                <Select id="reject-category" value={rejectCategory} onChange={(e) => setRejectCategory(e.target.value as DisputeCategory)}>
                  {DISPUTE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="reject-description">Details</Label>
                <Textarea id="reject-description" value={rejectDescription} onChange={(e) => setRejectDescription(e.target.value)} required />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  loading={acting}
                  disabled={!rejectDescription.trim()}
                  onClick={() =>
                    runAction("/reject", { category: rejectCategory, description: rejectDescription }, "Delivery rejected — this order is now under review.")
                  }
                >
                  Confirm rejection
                </Button>
                <Button variant="ghost" disabled={acting} onClick={() => setShowRejectForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
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
