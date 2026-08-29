// components/ui/Tabs.tsx
//
// Shared segmented-control tab strip. Replaces the pill-tab markup that
// used to be copy-pasted independently in BuyerDashboard (Active/History),
// SupplierDashboard (orders Active/History), and AdminDashboard
// (verification status, dispute status) — one place to fix the look
// instead of four drifting copies.
import React from "react";
import { cn } from "./cn";

export interface TabItem {
  key: string;
  label: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export default function Tabs({ items, active, onChange, className = "" }: TabsProps) {
  return (
    // Horizontal scroll, not wrap: a long item set (Admin's 5 dispute
    // statuses, "resolved_supplier" et al) would otherwise overflow a
    // narrow phone screen's width, since this is a non-wrapping pill
    // strip by design (wrapping it would break the pill look). The outer
    // div carries the caller's own spacing (e.g. mb-5); the inner one
    // carries the actual pill chrome, so a scrolled strip doesn't clip
    // its own border/background.
    <div className={cn("overflow-x-auto", className)}>
      <div className="inline-flex w-fit rounded-lg border border-border bg-surface p-1" role="tablist">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active === item.key}
            onClick={() => onChange(item.key)}
            className={cn(
              "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold capitalize transition-colors duration-base ease-base",
              active === item.key ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
