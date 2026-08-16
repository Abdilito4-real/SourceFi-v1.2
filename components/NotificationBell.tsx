"use client";

// components/NotificationBell.tsx
//
// The in-app notification centre, feedback-layer rule: "Every
// push-worthy event also writes to an in-app notification centre with
// unread state... The system must be correct if push never arrives at
// all." This is that centre's UI: works identically whether or not the
// user ever enabled push, ever granted permission, or has a subscription
// at all, it's reading app/api/notifications, not anything push-specific.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, Briefcase, Wallet, ClipboardCheck, Scale, ShieldAlert, Check } from "lucide-react";
import { cn } from "./ui/cn";
import Button from "./ui/Button";
import SharedEmptyState from "./ui/EmptyState";
import Skeleton from "./ui/Skeleton";
import type { NotificationCategory, NotificationRow } from "../lib/types";

const CATEGORY_ICON: Record<NotificationCategory, React.ElementType> = {
  job_availability: Briefcase,
  escrow_payment: Wallet,
  audit_status: ClipboardCheck,
  disputes: Scale,
  security: ShieldAlert,
};

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      const data = await res.json();
      if (!res.ok) return;
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      /* best-effort, a failed fetch here just leaves the last-known count showing, not an error state worth surfacing */
    }
  }, []);

  // Poll the unread count in the background regardless of whether the
  // panel is open, a badge that's silently stale is worse than a cheap
  // periodic fetch.
  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [open, load]);

  // Close on outside click / Escape, same pattern as Modal, lighter
  // weight since this isn't a full dialog.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markRead = async (id: number) => {
    setNotifications((rows) => rows.map((r) => (r.id === id ? { ...r, read_at: new Date().toISOString() } : r)));
    setUnreadCount((c) => Math.max(0, c - 1));
    await fetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  };

  const markAllRead = async () => {
    setNotifications((rows) => rows.map((r) => (r.read_at ? r : { ...r, read_at: new Date().toISOString() })));
    setUnreadCount(0);
    await fetch("/api/notifications/read-all", { method: "POST" }).catch(() => {});
  };

  const openNotification = (n: NotificationRow) => {
    if (!n.read_at) markRead(n.id);
    setOpen(false);
    if (n.deep_link) router.push(n.deep_link);
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        className="relative rounded-md p-2 text-text-secondary transition-colors duration-base ease-base hover:bg-surface-sunken hover:text-text-primary"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-pill bg-danger px-1 font-mono text-[10px] font-bold text-white"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-[1100] mt-2 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-border bg-surface-elevated shadow-lg sm:w-96"
        >
          <div className="sticky top-0 flex items-center justify-between border-b border-border bg-surface-elevated px-4 py-3">
            <span className="font-display text-sm font-semibold text-text-primary">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" onClick={markAllRead} className="flex items-center gap-1 text-xs font-semibold text-accent-text hover:underline">
                <Check size={12} /> Mark all read
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="p-4">
              <SharedEmptyState icon={Bell} title="No notifications yet" description="Updates on your orders, escrow, and disputes will show up here." />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const Icon = CATEGORY_ICON[n.category] || Bell;
                const unread = !n.read_at;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => openNotification(n)}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-base ease-base hover:bg-surface-sunken",
                        unread && "bg-accent-soft"
                      )}
                    >
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-text-secondary">
                        <Icon size={14} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block text-sm leading-snug", unread ? "font-semibold text-text-primary" : "text-text-secondary")}>
                          {n.title}
                        </span>
                        <span className="mt-0.5 block text-xs text-text-tertiary">{n.body}</span>
                        <span className="mt-1 block text-[10px] uppercase tracking-wide text-text-tertiary">{timeAgo(n.created_at)}</span>
                      </span>
                      {unread && <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-pill bg-accent" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-border px-4 py-2.5 text-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                router.push("/settings/notifications");
              }}
            >
              Notification settings
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
