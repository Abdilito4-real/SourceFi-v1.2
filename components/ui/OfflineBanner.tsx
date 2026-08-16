"use client";

// components/ui/OfflineBanner.tsx
//
// Feedback-layer rule: "Persistent, unmissable offline banner" +
// "On reconnect, tell the user what synced and what failed." Sits above
// everything (z-[1200], higher than Modal's 1000 and the toast stack's
// 1100) so it's visible even with a dialog open, a sourcer mid-approval
// on a dropping signal needs to see this regardless of what else is on
// screen.
//
// There's no real offline action queue yet in this app (financial actions
// are simply disabled while offline instead of queued, see
// OrderDetailsModal, and the field/offline mode for sourcers is Stage 10
// of the build plan, not started). This banner and the reconnect toast are
// the connection-state half of the contract now; queued-item status slots
// in here once that queue exists, rather than being faked ahead of it.
import { useEffect, useRef } from "react";
import { WifiOff } from "lucide-react";
import { useNetworkStatus } from "../../lib/useNetworkStatus";
import { useToast } from "./Toast";

// Fixed, known height (not measured) so the reserve-space effect below can
// set a matching body padding synchronously, with no measure-then-flash
// step and no per-dashboard layout coordination, every dashboard already
// has its own sticky header; this just pushes the whole page down by a
// constant instead of overlaying it.
const BANNER_HEIGHT = "2.25rem"; // matches h-9 below

export default function OfflineBanner() {
  const online = useNetworkStatus();
  const { notify } = useToast();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
    } else if (wasOffline.current) {
      wasOffline.current = false;
      notify("success", "Back online.");
    }
  }, [online, notify]);

  // Reserve the banner's own height at the top of the page instead of
  // letting a `position: fixed` overlay sit on top of content, a
  // sourcer's Fund/Approve button at the top of a dashboard must stay
  // reachable, not hidden under this. Reverts on unmount too, so this
  // never leaks into a page that stops rendering OfflineBanner.
  useEffect(() => {
    document.body.style.paddingTop = online ? "" : BANNER_HEIGHT;
    return () => {
      document.body.style.paddingTop = "";
    };
  }, [online]);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[1200] flex h-9 items-center justify-center gap-2 bg-danger px-4 text-center text-sm font-semibold text-white"
    >
      <WifiOff size={14} aria-hidden="true" />
      You&rsquo;re offline. Payment actions are paused until your connection comes back.
    </div>
  );
}
