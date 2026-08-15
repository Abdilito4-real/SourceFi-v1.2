"use client";

// components/SourcerDashboard.tsx
//
// Real route (/sourcer) — Overview, Open Jobs, My Jobs. Only reachable at
// all if the server-verified role allows it (see the redirect guard
// below); the route existing doesn't grant access, GET /api/requests'
// row-level scoping and every escrow action's requireRole(["sourcer"])
// check do that independently, same as before this redesign.
import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Info, Coins, ShieldCheck, LayoutGrid, ClipboardList, History, Briefcase } from "lucide-react";

import { formatMoney } from "../lib/money";
import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import RequestCard from "./RequestCard";
import RequestDetailsModal from "./RequestDetailsModal";
import TransactionLedger from "./TransactionLedger";
import StatCard from "./ui/StatCard";
import { useToast } from "./ui/Toast";
import type { SourcingRequest } from "../lib/types";

type Section = "overview" | "open" | "jobs";

export default function SourcerDashboard() {
  const router = useRouter();
  const { notify } = useToast();
  const { checkingSession, user, requests, setRequests, loadingRequests, canBeSourcer, signingOut, handleSignOut } = useSession();

  const [section, setSection] = useState<Section>("overview");
  const [jobsTab, setJobsTab] = useState<"active" | "history">("active");
  const [selected, setSelected] = useState<SourcingRequest | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [auditNotes, setAuditNotes] = useState("");
  const [verificationOtp, setVerificationOtp] = useState("");

  // canBeSourcer (from useSession) also lets admins IN to this route for
  // oversight — isSourcer is the narrower, literal check every actual
  // write action here gates on, since requireRole(["sourcer"]) server-side
  // never accepts admin. See RequestDetailsModal's canTransact prop.
  const isSourcer = user?.role === "sourcer";

  // Deep-link guard: signed out, mid-onboarding, or a buyer who bookmarked
  // this URL before ever being granted sourcer access all land somewhere
  // sane instead of an empty/broken dashboard. This is a UX nicety, not
  // the security boundary — every actual write here is still
  // requireRole(["sourcer"])-checked server-side regardless of what this
  // redirect does.
  useEffect(() => {
    if (checkingSession) return;
    if (!user) {
      router.replace("/");
      return;
    }
    if (!canBeSourcer) {
      router.replace("/buyer");
    }
  }, [checkingSession, user, canBeSourcer, router]);

  const openJobs = useMemo(() => requests.filter((r) => r.status === "open"), [requests]);
  const myActive = useMemo(
    () => requests.filter((r) => r.sourcer === user?.identity && r.status !== "escrow_released"),
    [requests, user]
  );
  const myHistory = useMemo(
    () => requests.filter((r) => r.sourcer === user?.identity && r.status === "escrow_released"),
    [requests, user]
  );
  const jobsTabbed = jobsTab === "active" ? myActive : myHistory;

  const platformFeesMinor = requests
    .filter((r) => r.sourcer === user?.identity && (r.status === "escrow" || r.status === "escrow_released"))
    .reduce((acc, r) => acc + r.platformFeeMinor, 0);
  const escrowValueMinor = requests
    .filter((r) => r.sourcer === user?.identity && r.status === "escrow")
    .reduce((acc, r) => acc + r.sourcingFeeMinor, 0);

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    { key: "open", label: "Open jobs", icon: <ClipboardList size={16} />, active: section === "open", onClick: () => setSection("open"), badge: openJobs.length },
    { key: "jobs", label: "My jobs", icon: <Briefcase size={16} />, active: section === "jobs", onClick: () => setSection("jobs"), badge: myActive.length },
  ];

  const handleAdvance = async (req: SourcingRequest, nextStatus: SourcingRequest["status"] | "invite_sent") => {
    if (!user) return;
    if (!isSourcer) {
      notify("error", "That action needs the sourcer role on this account.");
      return;
    }
    if (nextStatus === "invite_sent") {
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/requests/${req.dbId}`, { method: "PATCH" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to send invite.");
        }
        setRequests((rs) => rs.map((r) => (r.dbId === req.dbId ? { ...r, inviteSent: true } : r)));
        setSelected((s) => (s ? { ...s, inviteSent: true } : s));
        notify("success", "Buyer invited to join the video session.");
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to send invite.");
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    notify("error", "That action isn't available from the sourcer dashboard.");
  };

  const handleSubmitAuditStamp = async (reqId: number, notes: string, otp: string, image: string | null, businessId: string) => {
    if (!user) return;
    if (!isSourcer) {
      notify("error", "Submitting an audit needs the sourcer role on this account.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/escrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submitAudit", requestId: reqId, otp, evidence: { notes, image, business_id: businessId } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification submission failed.");
      const auditPatch = { status: "verified" as const, auditNotes: notes, auditImage: image, auditBusinessId: businessId };
      setRequests((rs) => rs.map((r) => (r.dbId === reqId ? { ...r, ...auditPatch } : r)));
      setSelected((s) => (s?.dbId === reqId ? { ...s, ...auditPatch } : s));
      setAuditNotes("");
      setVerificationOtp("");
      notify("success", "Audit submitted and verified.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Verification submission failed.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClearSourcingPayment = async (reqId: number) => {
    if (!user) return;
    if (!isSourcer) {
      notify("error", "Clearing a payout needs the sourcer role on this account.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/escrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clearSourcingPayment", requestId: reqId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Clearance rejected.");
      const clearedAt = new Date().toISOString();
      setRequests((rs) => rs.map((r) => (r.dbId === reqId ? { ...r, clearedBySourcer: true, clearedAt } : r)));
      notify("success", "Sourcing payout cleared.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Clearance rejected.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (checkingSession || !user || !canBeSourcer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 size={22} className="spin-icon text-accent" aria-label="Loading" />
      </div>
    );
  }

  // Every account has buyer access regardless of role, so that switch link
  // always shows here; the admin link only shows for actual admins.
  const switchLinks: SwitchLink[] = [
    { label: "Switch to buyer dashboard", href: "/buyer" },
    ...(user.role === "admin" ? [{ label: "Admin dashboard", href: "/admin" }] : []),
  ];

  return (
    <DashboardShell
      activeDashboard="sourcer"
      switchLinks={switchLinks}
      navItems={navItems}
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      pageTitle={section === "overview" ? `Sourcing portal · @${user.username || "Sourcer"}` : section === "open" ? "Open jobs" : "My jobs"}
      pageSubtitle={
        section === "overview"
          ? "Claim mandates, verify on-site, get paid."
          : section === "open"
          ? "Review open requests and claim the ones relevant to your location."
          : undefined
      }
    >
      {section === "overview" && (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Platform fees earned" value={formatMoney(platformFeesMinor)} icon={<Coins size={16} />} tone="accent" />
            <StatCard label="Active in escrow" value={formatMoney(escrowValueMinor)} icon={<ShieldCheck size={16} />} />
            <StatCard label="Open jobs available" value={openJobs.length} icon={<ClipboardList size={16} />} />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-xl italic text-text-primary">Available to claim</h2>
              <button type="button" onClick={() => setSection("open")} className="text-sm font-semibold text-accent-text hover:underline">
                View all
              </button>
            </div>
            {loadingRequests ? (
              <div className="flex justify-center py-10">
                <Loader2 size={22} className="spin-icon text-accent" />
              </div>
            ) : openJobs.length === 0 ? (
              <EmptyState message="No open requests right now. Check back soon." />
            ) : (
              <div className="grid gap-3">
                {openJobs.slice(0, 4).map((r) => (
                  <RequestCard key={r.id} request={r} onOpen={setSelected} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {section === "open" && (
        <div>
          {loadingRequests ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : openJobs.length === 0 ? (
            <EmptyState message="There are currently no new open requests awaiting a claim." />
          ) : (
            <>
              <div className="grid gap-3">
                {openJobs.map((r) => (
                  <RequestCard key={r.id} request={r} onOpen={setSelected} />
                ))}
              </div>
              <p className="mt-6 text-xs leading-relaxed text-text-secondary">
                Review open requests, claim the ones relevant to your location, and conduct physically verified audits.
              </p>
            </>
          )}
        </div>
      )}

      {section === "jobs" && (
        <div>
          <div className="mb-5 flex w-fit rounded-lg border border-border bg-surface p-1">
            <button
              type="button"
              onClick={() => setJobsTab("active")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors duration-base ease-base ${
                jobsTab === "active" ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              Active ({myActive.length})
            </button>
            <button
              type="button"
              onClick={() => setJobsTab("history")}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors duration-base ease-base ${
                jobsTab === "history" ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <History size={13} /> History ({myHistory.length})
            </button>
          </div>

          {loadingRequests ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : jobsTabbed.length === 0 ? (
            <EmptyState message={jobsTab === "history" ? "No completed jobs yet." : "No active jobs yet. Claim one from Open Jobs."} />
          ) : jobsTab === "active" ? (
            <div className="grid gap-3">
              {jobsTabbed.map((r) => (
                <RequestCard key={r.id} request={r} onOpen={setSelected} />
              ))}
            </div>
          ) : (
            <div>
              <h3 className="mb-3.5 font-display text-xl italic text-text-primary">Payout registry</h3>
              <TransactionLedger
                role="sourcer"
                requests={jobsTabbed}
                onClearPayment={handleClearSourcingPayment}
                isSubmitting={isSubmitting}
                canTransact={isSourcer}
              />
            </div>
          )}
        </div>
      )}

      {selected && (
        <RequestDetailsModal
          selected={selected}
          role="sourcer"
          user={user}
          auditNotes={auditNotes}
          setAuditNotes={setAuditNotes}
          verificationOtp={verificationOtp}
          setVerificationOtp={setVerificationOtp}
          onClose={() => setSelected(null)}
          onAdvance={handleAdvance}
          onSubmitAudit={handleSubmitAuditStamp}
          isSubmitting={isSubmitting}
          showNotification={notify}
          setRequests={setRequests}
          requests={requests}
          canTransact={isSourcer}
        />
      )}
    </DashboardShell>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-5 py-10 text-center">
      <Info size={24} className="mx-auto mb-2 text-text-tertiary" />
      <p className="mx-auto max-w-[320px] text-sm text-text-secondary">{message}</p>
    </div>
  );
}
