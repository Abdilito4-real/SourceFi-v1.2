"use client";

// components/NotificationPreferencesPanel.tsx
//
// "Separate, independently toggleable channels... Security alerts are not
// opt-out. Give a preferences screen and honour it server-side, not just
// in the client." The honouring happens in lib/notifications/dispatch.ts
// (reads these same rows before every push); this is just the UI over
// app/api/notification-preferences.
import React, { useEffect, useState } from "react";
import { Briefcase, Wallet, ClipboardCheck, Scale, ShieldAlert, BellOff, BellRing } from "lucide-react";
import Button from "./ui/Button";
import Skeleton from "./ui/Skeleton";
import { useToast } from "./ui/Toast";
import { cn } from "./ui/cn";
import { getPermissionState, enablePush, disablePush, getExistingSubscription, PushSetupError } from "../lib/pushClient";
import type { NotificationPreferences } from "../lib/types";

const CHANNELS: { key: keyof Pick<NotificationPreferences, "job_availability" | "escrow_payment" | "audit_status" | "disputes">; label: string; description: string; icon: React.ElementType }[] = [
  { key: "job_availability", label: "New orders", description: "When a buyer places a new order with you.", icon: Briefcase },
  { key: "escrow_payment", label: "Escrow & payments", description: "Funding confirmed, funds released, refunds.", icon: Wallet },
  { key: "audit_status", label: "Delivery & approval", description: "Proof submitted, delivery approved.", icon: ClipboardCheck },
  { key: "disputes", label: "Disputes", description: "A dispute is opened or resolved on your order.", icon: Scale },
];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-pill transition-colors duration-base ease-base",
        checked ? "bg-accent" : "bg-surface-sunken border border-border-strong"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-pill bg-white shadow-sm transition-transform duration-base ease-base",
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => h);

function formatHour(h: number): string {
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:00 ${period}`;
}

export default function NotificationPreferencesPanel() {
  const { notify } = useToast();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const permission = getPermissionState();

  useEffect(() => {
    fetch("/api/notification-preferences")
      .then((r) => r.json())
      .then((data) => setPrefs(data.preferences))
      .catch(() => notify("error", "Failed to load notification preferences."))
      .finally(() => setLoading(false));

    getExistingSubscription().then((sub) => setSubscribed(Boolean(sub)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<Record<string, unknown>>) => {
    if (!prefs) return;
    setSaving(true);
    try {
      const res = await fetch("/api/notification-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save.");
      setPrefs(data.preferences);
      notify("success", "Saved.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to save preferences.");
    } finally {
      setSaving(false);
    }
  };

  const handleTogglePush = async () => {
    setPushBusy(true);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
        notify("info", "Notifications turned off on this device.");
      } else {
        await enablePush();
        setSubscribed(true);
        notify("success", "Notifications turned on.");
      }
    } catch (err) {
      notify("error", err instanceof PushSetupError ? err.message : "Couldn't update notification settings.");
    } finally {
      setPushBusy(false);
    }
  };

  if (loading || !prefs) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Device-level push on/off, separate from the category toggles
          below (this device vs. which categories once it does). */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface-sunken p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text">
            {subscribed ? <BellRing size={16} /> : <BellOff size={16} />}
          </span>
          <div>
            <p className="text-sm font-semibold text-text-primary">Push notifications on this device</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {permission === "denied"
                ? "Blocked by your browser. Enable notifications for this site in your browser's site settings, then reload."
                : permission === "unsupported"
                ? "Not supported on this browser."
                : subscribed
                ? "On. This device will receive pushes for the categories below."
                : "Off. Turn on to get pushed updates on this device."}
            </p>
          </div>
        </div>
        {permission !== "denied" && permission !== "unsupported" && (
          <Button size="sm" variant={subscribed ? "secondary" : "primary"} loading={pushBusy} onClick={handleTogglePush}>
            {subscribed ? "Turn off" : "Turn on"}
          </Button>
        )}
      </div>

      {/* Per-category channels */}
      <div>
        <h3 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wide text-text-tertiary">Notify me about</h3>
        <div className="flex flex-col gap-3">
          {CHANNELS.map(({ key, label, description, icon: Icon }) => (
            <div key={key} className="flex items-center justify-between gap-4 rounded-lg border border-border p-3.5">
              <div className="flex items-start gap-3">
                <Icon size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-text-primary">{label}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">{description}</p>
                </div>
              </div>
              <Toggle checked={prefs[key]} label={label} onChange={(v) => { setPrefs({ ...prefs, [key]: v }); save({ [key]: v }); }} />
            </div>
          ))}

          {/* Security/account alerts: deliberately no toggle, not opt-out. */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface-sunken p-3.5">
            <div className="flex items-start gap-3">
              <ShieldAlert size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-text-primary">Account & security alerts</p>
                <p className="mt-0.5 text-xs text-text-secondary">Verification status, role changes. Always on.</p>
              </div>
            </div>
            <span className="shrink-0 rounded-pill bg-surface px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
              Always on
            </span>
          </div>
        </div>
      </div>

      {/* Quiet hours */}
      <div>
        <h3 className="mb-1 font-mono text-xs font-semibold uppercase tracking-wide text-text-tertiary">Quiet hours</h3>
        <p className="mb-3 text-xs text-text-secondary">
          Non-critical pushes pause during this window in your local time ({prefs.timezone}). Disputes and released funds
          still come through, those don&rsquo;t wait.
        </p>
        <div className="flex items-center gap-3">
          <select
            value={prefs.quiet_hours_start_local}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPrefs({ ...prefs, quiet_hours_start_local: v });
              save({ quietHoursStartLocal: v });
            }}
            className="rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-sm text-text-primary"
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {formatHour(h)}
              </option>
            ))}
          </select>
          <span className="text-sm text-text-tertiary">to</span>
          <select
            value={prefs.quiet_hours_end_local}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPrefs({ ...prefs, quiet_hours_end_local: v });
              save({ quietHoursEndLocal: v });
            }}
            className="rounded-md border border-border-strong bg-surface-sunken px-3 py-2 text-sm text-text-primary"
          >
            {HOUR_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {formatHour(h)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {saving && <p className="text-xs text-text-tertiary">Saving…</p>}
    </div>
  );
}
