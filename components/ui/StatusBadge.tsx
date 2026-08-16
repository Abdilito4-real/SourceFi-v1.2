// components/ui/StatusBadge.tsx — the order lifecycle badge used
// throughout the product. Single source of truth for status -> tone/label
// so a new status only needs to be added here, not at every call site.
// Buyer-facing language avoids blockchain/payment-provider jargon
// (design doc: "buyer should experience this as a normal NGN marketplace
// payment") — "processing your payment" not "converting NGN to USDC".
import Badge, { ORDER_STATUS_TONE } from "./Badge";
import type { OrderStatus } from "../../lib/types";

const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "Awaiting payment",
  payment_processing: "Processing payment",
  payment_failed: "Payment failed",
  converting: "Processing payment",
  escrow_depositing: "Processing payment",
  funded: "Funded · awaiting fulfillment",
  fulfilling: "Being prepared",
  proof_submitted: "Delivery proof submitted",
  buyer_approved: "Approved · releasing funds",
  release_submitted: "Releasing funds",
  release_processing: "Releasing funds",
  escrow_released: "Funds released",
  settlement_processing: "Paying supplier",
  settled: "Complete",
  rejected: "Proof rejected",
  disputed: "Under dispute review",
  refund_processing: "Refund processing",
  refunded: "Refunded",
  cancelled: "Cancelled",
  expired: "Expired",
};

export default function StatusBadge({ status }: { status: OrderStatus }) {
  const tone = ORDER_STATUS_TONE[status] || "neutral";
  const label = STATUS_LABEL[status] || status;
  return <Badge tone={tone}>{label}</Badge>;
}
