"use client";

// components/PendingVerificationScreen.tsx
//
// A first-time supplier applicant stays role='buyer' until an admin
// approves them (see docs/marketplace-payments-design.md Section 0 —
// approval is what actually flips the role). Per explicit product
// direction, that account does NOT get normal buyer access while a
// first-time application is pending — this screen is the entire
// experience until an admin reviews it, not a dismissible banner on top
// of a working dashboard. RootGate renders this in place of the /buyer
// redirect; BuyerDashboard also bounces back here defensively if someone
// reaches /buyer directly (bookmark, back button) while still pending.
//
// Re-verification after expiry is NOT gated this way — that account is
// already role='supplier' and keeps full dashboard access (existing
// orders still need managing); only a first-time, not-yet-a-supplier-at-all
// applicant sees this screen.
import Image from "next/image";
import { Clock, LogOut } from "lucide-react";
import type { SupplierVerificationApplicationRow } from "../lib/types";

export interface PendingVerificationScreenProps {
  application: SupplierVerificationApplicationRow;
  onSignOut: () => void;
  signingOut: boolean;
}

export default function PendingVerificationScreen({ application, onSignOut, signingOut }: PendingVerificationScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-5">
      <div className="w-full max-w-[460px] rounded-2xl border border-border bg-surface-elevated p-9 text-center shadow-lg">
        <Image src="/logo-mark.png" alt="" width={48} height={48} className="mx-auto mb-5 rounded-xl" priority />

        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border-[1.5px] border-accent bg-accent-soft">
          <Clock size={20} className="text-accent-text" />
        </div>

        <h2 className="mb-1.5 font-display text-2xl italic text-text-primary">Verification under review</h2>
        <p className="text-base leading-relaxed text-text-secondary">
          Your application for <strong className="text-text-primary">{application.business_name}</strong> is being
          reviewed by an admin.
        </p>

        <div className="my-6 rounded-xl border border-border bg-surface-sunken p-4 text-left">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Submitted</div>
          <div className="mt-0.5 text-sm text-text-primary">{new Date(application.created_at).toLocaleString()}</div>
        </div>

        <p className="text-sm leading-relaxed text-text-secondary">
          Most reviews complete within a couple of minutes, but it can take up to <strong>48 hours</strong>. You'll get
          full supplier access on this account the moment it's approved — no need to reapply or do anything else
          in the meantime.
        </p>

        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-text-secondary underline hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LogOut size={13} /> {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}
