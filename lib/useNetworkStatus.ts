"use client";

// lib/useNetworkStatus.ts
//
// navigator.onLine / the online/offline events, good enough signal for
// "don't let the user tap Fund/Approve while offline" even though it only
// reflects link-layer connectivity, not whether our API is actually
// reachable (a captive portal can report "online" and still fail every
// fetch). Financial buttons still handle a failed fetch on top of this;
// this hook is the fast, unmissable-banner path, not the only guard.
import { useEffect, useState } from "react";

export function useNetworkStatus(): boolean {
  // Assume online until the effect runs, avoids a false "you're offline"
  // flash during SSR/hydration, and corrects itself within one paint.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
