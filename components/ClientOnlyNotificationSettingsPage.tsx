"use client";

// components/ClientOnlyNotificationSettingsPage.tsx, see
// ClientOnlyRootGate.tsx for why this boundary exists (Privy/session
// state can't SSR).
import nextDynamic from "next/dynamic";

const NotificationSettingsPage = nextDynamic(() => import("./NotificationSettingsPage"), { ssr: false });

export default function ClientOnlyNotificationSettingsPage() {
  return <NotificationSettingsPage />;
}
