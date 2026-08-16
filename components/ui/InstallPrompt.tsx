"use client";

// components/ui/InstallPrompt.tsx
//
// Captures beforeinstallprompt (Chrome/Edge/Android, Safari has no
// equivalent event and always shows its own native "Add to Home Screen"
// affordance instead, so this component simply never appears there).
// Dismissal is remembered permanently, not just for the session, "don't
// nag" means don't ask again next visit either, not just this one.
import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import Button from "./Button";

// Not part of lib.dom.d.ts, this is a real, standard event
// (https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent)
// that TypeScript's bundled DOM types simply don't ship yet.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = "sourcefi_install_dismissed";

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "true";
    } catch (e) {
      /* localStorage unavailable, fall through and just don't nag this session */
    }
    if (dismissed) return;

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);

    // If the app gets installed by any means (this card, the browser's own
    // menu item, an existing install), stop offering, there's nothing left
    // to prompt for.
    const onInstalled = () => setVisible(false);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch (e) {
      /* best-effort only */
    }
  };

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setVisible(false);
    // Deliberately not persisting DISMISS_KEY here, if they accepted, the
    // 'appinstalled' listener above handles it; if they declined via the
    // native dialog, it's reasonable to offer again on a later visit rather
    // than treating a native-dialog "not now" the same as dismissing our card.
  };

  if (!visible) return null;

  return (
    <div
      role="complementary"
      aria-label="Install SourceFi"
      className="fixed inset-x-4 bottom-5 z-[1050] mx-auto flex max-w-sm items-center gap-3 rounded-xl border border-border bg-surface-elevated p-4 shadow-lg sm:inset-x-auto sm:right-5"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-soft">
        <Download size={16} className="text-accent-text" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">Install SourceFi</p>
        <p className="text-xs text-text-secondary">Faster access, works with a weak signal.</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" onClick={install}>
          Install
        </Button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="p-1 text-text-tertiary hover:text-text-primary"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
