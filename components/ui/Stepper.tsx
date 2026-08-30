// components/ui/Stepper.tsx
//
// A vertical numbered stepper for a linear, GATED process — each step's
// content only makes sense once the previous one is actually done, e.g.
// OrderDetailsModal.tsx's delivery verification (live call -> confirm
// order code -> accept delivery). Distinct from TransactionProgress.tsx,
// which is a horizontal three-state indicator (submitted/processing/
// confirmed) for a single payment leg's own status, not a multi-step
// flow where each step carries real, different, actionable content.
//
// The gating itself is never this component's job: it only renders
// whatever `status` and `content` each caller-computed step already
// decided, same "server/caller owns the real rule, this just displays
// it" split every other ui/ primitive in this app follows.
import React from "react";
import { Check } from "lucide-react";
import { cn } from "./cn";

export interface StepperStep {
  key: string;
  title: string;
  status: "complete" | "current" | "upcoming";
  /** Shown under the title regardless of status, e.g. "5:12 / 5:00 verified". */
  summary?: React.ReactNode;
  /** Only rendered once the step is complete or current — an upcoming
   * step is a locked preview of what's next, not yet actionable. */
  content?: React.ReactNode;
}

export interface StepperProps {
  steps: StepperStep[];
  className?: string;
}

export default function Stepper({ steps, className = "" }: StepperProps) {
  return (
    <ol className={cn("flex flex-col", className)}>
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <li key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold",
                  step.status === "complete" && "border-success bg-success-soft text-success-text",
                  step.status === "current" && "border-accent bg-accent-soft text-accent-text",
                  step.status === "upcoming" && "border-border bg-surface-sunken text-text-tertiary"
                )}
                aria-hidden="true"
              >
                {step.status === "complete" ? <Check size={14} /> : i + 1}
              </span>
              {!isLast && (
                <div
                  className={cn("mt-1 w-[2px] flex-1", step.status === "complete" ? "bg-success" : "bg-border")}
                  aria-hidden="true"
                />
              )}
            </div>
            <div className={cn("min-w-0 flex-1", !isLast && "pb-5")}>
              <div className={cn("text-sm font-semibold", step.status === "upcoming" ? "text-text-tertiary" : "text-text-primary")}>
                {step.title}
              </div>
              {step.summary && <div className="mt-0.5 text-xs text-text-secondary">{step.summary}</div>}
              {step.status !== "upcoming" && step.content && <div className="mt-2.5">{step.content}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
