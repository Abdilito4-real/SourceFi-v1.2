// app/(main)/buyer/page.tsx
import ClientOnlyBuyerDashboard from "../../../components/ClientOnlyBuyerDashboard";

// See app/(main)/page.tsx for why this stays force-dynamic + ssr:false.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ClientOnlyBuyerDashboard />;
}
