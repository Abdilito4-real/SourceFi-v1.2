// components/ui/StatCard.tsx
//
// The dashboard-overview equivalent of Badge/StatusBadge, one small
// primitive both BuyerDashboard and SourcerDashboard build their stat rows
// from, instead of each hand-rolling its own card markup.
import React from "react";
import { Card } from "./Card";
import Skeleton from "./Skeleton";
import { cn } from "./cn";

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: string;
  tone?: "default" | "accent";
}

export default function StatCard({ label, value, icon, hint, tone = "default" }: StatCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
          <div
            className={cn(
              "mt-2 font-display text-3xl font-semibold tabular-nums",
              tone === "accent" ? "text-accent-text" : "text-text-primary"
            )}
          >
            {value}
          </div>
          {hint && <div className="mt-1.5 text-xs text-text-secondary">{hint}</div>}
        </div>
        {icon && (
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              tone === "accent" ? "bg-accent-soft text-accent-text" : "bg-surface-sunken text-text-secondary"
            )}
          >
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Loading placeholder matching StatCard's own layout, for the moment a
 * stat row's backing data hasn't arrived yet, e.g. `<StatCardSkeleton />`
 * repeated in place of the real grid of `<StatCard />`s. */
export function StatCardSkeleton() {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
      </div>
    </Card>
  );
}
