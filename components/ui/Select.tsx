"use client";

// components/ui/Select.tsx
import React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./cn";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className = "", invalid, children, ...props },
  ref
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          "w-full appearance-none rounded-md border border-border-strong bg-surface-sunken px-3 py-2.5 pr-9 text-base text-text-primary transition-colors duration-base ease-base focus:border-accent disabled:cursor-not-allowed disabled:opacity-60",
          invalid && "border-danger",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        aria-hidden="true"
      />
    </div>
  );
});

export default Select;
