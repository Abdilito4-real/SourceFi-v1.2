"use client";

// components/ui/Modal.tsx
//
// Deliberately dependency-free (no headlessui/radix) to keep the bundle
// small. Covers the essentials: focus moves in on open, Escape and
// backdrop click close it, focus returns to whatever opened it, and a
// basic Tab loop keeps focus inside while open.
import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export default function Modal({ open, onClose, title, children, className = "", size = "md" }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusable = panel ? panel.querySelectorAll<HTMLElement>(FOCUSABLE) : ([] as unknown as NodeListOf<HTMLElement>);
    (focusable[0] || panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" };

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-5"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "modal-title" : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "modal-content w-full rounded-xl border border-border bg-surface-elevated p-6 shadow-lg",
          sizes[size],
          className
        )}
      >
        {title && (
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id="modal-title" className="font-display text-xl font-semibold text-text-primary">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded-md p-1 text-text-tertiary transition-colors duration-base ease-base hover:text-text-primary"
            >
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
