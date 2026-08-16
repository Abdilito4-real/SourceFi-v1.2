"use client";

// components/ClientOnlySupplierDashboard.tsx — see ClientOnlyRootGate.tsx
// for why this boundary exists. Supersedes ClientOnlySourcerDashboard.tsx.
import nextDynamic from "next/dynamic";

const SupplierDashboard = nextDynamic(() => import("./SupplierDashboard"), { ssr: false });

export default function ClientOnlySupplierDashboard() {
  return <SupplierDashboard />;
}
