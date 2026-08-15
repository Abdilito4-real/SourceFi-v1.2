// app/(main)/admin/page.tsx
import ClientOnlyAdminDashboard from "../../../components/ClientOnlyAdminDashboard";

// See app/(main)/page.tsx for why this stays force-dynamic + ssr:false.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ClientOnlyAdminDashboard />;
}
