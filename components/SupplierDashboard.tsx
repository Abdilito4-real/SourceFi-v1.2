"use client";

// components/SupplierDashboard.tsx
//
// Real route (/supplier) — supersedes SourcerDashboard.tsx. Overview,
// Orders, Verification. Marketplace pivot: no more "claim an open job,
// visit a supplier, submit an audit" — the account HOLDING this
// dashboard now IS the supplier, verified once at onboarding (design doc
// Section 0), receiving orders buyers place directly and fulfilling them.
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Info, Coins, ShieldCheck, ShieldAlert, LayoutGrid, FileText, History, Clock } from "lucide-react";

import { formatMoney } from "../lib/money";
import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import OrderCard from "./OrderCard";
import OrderDetailsModal from "./OrderDetailsModal";
import Button from "./ui/Button";
import { Card } from "./ui/Card";
import StatCard from "./ui/StatCard";
import Badge from "./ui/Badge";
import { Label, Input, Textarea } from "./ui/Field";
import { useToast } from "./ui/Toast";
import type { SupplierProfileRow, SupplierVerificationApplicationRow } from "../lib/types";

type Section = "overview" | "orders" | "verification";

const TERMINAL_STATUSES = new Set(["settled", "refunded", "cancelled", "expired"]);

function VerificationApplicationForm({ onSubmitted }: { onSubmitted: () => void }) {
  const { notify } = useToast();
  const [businessName, setBusinessName] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");
  const [whatTheySell, setWhatTheySell] = useState("");
  const [cacRegistrationNumber, setCacRegistrationNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = businessName.trim() && businessLocation.trim() && whatTheySell.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/supplier-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName, businessLocation, whatTheySell, cacRegistrationNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit application.");
      notify("success", "Verification application submitted — an admin will review it.");
      onSubmitted();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to submit application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5">
      <div>
        <Label htmlFor="verif-business-name">Business name</Label>
        <Input id="verif-business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="verif-cac">CAC registration number (optional)</Label>
        <Input id="verif-cac" value={cacRegistrationNumber} onChange={(e) => setCacRegistrationNumber(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="verif-location">Business location</Label>
        <Input id="verif-location" value={businessLocation} onChange={(e) => setBusinessLocation(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="verif-sells">What do you produce or sell?</Label>
        <Textarea id="verif-sells" value={whatTheySell} onChange={(e) => setWhatTheySell(e.target.value)} required />
      </div>
      <Button type="submit" loading={submitting} disabled={!valid || submitting}>
        Submit for verification
      </Button>
    </form>
  );
}

export default function SupplierDashboard() {
  const router = useRouter();
  const { notify } = useToast();
  const { checkingSession, user, orders, setOrders, loadingOrders, canBeSupplier, signingOut, handleSignOut } = useSession();

  const [section, setSection] = useState<Section>("overview");
  const [ordersTab, setOrdersTab] = useState<"active" | "history">("active");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [profile, setProfile] = useState<SupplierProfileRow | null>(null);
  const [currentlyVerified, setCurrentlyVerified] = useState(false);
  const [latestApplication, setLatestApplication] = useState<SupplierVerificationApplicationRow | null>(null);
  const [loadingVerification, setLoadingVerification] = useState(true);

  const isSupplier = user?.role === "supplier";

  useEffect(() => {
    if (checkingSession) return;
    if (!user) {
      router.replace("/");
      return;
    }
    if (!canBeSupplier) {
      router.replace("/buyer");
    }
  }, [checkingSession, user, canBeSupplier, router]);

  const loadVerification = () => {
    setLoadingVerification(true);
    fetch("/api/supplier-verification/me")
      .then((res) => res.json())
      .then((data) => {
        setProfile(data.profile);
        setCurrentlyVerified(data.currentlyVerified);
        setLatestApplication(data.latestApplication);
      })
      .catch(() => notify("error", "Failed to load verification status."))
      .finally(() => setLoadingVerification(false));
  };

  useEffect(() => {
    if (!user || !isSupplier) return;
    loadVerification();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isSupplier]);

  const activeOrders = orders.filter((o) => !TERMINAL_STATUSES.has(o.status));
  const historyOrders = orders.filter((o) => TERMINAL_STATUSES.has(o.status));
  const ordersTabbed = ordersTab === "active" ? activeOrders : historyOrders;
  const settledOrders = orders.filter((o) => o.status === "settled");
  const earningsMinor = settledOrders.reduce((acc, o) => acc + (o.amount_minor - o.platform_fee_minor), 0);
  const incomingCount = orders.filter((o) => o.status === "funded" || o.status === "fulfilling").length;

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    { key: "orders", label: "Orders", icon: <FileText size={16} />, active: section === "orders", onClick: () => setSection("orders"), badge: incomingCount },
    {
      key: "verification",
      label: "Verification",
      icon: currentlyVerified ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />,
      active: section === "verification",
      onClick: () => setSection("verification"),
    },
  ];

  if (checkingSession || !user || !canBeSupplier) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 size={22} className="spin-icon text-accent" aria-label="Loading" />
      </div>
    );
  }

  const switchLinks: SwitchLink[] = [
    { label: "Switch to buyer dashboard", href: "/buyer" },
    ...(user.role === "admin" ? [{ label: "Admin dashboard", href: "/admin" }] : []),
  ];

  return (
    <DashboardShell
      activeDashboard="supplier"
      switchLinks={switchLinks}
      navItems={navItems}
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      pageTitle={section === "overview" ? `Supplier portal · @${user.username || "Supplier"}` : section === "orders" ? "Orders" : "Verification"}
      pageSubtitle={section === "overview" ? "Fulfill orders, submit delivery proof, get paid." : undefined}
    >
      {!loadingVerification && isSupplier && !currentlyVerified && section !== "verification" && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-warning-text">
          <span className="flex items-center gap-2">
            <ShieldAlert size={15} /> Your verification isn't currently active — you can't receive new orders until it's renewed.
          </span>
          <Button size="sm" variant="secondary" onClick={() => setSection("verification")}>
            Review
          </Button>
        </div>
      )}

      {section === "overview" && (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Earnings (settled)" value={formatMoney(earningsMinor, "NGN")} icon={<Coins size={16} />} tone="accent" />
            <StatCard label="Incoming orders" value={incomingCount} icon={<FileText size={16} />} />
            <StatCard
              label="Verification"
              value={currentlyVerified ? "Verified" : "Not verified"}
              icon={currentlyVerified ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
            />
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-xl italic text-text-primary">Recent orders</h2>
              <button type="button" onClick={() => setSection("orders")} className="text-sm font-semibold text-accent-text hover:underline">
                View all
              </button>
            </div>
            {loadingOrders ? (
              <div className="flex justify-center py-10">
                <Loader2 size={22} className="spin-icon text-accent" />
              </div>
            ) : orders.length === 0 ? (
              <EmptyState message="No orders yet. They'll show up here as soon as a buyer funds one against your business." />
            ) : (
              <div className="grid gap-3">
                {orders.slice(0, 4).map((o) => (
                  <OrderCard key={o.id} order={o} onOpen={(order) => setSelectedOrderId(order.id)} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {section === "orders" && (
        <div>
          <div className="mb-5 flex w-fit rounded-lg border border-border bg-surface p-1">
            <button
              type="button"
              onClick={() => setOrdersTab("active")}
              className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors duration-base ease-base ${
                ordersTab === "active" ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              Active ({activeOrders.length})
            </button>
            <button
              type="button"
              onClick={() => setOrdersTab("history")}
              className={`flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors duration-base ease-base ${
                ordersTab === "history" ? "bg-accent text-accent-contrast" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              <History size={13} /> History
            </button>
          </div>

          {loadingOrders ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : ordersTabbed.length === 0 ? (
            <EmptyState message={ordersTab === "history" ? "No completed orders yet." : "No active orders right now."} />
          ) : (
            <div className="grid gap-3">
              {ordersTabbed.map((o) => (
                <OrderCard key={o.id} order={o} onOpen={(order) => setSelectedOrderId(order.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "verification" && (
        <div className="flex flex-col gap-6">
          {loadingVerification ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : (
            <>
              <Card className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Status</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone={currentlyVerified ? "success" : "warning"}>{currentlyVerified ? "Verified" : profile?.verification_status || "Unverified"}</Badge>
                      {profile?.verification_expires_at && (
                        <span className="text-xs text-text-tertiary">
                          {currentlyVerified ? "Expires" : "Expired"} {new Date(profile.verification_expires_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  {profile && (
                    <div className="text-right">
                      <div className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">Orders since verification</div>
                      <div className="mt-1 font-display text-xl font-semibold text-text-primary">{profile.orders_since_verification} / 20</div>
                    </div>
                  )}
                </div>
                <p className="mt-4 text-xs leading-relaxed text-text-secondary">
                  Verification is valid for 90 days or 20 orders, whichever comes first — this is a one-time business check, not a
                  per-order visit. Once it expires you can't receive new orders until you're re-verified.
                </p>
              </Card>

              {!currentlyVerified && (
                <div>
                  {latestApplication?.status === "pending" ? (
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
                      <Clock size={15} /> Your verification application is pending admin review.
                    </div>
                  ) : (
                    <>
                      <h3 className="mb-3 font-display text-lg italic text-text-primary">
                        {profile ? "Re-apply for verification" : "Apply for verification"}
                      </h3>
                      <VerificationApplicationForm onSubmitted={loadVerification} />
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {selectedOrderId && (
        <OrderDetailsModal
          orderId={selectedOrderId}
          role="supplier"
          canTransact={isSupplier}
          onClose={() => setSelectedOrderId(null)}
          onOrderChange={(order) => setOrders((prev) => prev.map((o) => (o.id === order.id ? order : o)))}
          showNotification={notify}
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
