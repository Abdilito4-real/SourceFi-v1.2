"use client";

// components/ui/Toast.tsx
//
// App.js already re-implements this pattern with a single showNotification()
// timeout — this generalizes it to a stack (needed once more than one async
// action can complete at nearly the same time) and adds the aria-live
// region screen readers need to actually announce it.
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CheckCircle2, AlertTriangle, Info, X, type LucideIcon } from "lucide-react";
import { cn } from "./cn";
import type { ToastType } from "../../lib/types";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
}

interface NotifyOptions {
  /** 0 means sticky (no auto-dismiss) — used for things like the "new
   * version available" prompt, where auto-hiding could bury a decision the
   * user needs to make on their own terms, not the timer's. */
  duration?: number;
  action?: ToastAction;
}

interface ToastContextValue {
  notify: (type: ToastType, message: string, options?: NotifyOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Note: these deliberately don't use Tailwind's color/opacity modifier
// syntax (e.g. border-success/40) — our colors resolve through CSS custom
// properties (var(--color-success)), not the raw rgb triples Tailwind
// needs to compute an opacity variant, so that modifier silently no-ops.
const TONE: Record<ToastType, { icon: LucideIcon; classes: string }> = {
  success: { icon: CheckCircle2, classes: "border-success bg-success-soft text-success-text" },
  error: { icon: AlertTriangle, classes: "border-danger bg-danger-soft text-danger-text" },
  info: { icon: Info, classes: "border-border bg-surface-elevated text-text-primary" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (type: ToastType, message: string, { duration = 4000, action }: NotifyOptions = {}) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((t) => [...t, { id, type, message, action }]);
      if (duration) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss]
  );

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-5 z-[1100] flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((toast) => {
          const tone = TONE[toast.type] || TONE.info;
          const Icon = tone.icon;
          return (
            <div
              key={toast.id}
              role="status"
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-4 py-3 text-base shadow-lg",
                tone.classes
              )}
            >
              <Icon size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1 leading-snug">{toast.message}</p>
              {toast.action && (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                  className="shrink-0 font-body text-xs font-bold underline underline-offset-2"
                >
                  {toast.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="shrink-0 opacity-70 hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
