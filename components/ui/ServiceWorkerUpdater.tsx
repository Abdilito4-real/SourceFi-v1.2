"use client";

// components/ui/ServiceWorkerUpdater.tsx
//
// The service worker is registered with skipWaiting/clientsClaim OFF (see
// next.config.mjs) specifically so a new version sits "waiting" instead of
// silently taking over — a sourcer mid-audit must not have the app swap
// out from under them. This is the other half of that contract: offer the
// reload as a sticky toast with an explicit action, on the user's terms,
// never force it.
import { useEffect, useRef } from "react";
import { useToast } from "./Toast";

export default function ServiceWorkerUpdater() {
  const { notify } = useToast();
  const offeredRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return; // SW is disabled in dev — see next.config.mjs

    let cancelled = false;

    import("workbox-window").then(({ Workbox }) => {
      if (cancelled) return;
      const wb = new Workbox("/sw.js");

      const offerReload = () => {
        if (offeredRef.current) return; // one offer per waiting worker — don't nag
        offeredRef.current = true;
        notify("info", "New version available. Reload to update.", {
          duration: 0, // sticky — this is a decision, not a status update
          action: {
            label: "Reload",
            onClick: () => {
              wb.addEventListener("controlling", () => window.location.reload());
              wb.messageSkipWaiting();
            },
          },
        });
      };

      // "externalwaiting" (fires when a different tab registers the newer
      // worker) isn't in this workbox-window version's typed event map —
      // dropped rather than cast around; "waiting" alone covers the case
      // that matters here (this tab's own registration going stale).
      wb.addEventListener("waiting", offerReload);
      wb.register();
    });

    return () => {
      cancelled = true;
    };
  }, [notify]);

  return null;
}
