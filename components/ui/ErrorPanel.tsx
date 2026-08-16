// components/ui/ErrorPanel.tsx
//
// Feedback-layer rule: a toast is never the only confirmation of a
// financial event, and that cuts both ways, a financial FAILURE also
// needs persistent on-screen state, not just a toast that can disappear
// while the user is scrolled elsewhere. This is that persistent element:
// what happened, why, the fund position stated explicitly, an optional
// reference code, and a Retry that's the same action (so it's safe to
// press again rather than a different code path).
import React from "react";
import { AlertOctagon, RotateCcw } from "lucide-react";
import Button from "./Button";
import { cn } from "./cn";

export interface ErrorPanelProps {
  /** What happened, plain language, no "Error 500". */
  title: string;
  /** Why, and/or what to do next. Optional, title alone can be enough. */
  detail?: React.ReactNode;
  /** Always state the fund position explicitly: "No money has left your
   * account." / "Your funds are still held in escrow." Users assume the
   * worst otherwise. */
  fundPosition: string;
  /** Short code the user can quote to support, never a stack trace or
   * provider error code (see lib/errorReference.ts). */
  referenceCode?: string;
  onRetry?: () => void;
  retrying?: boolean;
  onDismiss: () => void;
  className?: string;
}

export default function ErrorPanel({
  title,
  detail,
  fundPosition,
  referenceCode,
  onRetry,
  retrying = false,
  onDismiss,
  className = "",
}: ErrorPanelProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-danger bg-danger-soft p-4 text-sm text-danger-text",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <AlertOctagon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="flex-1">
          <p className="font-semibold leading-snug">{title}</p>
          {detail && <p className="mt-1 leading-relaxed text-danger-text">{detail}</p>}
          <p className="mt-2 font-semibold leading-relaxed">{fundPosition}</p>
          {referenceCode && (
            <p className="mt-1 font-mono text-xs text-danger-text">Reference: {referenceCode}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onRetry && (
          <Button variant="danger" size="sm" loading={retrying} onClick={onRetry}>
            <RotateCcw size={13} /> Try again
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={retrying} onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
