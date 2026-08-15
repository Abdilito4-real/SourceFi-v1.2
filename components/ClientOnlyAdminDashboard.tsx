"use client";

// components/ClientOnlyAdminDashboard.tsx — see ClientOnlyRootGate.tsx
// for why this boundary exists.
import nextDynamic from "next/dynamic";

const AdminDashboard = nextDynamic(() => import("./AdminDashboard"), { ssr: false });

export default function ClientOnlyAdminDashboard() {
  return <AdminDashboard />;
}
