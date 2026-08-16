// components/ui/TransactionProgress.tsx
//
// Feedback-layer rule: "Distinguish three states clearly and visually:
// submitted / processing / confirmed. Especially for escrow funding."
// Deliberately not color-only, each step carries an icon and a text
// label, so it reads the same for a screen reader or a colorblind user as
// it does at a glance (see prompt's accessibility section: "every state
// distinguishable without colour alone").
import React from "react";
import { CheckCircle2, Circle, Loader2, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "./cn";

export type TransactionStep = "submitted" | "processing" | "confirmed";

const STEPS: { key: TransactionStep; label: string }[] = [
  { key: "submitted", label: "Submitted" },
  { key: "processing", label: "Processing" },
  { key: "confirmed", label: "Confirmed" },
];

const ORDER: Record<TransactionStep, number> = { submitted: 0, processing: 1, confirmed: 2 };

export interface TransactionProgressProps {
  state: TransactionStep;
  /** True if the leg failed while in this state, renders the current step
   * as failed instead of active, and stops the line short. */
  failed?: boolean;
  /** Overrides the default three labels, e.g. "Payment sent" / "Converting
   * &amp; depositing" / "In escrow" for the funding leg specifically. */
  labels?: Partial<Record<TransactionStep, string>>;
  className?: string;
}

export default function TransactionProgress({ state, failed = false, labels, className = "" }: TransactionProgressProps) {
  const currentIndex = ORDER[state];

  return (
    <div className={cn("flex items-center", className)} role="status" aria-label={`Payment status: ${state}${failed ? ", failed" : ""}`}>
      {STEPS.map((step, i) => {
        const label = labels?.[step.key] ?? step.label;
        const isDone = i < currentIndex || (i === currentIndex && state === "confirmed" && !failed);
        const isCurrent = i === currentIndex && !isDone;
        const isFailedHere = isCurrent && failed;

        let Icon: LucideIcon = Circle;
        let iconClasses = "text-text-tertiary";
        let labelClasses = "text-text-tertiary";
        if (isDone) {
          Icon = CheckCircle2;
          iconClasses = "text-success-text";
          labelClasses = "text-text-primary font-semibold";
        } else if (isFailedHere) {
          Icon = XCircle;
          iconClasses = "text-danger-text";
          labelClasses = "text-danger-text font-semibold";
        } else if (isCurrent) {
          Icon = Loader2;
          iconClasses = "text-accent-text spin-icon";
          labelClasses = "text-text-primary font-semibold";
        }

        return (
          <React.Fragment key={step.key}>
            <div className="flex flex-col items-center gap-1.5">
              <Icon size={16} className={iconClasses} aria-hidden="true" />
              <span className={cn("whitespace-nowrap text-[11px]", labelClasses)}>{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "mx-1.5 mb-4 h-[1.5px] flex-1",
                  i < currentIndex && !failed ? "bg-success" : "bg-border"
                )}
                aria-hidden="true"
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
