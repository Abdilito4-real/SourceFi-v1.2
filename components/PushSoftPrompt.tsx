"use client";

// components/PushSoftPrompt.tsx
//
// PERMISSION TIMING (feedback-layer rule, important):
//   - Never request permission on page load.
//   - Ask only after a moment where value is obvious (right after funding
//     escrow, right after a supplier's first listing goes live).
//   - Precede the browser prompt with this soft prompt. Decline the soft
//     prompt -> the native one never fires.
//   - Denied -> degrade gracefully, remember, never re-prompt in a loop.
//
// This component IS the gate for all of that: a caller sets `open` to
// true at the moment it judges value is obvious, but this decides
// whether anything actually renders, already-decided permission
// (granted or denied) or a remembered soft-decline both render nothing,
// silently, no matter what the caller passes.
import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import Button from "./ui/Button";
import { getPermissionState, enablePush, PushSetupError } from "../lib/pushClient";
import { useToast } from "./ui/Toast";

const SOFT_DECLINE_KEY = "sourcefi_push_soft_declined";

export function hasPushBeenSoftDeclined(): boolean {
  try {
    return localStorage.getItem(SOFT_DECLINE_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberSoftDecline(): void {
  try {
    localStorage.setItem(SOFT_DECLINE_KEY, "true");
  } catch {
    /* best-effort only, worst case this can offer again next session */
  }
}

export interface PushSoftPromptProps {
  open: boolean;
  onClose: () => void;
  /** One short sentence naming the actual moment, e.g. "You just funded
   * escrow.", shown above the generic explanation. */
  reason: string;
}

export default function PushSoftPrompt({ open, onClose, reason }: PushSoftPromptProps) {
  const { notify } = useToast();
  const [enabling, setEnabling] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");

  useEffect(() => {
    if (open) setPermission(getPermissionState());
  }, [open]);

  const eligible = open && permission === "default" && !hasPushBeenSoftDeclined();

  // The caller's `open` can be true for a reason that turns out
  // ineligible (already decided, already soft-declined), close it back
  // out immediately rather than leave the caller's state stuck true with
  // nothing visibly happening.
  useEffect(() => {
    if (open && !eligible) onClose();
  }, [open, eligible, onClose]);

  if (!eligible) return null;

  const handleEnable = async () => {
    setEnabling(true);
    try {
      await enablePush();
      notify("success", "Notifications turned on.");
    } catch (err) {
      notify("error", err instanceof PushSetupError ? err.message : "Couldn't turn on notifications.");
    } finally {
      setEnabling(false);
      onClose();
    }
  };

  const handleDecline = () => {
    rememberSoftDecline();
    onClose();
  };

  return (
    <div
      role="complementary"
      aria-label="Enable notifications"
      className="fixed inset-x-4 bottom-5 z-[1050] mx-auto flex max-w-sm items-start gap-3 rounded-xl border border-border bg-surface-elevated p-4 shadow-lg sm:inset-x-auto sm:right-5"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft">
        <BellRing size={16} className="text-accent-text" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">Get notified?</p>
        <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
          {reason} Turn on notifications for order/job updates, escrow status, and disputes, nothing else, and you can
          turn it off anytime from your notification settings.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" loading={enabling} onClick={handleEnable}>
            Turn on
          </Button>
          <Button size="sm" variant="ghost" disabled={enabling} onClick={handleDecline}>
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}
