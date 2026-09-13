// components/ui/SectionHeader.tsx
//
// The "<h2>Section title</h2> ... optional View all" row every dashboard
// (Buyer/Supplier/Admin) used to hand-roll separately, spacing and
// typography drifting slightly between the copies. One place to keep
// hierarchy consistent instead of three near-identical inline blocks.
import React from "react";
import { cn } from "./cn";

export interface SectionHeaderProps {
  title: React.ReactNode;
  /** Small pill count next to the title, e.g. a list length. */
  count?: number;
  /** Renders full-width below the title row, for a one-line explainer. */
  subtitle?: React.ReactNode;
  /** Right-aligned control, typically a "View all" link/button. */
  action?: React.ReactNode;
  /** "sm" for a nested subsection heading (e.g. inside the Ledger tab). */
  size?: "default" | "sm";
  className?: string;
}

export default function SectionHeader({ title, count, subtitle, action, size = "default", className = "" }: SectionHeaderProps) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1", className)}>
      <div className="flex items-center gap-2">
        <h2 className={cn("font-display italic text-text-primary", size === "sm" ? "text-lg" : "text-xl")}>{title}</h2>
        {typeof count === "number" && (
          <span className="rounded-pill bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-text-tertiary">{count}</span>
        )}
      </div>
      {action}
      {subtitle && <p className="basis-full text-sm text-text-secondary">{subtitle}</p>}
    </div>
  );
}
