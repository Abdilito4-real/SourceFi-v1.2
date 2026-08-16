// app/(main)/settings/notifications/page.tsx
import ClientOnlyNotificationSettingsPage from "../../../../components/ClientOnlyNotificationSettingsPage";

// See app/(main)/page.tsx for why this stays force-dynamic + ssr:false.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ClientOnlyNotificationSettingsPage />;
}
