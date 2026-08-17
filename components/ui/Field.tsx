"use client";

// components/ui/Field.tsx, label, input, textarea, and error/helper text as
// a matched set, since they're never used independently in this product.
import React from "react";
import { cn } from "./cn";

export interface LabelProps {
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}

export function Label({ children, htmlFor, className = "" }: LabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        "mb-1.5 block font-mono text-xs font-semibold uppercase tracking-wide text-accent-text",
        className
      )}
    >
      {children}
    </label>
  );
}

export function HelperText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-xs text-text-tertiary">{children}</p>;
}

export function ErrorText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger-text">
      {children}
    </p>
  );
}

const fieldBase =
  "w-full rounded-md border border-border-strong bg-surface-sunken px-3 py-2.5 text-base text-text-primary placeholder:text-text-tertiary transition-colors duration-base ease-base focus:border-accent disabled:cursor-not-allowed disabled:opacity-60";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** A short, fixed, non-editable prefix rendered inside the field, e.g.
   * "₦" on an amount input, so the currency is shown, never typed. */
  prefix?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = "", invalid, prefix, ...props },
  ref
) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, prefix && "pl-7", invalid && "border-danger", className)}
      {...props}
    />
  );
  if (!prefix) return input;
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
        {prefix}
      </span>
      {input}
    </div>
  );
});

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className = "", invalid, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldBase, "min-h-[88px] resize-y", invalid && "border-danger", className)}
      {...props}
    />
  );
});
