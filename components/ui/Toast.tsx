"use client";

// components/ui/Toast.tsx
//
// App.js already re-implements this pattern with a single showNotification()
// timeout, this generalizes it to a stack (needed once more than one async
// action can complete at nearly the same time) and adds the aria-live
// region screen readers need to actually announce it.
//
// Feedback-layer rules this file enforces centrally (see
// docs/feedback-notifications-prompts.md Prompt 1), so every call site
// across the app gets them for free without having to opt in:
//   - error and warning toasts NEVER auto-dismiss, regardless of what
//     duration a caller passes, the user dismisses them.
//   - firing the same (type, message) again while it's still showing bumps
//     a count instead of stacking a duplicate.
//   - errors are role="alert" (implicitly assertive); everything else is
//     role="status" inside the aria-live="polite" container.
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, AlertOctagon, Info, Loader2, X, type LucideIcon } from "lucide-react";
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
  count: number;
}

interface NotifyOptions {
  /** 0 means sticky (no auto-dismiss). Ignored for type "error" and
   * "warning", those are always sticky no matter what's passed, per the
   * feedback-layer rule that the user dismisses errors, not a timer. */
  duration?: number;
  action?: ToastAction;
  /** Overrides the default `${type}:${message}` dedupe key. Use when two
   * calls should collapse into one toast even though their exact text
   * differs (e.g. "Failed to load order #482" and "Failed to load order
   * #119" firing back to back), the default exact-string key deliberately
   * does NOT do this on its own, to avoid collapsing genuinely different
   * errors that happen to share a type. */
  dedupeKey?: string;
}

interface ToastContextValue {
  notify: (type: ToastType, message: string, options?: NotifyOptions) => string;
  /** Turns an existing toast (e.g. a sticky "loading" one) into a new
   * type/message in place, instead of dismissing one and stacking another
   * the natural fit for narrating submitted -> processing -> confirmed
   * without spamming three separate toasts. */
  update: (id: string, type: ToastType, message: string, options?: NotifyOptions) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Types that must never auto-dismiss regardless of the caller's duration.
const ALWAYS_STICKY: ToastType[] = ["error", "warning"];
// "loading" defaults to sticky too (0) unless the caller explicitly opts
// into a duration, it's meant to be transitioned via update()/dismiss()
// not to disappear on its own mid-operation.
const DEFAULT_STICKY_TYPES: ToastType[] = ["loading"];

// Note: these deliberately don't use Tailwind's color/opacity modifier
// syntax (e.g. border-success/40), our colors resolve through CSS custom
// properties (var(--color-success)), not the raw rgb triples Tailwind
// needs to compute an opacity variant, so that modifier silently no-ops.
const TONE: Record<ToastType, { icon: LucideIcon; classes: string; spin?: boolean }> = {
  success: { icon: CheckCircle2, classes: "border-success bg-success-soft text-success-text" },
  error: { icon: AlertOctagon, classes: "border-danger bg-danger-soft text-danger-text" },
  warning: { icon: AlertTriangle, classes: "border-warning bg-warning-soft text-warning-text" },
  info: { icon: Info, classes: "border-border bg-surface-elevated text-text-primary" },
  loading: { icon: Loader2, classes: "border-border bg-surface-elevated text-text-primary", spin: true },
};

function defaultDedupeKey(type: ToastType, message: string) {
  return `${type}:${message}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // id -> dedupe key, and dedupe key -> id, so a repeat fire can find and
  // bump the existing toast instead of pushing a duplicate.
  const keyToId = useRef(new Map<string, string>());
  const idToKey = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    clearTimer(id);
    const key = idToKey.current.get(id);
    if (key) {
      keyToId.current.delete(key);
      idToKey.current.delete(id);
    }
    setToasts((t) => t.filter((toast) => toast.id !== id));
  }, [clearTimer]);

  const armTimer = useCallback(
    (id: string, type: ToastType, duration: number | undefined) => {
      clearTimer(id);
      const sticky = ALWAYS_STICKY.includes(type) || (duration === 0);
      const effectiveDuration = duration ?? (DEFAULT_STICKY_TYPES.includes(type) ? 0 : 4000);
      if (sticky || effectiveDuration === 0) return;
      timers.current.set(id, setTimeout(() => dismiss(id), effectiveDuration));
    },
    [clearTimer, dismiss]
  );

  const notify = useCallback(
    (type: ToastType, message: string, { duration, action, dedupeKey }: NotifyOptions = {}) => {
      const key = dedupeKey ?? defaultDedupeKey(type, message);
      const existingId = keyToId.current.get(key);
      if (existingId) {
        // Already showing, bump the count and restart its timer rather
        // than stacking a visual duplicate ("the same error fired five
        // times shows once with a count").
        setToasts((t) => t.map((toast) => (toast.id === existingId ? { ...toast, count: toast.count + 1 } : toast)));
        armTimer(existingId, type, duration);
        return existingId;
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      keyToId.current.set(key, id);
      idToKey.current.set(id, key);
      setToasts((t) => [...t, { id, type, message, action, count: 1 }]);
      armTimer(id, type, duration);
      return id;
    },
    [armTimer]
  );

  const update = useCallback(
    (id: string, type: ToastType, message: string, { duration, action, dedupeKey }: NotifyOptions = {}) => {
      const oldKey = idToKey.current.get(id);
      if (oldKey) keyToId.current.delete(oldKey);
      const newKey = dedupeKey ?? defaultDedupeKey(type, message);
      keyToId.current.set(newKey, id);
      idToKey.current.set(id, newKey);
      setToasts((t) => t.map((toast) => (toast.id === id ? { ...toast, type, message, action, count: 1 } : toast)));
      armTimer(id, type, duration);
    },
    [armTimer]
  );

  const value = useMemo(() => ({ notify, update, dismiss }), [notify, update, dismiss]);

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
          const isAlert = toast.type === "error" || toast.type === "warning";
          return (
            <div
              key={toast.id}
              role={isAlert ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border px-4 py-3 text-base shadow-lg",
                tone.classes
              )}
            >
              <Icon size={16} className={cn("mt-0.5 shrink-0", tone.spin && "spin-icon")} aria-hidden="true" />
              <p className="flex-1 leading-snug">
                {toast.message}
                {toast.count > 1 && (
                  <span className="ml-1.5 rounded-pill bg-black/10 px-1.5 py-0.5 font-mono text-[10px] font-bold">
                    ×{toast.count}
                  </span>
                )}
              </p>
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
              {toast.type !== "loading" && (
                <button
                  type="button"
                  onClick={() => dismiss(toast.id)}
                  aria-label="Dismiss notification"
                  className="shrink-0 opacity-70 hover:opacity-100"
                >
                  <X size={14} />
                </button>
              )}
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
