// components/OrderCard.tsx
//
// Shared between BuyerDashboard and SupplierDashboard's order lists —
// supersedes RequestCard.tsx (sourcing_requests -> orders).
import React from "react";
import { ChevronRight } from "lucide-react";
import StatusBadge from "./ui/StatusBadge";
import { formatMoney } from "../lib/money";
import type { OrderRow } from "../lib/types";

export default function OrderCard({ order, onOpen }: { order: OrderRow; onOpen: (o: OrderRow) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      className="flex w-full flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-4 text-left transition-[transform,box-shadow,border-color] duration-base ease-base hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
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
