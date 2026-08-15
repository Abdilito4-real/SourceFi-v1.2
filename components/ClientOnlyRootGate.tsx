"use client";

// components/ClientOnlyRootGate.tsx
//
// Next 16 rule: next/dynamic's ssr:false can't be called from a Server
// Component. app/(main)/page.tsx stays a Server Component (so its
// `export const dynamic = "force-dynamic"` keeps meaning what it always
// meant); this is the client boundary that satisfies the rule.
import nextDynamic from "next/dynamic";

const RootGate = nextDynamic(() => import("./RootGate"), { ssr: false });

export default function ClientOnlyRootGate() {
  return <RootGate />;
}
