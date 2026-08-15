// components/ui/StatusBadge.tsx — the sourcing-request lifecycle badge used
// throughout the product. Single source of truth for status → tone/label
// so a new status only needs to be added here, not at every call site.
import Badge, { STATUS_TONE } from "./Badge";
import type { RequestStatus } from "../../lib/types";

const STATUS_LABEL: Record<RequestStatus, string> = {
  open: "Open · awaiting sourcing partner",
  claimed: "Partner assigned",
  escrow: "Funds in escrow",
  verified: "Verified",
  escrow_released: "Escrow released",
  disputed: "Disputed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export default function StatusBadge({ status }: { status: RequestStatus }) {
  const tone = STATUS_TONE[status] || "neutral";
  const label = STATUS_LABEL[status] || status;
  return <Badge tone={tone}>{label}</Badge>;
}
