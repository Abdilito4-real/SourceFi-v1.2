// components/OrderCard.tsx
//
// Shared between BuyerDashboard and SupplierDashboard's order lists
// supersedes RequestCard.tsx (sourcing_requests -> orders).
import React from "react";
import { ChevronRight } from "lucide-react";
import StatusBadge from "./ui/StatusBadge";
import { ORDER_STATUS_TONE, type BadgeTone } from "./ui/Badge";
import { formatMoney } from "../lib/money";
import type { OrderRow } from "../lib/types";

// Left status-accent bar so an order list is scannable at a glance
// without reading every badge, same status->tone mapping StatusBadge
// itself uses (ORDER_STATUS_TONE, the single source of truth in
// Badge.tsx), just rendered as a border instead of a pill fill.
const TONE_ACCENT_BORDER: Record<BadgeTone, string> = {
  neutral: "border-l-border-strong",
  accent: "border-l-accent",
  success: "border-l-success",
  warning: "border-l-warning",
  danger: "border-l-danger",
};

export default function OrderCard({ order, onOpen }: { order: OrderRow; onOpen: (o: OrderRow) => void }) {
  const accentBorder = TONE_ACCENT_BORDER[ORDER_STATUS_TONE[order.status]] ?? TONE_ACCENT_BORDER.neutral;
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      // Explicit longhand list, border-left-color deliberately excluded:
      // it's theme/status-driven (the accent bar), not hover-driven, and
      // transitioning a var()-only color change (no class swap) is a
      // known browser bug — the interpolation can get stuck showing the
      // pre-toggle color until something else forces a reflow. Confirmed
      // live: toggling the real theme switch left this bar stuck gold in
      // dark mode until a forced reflow, whereas a class-swap (like this
      // border-left's own tone-vs-tone below) is unaffected since that's
      // a full rule change, not a live variable mutation under a held
      // transition.
      className={`flex w-full flex-col gap-3 rounded-xl border border-l-4 border-border bg-surface px-5 py-4 text-left transition-[transform,box-shadow,border-top-color,border-right-color,border-bottom-color] duration-base ease-base hover:-translate-y-0.5 hover:border-t-border-strong hover:border-r-border-strong hover:border-b-border-strong hover:shadow-md ${accentBorder}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 font-mono text-xs tracking-wide text-accent-text">
            {order.order_code} · {order.supplier_business_name || "Supplier"}
          </div>
          <div className="truncate font-display text-lg font-semibold leading-tight text-text-primary">{order.title}</div>
        </div>
        <ChevronRight size={16} className="mt-1 shrink-0 text-text-tertiary" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge status={order.status} />
        <span className="text-sm font-semibold text-text-secondary">{formatMoney(order.amount_minor, "NGN")}</span>
      </div>
    </button>
  );
}
