// components/ui/Badge.tsx
import React from "react";
import { cn } from "./cn";
import type { RequestStatus } from "../../lib/types";

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

// Maps the sourcing-request lifecycle used throughout the app to a tone.
// This is the one place that mapping is defined — components import
// STATUS_TONE rather than re-deciding per status what color means what.
export const STATUS_TONE: Record<RequestStatus, BadgeTone> = {
  open: "accent",
  claimed: "accent",
  escrow: "warning",
  verified: "success",
  escrow_released: "success",
  disputed: "danger",
  cancelled: "neutral",
  expired: "neutral",
};
