"use client";

// components/ClientOnlySourcerDashboard.tsx — see ClientOnlyRootGate.tsx
// for why this boundary exists.
import nextDynamic from "next/dynamic";

const SourcerDashboard = nextDynamic(() => import("./SourcerDashboard"), { ssr: false });

export default function ClientOnlySourcerDashboard() {
  return <SourcerDashboard />;
}
