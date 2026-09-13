// components/ui/Table.tsx
//
// Wrapped in its own horizontal scroll container, the page must never
// scroll sideways just because a table is wide (sourcer screens start at
// 360px; the order/shipment tables in the mockups are not going to fit
// there without scrolling internally).
import React from "react";
import { cn } from "./cn";

export function Table({ className = "", children, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-border">
      <table className={cn("w-full min-w-[560px] border-collapse text-base", className)} {...props}>
        {children}
      </table>
    </div>
  );
}

export function Thead({ className = "", ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-border bg-surface-sunken", className)} {...props} />;
}

export function Tbody({ className = "", ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border", className)} {...props} />;
}

export function Tr({ className = "", ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors duration-base ease-base hover:bg-surface-sunken", className)} {...props} />;
}

export function Th({ className = "", ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap px-4 py-3 text-left font-mono text-xs font-semibold uppercase tracking-wide text-text-tertiary",
        className
      )}
      {...props}
    />
  );
}

export function Td({ className = "", ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("whitespace-nowrap px-4 py-3.5 text-text-primary", className)} {...props} />;
}
