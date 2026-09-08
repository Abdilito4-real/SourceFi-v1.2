// app/(main)/arc-demo/page.tsx
//
// New for ETHOnline 2026: a standalone demo page for the Arc Testnet
// escrow contract, kept separate from the existing buyer/supplier
// dashboards so it doesn't interfere with the app's real user flows.
import ArcEscrowDemo from "@/components/ArcEscrowDemo";

export const dynamic = "force-dynamic";

export default function ArcDemoPage() {
  return (
    <div className="min-h-screen p-8">
      <h1 className="mb-6 text-2xl font-bold">SourceFi × Arc: On-Chain Escrow Demo</h1>
      <p className="mb-6 max-w-md text-sm text-gray-600">
        A non-custodial alternative to SourceFi&apos;s existing Circle-based escrow, built during ETHOnline 2026.
      </p>
      <ArcEscrowDemo />
    </div>
  );
}