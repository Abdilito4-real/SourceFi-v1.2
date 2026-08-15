// components/ui/EmptyState.tsx
import React from "react";
import { Inbox, type LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export default function EmptyState({ icon: Icon = Inbox, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <Icon size={26} className="text-text-tertiary" aria-hidden="true" />
      <div>
        <p className="text-base font-semibold text-text-primary">{title}</p>
        {description && <p className="mx-auto mt-1 max-w-xs text-sm text-text-secondary">{description}</p>}
      </div>
      {action}
    </div>
  );
}
