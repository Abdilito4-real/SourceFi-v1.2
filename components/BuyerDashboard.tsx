"use client";

// components/BuyerDashboard.tsx
//
// Real route (/buyer), real dashboard — three sections (Overview,
// Materials, Requests) behind a persistent sidebar, replacing the old
// single-page App.tsx's one long scroll gated by a role pill.
import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Info, ArrowRight, Layers, Coins, Building2, Package, HardHat, LayoutGrid, FileText, History, X, Wallet2, ChevronRight } from "lucide-react";

import { materialLibrary, sendUsdcOnArc } from "../lib/constants";
import { toMinorUnits, fromMinorUnits, formatMoney } from "../lib/money";
import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import RequestCard from "./RequestCard";
import FundingModal from "./FundingModal";
import RequestDetailsModal from "./RequestDetailsModal";
import Button from "./ui/Button";
import { Card } from "./ui/Card";
import Modal from "./ui/Modal";
import StatCard from "./ui/StatCard";
import { Label, Input } from "./ui/Field";
import Select from "./ui/Select";
import { useToast } from "./ui/Toast";
import type { Material, SourcingRequest, SourcingRequestRow, Currency } from "../lib/types";

type Section = "overview" | "materials" | "requests";

function materialIcon(id: string) {
  if (id === "earthblocks" || id === "hempcrete") return <Building2 size={20} className="text-accent-text" />;
  if (id === "bubbledeck" || id === "structuralsystems") return <Layers size={20} className="text-accent-text" />;
  if (id === "lc3cement" || id === "cement") return <Package size={20} className="text-accent-text" />;
  if (id === "geopolymer" || id === "passivecooling") return <HardHat size={20} className="text-accent-text" />;
  return <Layers size={20} className="text-accent-text" />;
}

function MaterialCard({ material, onOpen }: { material: Material; onOpen: (m: Material) => void }) {
  return (
    <Card
      interactive
      onClick={() => onOpen(material)}
      className="flex cursor-pointer flex-col gap-4 p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
          {materialIcon(material.id)}
        </div>
        <span className="rounded bg-accent-soft px-2 py-1 text-right text-[10.5px] font-bold leading-tight text-accent-text">
          {material.savings}
        </span>
      </div>
      <div>
        <h3 className="mb-1 font-display text-lg italic leading-tight text-text-primary">{material.name}</h3>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{material.tag}</div>
        <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{material.hook}</p>
      </div>
      <div className="mt-auto flex items-center gap-1 text-sm font-semibold text-accent-text">
        View details <ChevronRight size={14} />
      </div>
    </Card>
  );
}

function MaterialDetail({ material, onClose, onRequestThis }: { material: Material; onClose: () => void; onRequestThis: (m: Material) => void }) {
  return (
    <Modal open onClose={onClose} size="sm">
      <div className="mb-3.5 flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-accent-text">Specification profile</span>
        <button type="button" onClick={onClose} aria-label="Close" className="text-text-tertiary hover:text-text-primary">
          <X size={18} />
        </button>
      </div>
      <h3 className="m-0 mb-1.5 font-display text-[22px] italic text-text-primary">{material.name}</h3>
      <p className="mb-4 text-sm leading-relaxed text-text-secondary">{material.explainer}</p>
      <div className="mb-4 rounded-lg border border-border bg-surface-sunken p-3">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-text">Why it's rare in Nigeria</div>
        <div className="text-xs leading-relaxed text-text-secondary">{material.whyRare}</div>
      </div>
      <div className="mb-5 flex flex-wrap gap-2.5">
        <span className="rounded bg-accent-soft px-2 py-1 text-xs font-semibold text-accent-text">{material.tag}</span>
        <span className="rounded bg-surface-sunken px-2 py-1 text-xs font-semibold text-text-primary">{material.savings}</span>
        <span className="rounded bg-surface-sunken px-2 py-1 text-xs font-semibold text-text-primary">{material.metrics}</span>
      </div>
      <Button fullWidth onClick={() => onRequestThis(material)}>
        Create sourcing mandate
      </Button>
    </Modal>
  );
}

interface NewRequestModalProps {
  onClose: () => void;
  onSubmit: (form: { title: string; budgetAmount: string; budgetCurrency: Currency; location: string; category: string }) => void | Promise<void>;
  prefill: Material | null;
  submitting: boolean;
}

function NewRequestModal({ onClose, onSubmit, prefill, submitting }: NewRequestModalProps) {
  const [title, setTitle] = useState(prefill ? `Procure ${prefill.name}` : "");
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetCurrency, setBudgetCurrency] = useState<Currency>("USD");
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState(prefill ? prefill.id : "earthblocks");

  const validBudget = budgetAmount.trim() !== "" && !isNaN(Number(budgetAmount)) && Number(budgetAmount) >= 0;

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validBudget) return;
    onSubmit({ title, budgetAmount, budgetCurrency, location, category });
  };

  return (
    <Modal open onClose={onClose} title="New sourcing mandate" size="sm">
      <form onSubmit={handleFormSubmit} className="flex flex-col gap-3.5">
        <div>
          <Label htmlFor="new-req-title">Material title</Label>
          <Input id="new-req-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 500 units of compressed earth blocks" required />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="new-req-budget">Estimated budget</Label>
            <Input id="new-req-budget" inputMode="decimal" value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} placeholder="e.g. 2500" required />
          </div>
          <div className="w-28">
            <Label htmlFor="new-req-currency">Currency</Label>
            <Select id="new-req-currency" value={budgetCurrency} onChange={(e) => setBudgetCurrency(e.target.value as Currency)}>
              <option value="USD">USD</option>
              <option value="NGN">NGN</option>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="new-req-location">Delivery location</Label>
          <Input id="new-req-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Lagos, NG" required />
        </div>
        <div>
          <Label htmlFor="new-req-category">Sourcing category</Label>
          <Select id="new-req-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {materialLibrary.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" fullWidth loading={submitting} disabled={submitting || !(title.trim() && validBudget && location.trim())}>
          {submitting ? "Broadcasting…" : "Broadcast mandate request"}
        </Button>
      </form>
    </Modal>
  );
}

export default function BuyerDashboard() {
  const router = useRouter();
  const { notify } = useToast();
  const {
    checkingSession,
    user,
    requests,
    setRequests,
    loadingRequests,
    walletBalance,
    web3ConnectedAddress,
    wallets,
    canBeSourcer,
    signingOut,
    handleSignOut,
    login,
  } = useSession();

  const [section, setSection] = useState<Section>("overview");
  const [tab, setTab] = useState<"active" | "history">("active");
  const [selected, setSelected] = useState<SourcingRequest | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [creatingRequest, setCreatingRequest] = useState(false);
  const [showFunding, setShowFunding] = useState(false);
  const [viewingMaterial, setViewingMaterial] = useState<Material | null>(null);
  const [requestPrefill, setRequestPrefill] = useState<Material | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [auditNotes, setAuditNotes] = useState("");
  const [verificationOtp, setVerificationOtp] = useState("");

  // Deep-link guard: someone bookmarking /buyer while signed out or mid-
  // onboarding lands back at the gate instead of an empty/broken dashboard.
  useEffect(() => {
    if (checkingSession) return;
    if (!user) router.replace("/");
  }, [checkingSession, user, router]);

  // POST /api/requests is requireRole(["buyer"])-checked server-side — that
  // stays the real boundary, unchanged. This is purely a UX fix: a
  // sourcer/admin account (which also lands on /buyer, since anyone can
  // browse it) could previously fill out the entire New Request form only
  // to get a confusing 403 after submitting. Gating the entry point means
  // they find out before typing anything, not after.
  const isBuyer = user?.role === "buyer";
  const openNewRequestModal = (prefill: Material | null = null) => {
    if (!isBuyer) {
      notify("error", "Posting a request needs the buyer role on this account.");
      return;
    }
    setRequestPrefill(prefill);
    setShowNew(true);
  };

  const activeCount = requests.filter((r) => r.status !== "escrow_released").length;
  const escrowValueMinor = requests.filter((r) => r.status === "escrow").reduce((acc, r) => acc + r.sourcingFeeMinor + r.platformFeeMinor, 0);
  const completedCount = requests.filter((r) => r.status === "escrow_released").length;

  const tabbed = useMemo(
    () => (tab === "active" ? requests.filter((r) => r.status !== "escrow_released") : requests.filter((r) => r.status === "escrow_released")),
    [requests, tab]
  );

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    { key: "materials", label: "Materials", icon: <Package size={16} />, active: section === "materials", onClick: () => setSection("materials") },
    {
      key: "requests",
      label: "Requests",
      icon: <FileText size={16} />,
      active: section === "requests",
      onClick: () => setSection("requests"),
      badge: activeCount,
    },
  ];

  const handleSubmitRequest = async (form: { title: string; budgetAmount: string; budgetCurrency: Currency; location: string; category: string }) => {
    setCreatingRequest(true);
    try {
      const res = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.request) throw new Error(data.error || "Failed to create sourcing request.");
      setRequests((prev) => [toSourcingRequest(data.request as SourcingRequestRow), ...prev]);
      notify("success", "Sourcing request broadcast to verified partners.");
      setShowNew(false);
      setSection("requests");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to create sourcing request.");
    } finally {
      setCreatingRequest(false);
    }
  };

  const handleExecuteVerifyAndDeposit = async () => {
    const activeWallet = wallets?.[0];
    if (!activeWallet || !selected || !user) return;
    const escrowAddress = process.env.NEXT_PUBLIC_ESCROW_WALLET_ADDRESS || "";
    const totalAmount = fromMinorUnits(selected.sourcingFeeMinor + selected.platformFeeMinor);
    try {
      setIsSubmitting(true);
      const txHash = await sendUsdcOnArc(activeWallet, escrowAddress, totalAmount);
      const res = await fetch("/api/escrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recordDeposit", requestId: selected.dbId, txHash }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deposit could not be recorded.");
      setRequests((rs) => rs.map((r) => (r.id === selected.id ? { ...r, status: "escrow" } : r)));
      setSelected((s) => (s ? { ...s, status: "escrow" } : s));
      notify("success", "Escrow funded. Verification can now begin.");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Payment rejected.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAdvance = async (req: SourcingRequest, nextStatus: SourcingRequest["status"] | "invite_sent") => {
    if (!user) return;
    if (!isBuyer) {
      notify("error", "That action needs the buyer role on this account.");
      return;
    }
    if (nextStatus === "escrow") {
      await handleExecuteVerifyAndDeposit();
      return;
    }
    if (nextStatus === "escrow_released") {
      setIsSubmitting(true);
      try {
        const res = await fetch("/api/escrow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "releaseEscrow", requestId: req.dbId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Release rejected.");
        setRequests((rs) => rs.map((r) => (r.id === req.id ? { ...r, status: "escrow_released" } : r)));
        setSelected((s) => (s ? { ...s, status: "escrow_released" } : s));
        notify("success", "Escrow released. Funds are on their way to your sourcing partner.");
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Release rejected.");
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    notify("error", "That action isn't available from the buyer dashboard.");
  };

  const noop = () => {
    /* buyer never submits an audit — required by RequestDetailsModal's shared prop shape */
  };

  const switchLinks: SwitchLink[] = [
    ...(canBeSourcer ? [{ label: "Switch to sourcer dashboard", href: "/sourcer" }] : []),
    ...(user?.role === "admin" ? [{ label: "Admin dashboard", href: "/admin" }] : []),
  ];

  if (checkingSession || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 size={22} className="spin-icon text-accent" aria-label="Loading" />
      </div>
    );
  }

  return (
    <DashboardShell
      activeDashboard="buyer"
      switchLinks={switchLinks}
      navItems={navItems}
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      pageTitle={section === "overview" ? `Welcome back, ${user.username || "Buyer"}` : section === "materials" ? "Material library" : "Sourcing requests"}
      pageSubtitle={
        section === "overview"
          ? "Your procurement activity at a glance."
          : section === "materials"
          ? "Hard-to-source architectural materials, verified before they leave the warehouse."
          : undefined
      }
      accountCluster={
        <>
          <div className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent-text">
            {walletBalance} USD
          </div>
          {!web3ConnectedAddress ? (
            <button
              type="button"
              onClick={login}
              className="rounded-md border border-border-strong px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-surface-sunken"
            >
              Connect wallet
            </button>
          ) : (
            <div title={web3ConnectedAddress} className="rounded-md border border-accent bg-accent-soft px-3 py-1.5 text-xs font-bold text-accent-text">
              {web3ConnectedAddress.substring(0, 6)}...{web3ConnectedAddress.substring(38)}
            </div>
          )}
        </>
      }
      headerAction={
        <>
          <Button variant="secondary" onClick={() => setShowFunding(true)}>
            <Wallet2 size={14} /> Deposit
          </Button>
          <span title={isBuyer ? undefined : "Posting a request needs the buyer role on this account."}>
            <Button disabled={!isBuyer} onClick={() => openNewRequestModal()}>
              New request <ArrowRight size={14} />
            </Button>
          </span>
        </>
      }
    >
      {section === "overview" && (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Active mandates" value={activeCount} icon={<FileText size={16} />} />
            <StatCard label="Locked in escrow" value={formatMoney(escrowValueMinor)} icon={<Coins size={16} />} tone="accent" />
            <StatCard label="Completed" value={completedCount} icon={<History size={16} />} />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-xl italic text-text-primary">Recent activity</h2>
              <button type="button" onClick={() => setSection("requests")} className="text-sm font-semibold text-accent-text hover:underline">
                View all
              </button>
            </div>
            {loadingRequests ? (
              <div className="flex justify-center py-10">
                <Loader2 size={22} className="spin-icon text-accent" />
              </div>
            ) : requests.length === 0 ? (
              <EmptyRequests onNew={isBuyer ? () => openNewRequestModal() : undefined} />
            ) : (
              <div className="grid gap-3">
                {requests.slice(0, 4).map((r) => (
                  <RequestCard key={r.id} request={r} onOpen={setSelected} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {section === "materials" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {materialLibrary.map((m) => (
            <MaterialCard key={m.id} material={m} onOpen={setViewingMaterial} />
          ))}
        </div>
      )}

      {section === "requests" && (
        <div>
          <div className="mb-5 flex w-fit rounded-lg border border-border bg-surface p-1">
            <button
              type="button"
              onClick={() => setTab("active")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors duration-base ease-base ${
                tab === "active" ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              Active ({activeCount})
            </button>
            <button
              type="button"
              onClick={() => setTab("history")}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors duration-base ease-base ${
                tab === "history" ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <History size={13} /> History ({completedCount})
            </button>
          </div>

          {loadingRequests ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : tabbed.length === 0 ? (
            <EmptyRequests onNew={isBuyer ? () => openNewRequestModal() : undefined} historyTab={tab === "history"} />
          ) : (
            <div className="grid gap-3">
              {tabbed.map((r) => (
                <RequestCard key={r.id} request={r} onOpen={setSelected} />
              ))}
            </div>
          )}
        </div>
      )}

      {viewingMaterial && (
        <MaterialDetail
          material={viewingMaterial}
          onClose={() => setViewingMaterial(null)}
          onRequestThis={(material) => {
            setViewingMaterial(null);
            openNewRequestModal(material);
          }}
        />
      )}
      {showNew && (
        <NewRequestModal onClose={() => setShowNew(false)} onSubmit={handleSubmitRequest} prefill={requestPrefill} submitting={creatingRequest} />
      )}
      {showFunding && <FundingModal onClose={() => setShowFunding(false)} accountAddress={web3ConnectedAddress} />}
      {selected && (
        <RequestDetailsModal
          selected={selected}
          role="buyer"
          user={user}
          auditNotes={auditNotes}
          setAuditNotes={setAuditNotes}
          verificationOtp={verificationOtp}
          setVerificationOtp={setVerificationOtp}
          onClose={() => setSelected(null)}
          onAdvance={handleAdvance}
          onSubmitAudit={noop}
          isSubmitting={isSubmitting}
          showNotification={notify}
          setRequests={setRequests}
          requests={requests}
          canTransact={isBuyer}
        />
      )}
    </DashboardShell>
  );
}

function EmptyRequests({ onNew, historyTab = false }: { onNew?: () => void; historyTab?: boolean }) {
  return (
    <div className="rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-5 py-10 text-center">
      <Info size={24} className="mx-auto mb-2 text-text-tertiary" />
      <div className="text-sm font-semibold text-text-primary">{historyTab ? "No completed requests yet" : "No requests yet"}</div>
      <p className="mx-auto mt-1 max-w-[300px] text-xs text-text-secondary">
        {historyTab
          ? "Completed sourcing requests will appear here once payouts are disbursed."
          : onNew
          ? "Post a new request or browse the material library to get started."
          : "Browse the material library to see what's sourceable."}
      </p>
      {!historyTab && onNew && (
        <Button size="sm" className="mt-4" onClick={onNew}>
          New request
        </Button>
      )}
    </div>
  );
}

function toSourcingRequest(r: SourcingRequestRow): SourcingRequest {
  return {
    id: r.request_code,
    dbId: r.id,
    title: r.title,
    buyer: r.buyer_email || "",
    budgetMinor: r.budget_minor,
    budgetCurrency: r.budget_currency,
    location: r.location || "Not specified",
    posted: new Date(r.created_at).toLocaleDateString(),
    status: r.status,
    category: r.category || "",
    sourcer: r.sourcer_email,
    sourcingFeeMinor: r.sourcing_fee_minor || 0,
    platformFeeMinor: r.platform_fee_minor || 0,
    inviteSent: Boolean(r.invite_sent_at),
    clearedBySourcer: r.cleared_by_sourcer,
    clearedAt: r.cleared_at,
    flagged: r.flagged,
    auditNotes: r.audit_notes,
    auditImage: r.audit_image,
    auditBusinessId: r.audit_business_id,
    depositTxHash: r.deposit_tx_hash,
    releaseTxHash: r.release_tx_hash,
    releasedAt: r.released_at,
  };
}
