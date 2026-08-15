// components/RequestCard.tsx
//
// Shared between BuyerDashboard and SourcerDashboard's request/job lists —
// used to be a local function inside the old single-page App.tsx.
import React from "react";
import { ChevronRight } from "lucide-react";
import StatusBadge from "./ui/StatusBadge";
import { formatMoney } from "../lib/money";
import type { SourcingRequest } from "../lib/types";

export default function RequestCard({ request, onOpen }: { request: SourcingRequest; onOpen: (r: SourcingRequest) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(request)}
      className="flex w-full flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-4 text-left transition-[transform,box-shadow,border-color] duration-base ease-base hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 font-mono text-xs tracking-wide text-accent-text">
            {request.id} · {request.category || "General"}
          </div>
          <div className="truncate font-display text-lg font-semibold leading-tight text-text-primary">{request.title}</div>
        </div>
        <ChevronRight size={16} className="mt-1 shrink-0 text-text-tertiary" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge status={request.status} />
        <span className="text-sm font-semibold text-text-secondary">
          {request.sourcingFeeMinor > 0 ? formatMoney(request.sourcingFeeMinor) : formatMoney(request.budgetMinor, request.budgetCurrency)}
        </span>
      </div>
    </button>
  );
}
