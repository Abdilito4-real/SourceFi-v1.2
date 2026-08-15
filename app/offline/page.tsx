// app/offline/page.tsx
//
// Served by the service worker's navigation fallback when a page isn't
// cached and the network request fails — replaces the browser's default
// "no internet" dinosaur page. Lives outside app/(main) deliberately: it
// must render with zero dependencies (no Privy, no fetch) since the whole
// point is that the network is down.
import type { Metadata } from "next";
import { WifiOff, Package } from "lucide-react";

export const metadata: Metadata = {
  title: "You're offline · SourceFi",
};

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-6 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full border-[1.5px] border-border bg-surface-sunken">
        <WifiOff size={24} className="text-text-tertiary" />
      </div>
      <h1 className="mb-2 font-display text-2xl font-semibold text-text-primary">You&rsquo;re offline</h1>
      <p className="mb-6 max-w-sm text-base leading-relaxed text-text-secondary">
        SourceFi can&rsquo;t reach the network right now. Anything you already had open may still be cached, so check
        your connection and try again.
      </p>
      <a
        href="/"
        className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2.5 font-body text-md font-bold text-accent-contrast transition-[filter] duration-base ease-base hover:brightness-95"
      >
        <Package size={15} /> Try again
      </a>
    </div>
  );
}
