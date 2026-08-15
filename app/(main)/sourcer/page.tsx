// app/(main)/sourcer/page.tsx
import ClientOnlySourcerDashboard from "../../../components/ClientOnlySourcerDashboard";

// See app/(main)/page.tsx for why this stays force-dynamic + ssr:false.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ClientOnlySourcerDashboard />;
}
