"use client";

// components/ClientOnlyBuyerDashboard.tsx — see ClientOnlyRootGate.tsx for
// why this boundary exists.
import nextDynamic from "next/dynamic";

const BuyerDashboard = nextDynamic(() => import("./BuyerDashboard"), { ssr: false });

export default function ClientOnlyBuyerDashboard() {
  return <BuyerDashboard />;
}
