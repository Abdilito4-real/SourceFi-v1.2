// components/ui/Badge.tsx
import React from "react";
import { cn } from "./cn";
import type { OrderStatus } from "../../lib/types";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-text-secondary",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success-soft text-success-text",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export default function Badge({ tone = "neutral", className = "", children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide",
        TONES[tone],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

// Maps the order lifecycle (lib/orderStateMachine.ts) to a tone. This is
// the one place that mapping is defined — components import
// ORDER_STATUS_TONE rather than re-deciding per status what color means
// what.
export const ORDER_STATUS_TONE: Record<OrderStatus, BadgeTone> = {
  pending_payment: "neutral",
  payment_processing: "warning",
  payment_failed: "danger",
  converting: "warning",
  escrow_depositing: "warning",
  funded: "accent",
  fulfilling: "accent",
  proof_submitted: "accent",
  buyer_approved: "warning",
  release_submitted: "warning",
  release_processing: "warning",
  escrow_released: "success",
  settlement_processing: "warning",
  settled: "success",
  rejected: "danger",
  disputed: "danger",
  refund_processing: "warning",
  refunded: "neutral",
  cancelled: "neutral",
  expired: "neutral",
};
