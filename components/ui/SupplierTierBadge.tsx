// components/ui/SupplierTierBadge.tsx
//
// Renders the tier lib/supplierTrust.ts computed server-side (this
// component never recomputes it, just labels/colors whatever string
// the API returned). null = not currently verified, renders nothing,
// same as today's directory only ever listing verified suppliers.
import React from "react";
import { ShieldCheck, Award, Crown } from "lucide-react";
import Badge, { type BadgeTone } from "./Badge";

export type SupplierTier = "verified" | "verified_pro" | "elite";

const TIER_CONFIG: Record<SupplierTier, { label: string; tone: BadgeTone; icon: React.ReactNode }> = {
  verified: { label: "Verified", tone: "success", icon: <ShieldCheck size={11} /> },
  verified_pro: { label: "Verified Pro", tone: "accent", icon: <Award size={11} /> },
  elite: { label: "Elite", tone: "warning", icon: <Crown size={11} /> },
};

export default function SupplierTierBadge({ tier, className }: { tier: SupplierTier | null; className?: string }) {
  if (!tier) return null;
  const config = TIER_CONFIG[tier];
  return (
    <Badge tone={config.tone} className={className}>
      {config.icon} {config.label}
    </Badge>
  );
}
