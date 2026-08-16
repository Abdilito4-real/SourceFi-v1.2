// components/ui/StatCard.tsx
//
// The dashboard-overview equivalent of Badge/StatusBadge, one small
// primitive both BuyerDashboard and SourcerDashboard build their stat rows
// from, instead of each hand-rolling its own card markup.
import React from "react";
import { Card } from "./Card";
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{label}</div>
          <div className={cn("mt-2 font-display text-3xl font-semibold", tone === "accent" ? "text-accent-text" : "text-text-primary")}>
            {value}
          </div>
          {hint && <div className="mt-1.5 text-xs text-text-secondary">{hint}</div>}
        </div>
        {icon && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}
