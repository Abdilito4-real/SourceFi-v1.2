"use client";

// components/AdminDashboard.tsx
//
// Real route (/admin), Overview, Supplier Verification, Orders
// Disputes, Users. Only reachable if the server-verified role allows it
// (see the redirect guard below); the route existing doesn't grant
// anything, every write here is its own requireRole(["admin"]) check
// server-side (see app/api/admin/*), this is UX only.
//
// "Applications" is repurposed here into "Supplier Verification", same
// admin-review shape (see docs/marketplace-payments-design.md Section F:
// "same card-based review UI as today's ApplicationCard, fields
// swapped"), but approval now creates/updates a real supplier_profiles
// row with a 90-day expiry, not just a role flip (see
// app/api/admin/supplier-verification/[id]/route.ts).
import React, { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LayoutGrid, ShieldCheck, Users as UsersIcon, Check, X, UserCog, FileText, AlertTriangle, Scale, ChevronDown } from "lucide-react";

import { useSession } from "./SessionProvider";
import { cn } from "./ui/cn";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import NotificationBell from "./NotificationBell";
import OrderCard from "./OrderCard";
import OrderDetailsModal from "./OrderDetailsModal";
import StatCard, { StatCardSkeleton } from "./ui/StatCard";
import Badge, { type BadgeTone } from "./ui/Badge";
import Button from "./ui/Button";
import ConfirmDialog from "./ui/ConfirmDialog";
import Modal from "./ui/Modal";
import Select from "./ui/Select";
import { Label, Textarea } from "./ui/Field";
import { Table, Thead, Tbody, Tr, Th, Td } from "./ui/Table";
import SharedEmptyState from "./ui/EmptyState";
import SectionHeader from "./ui/SectionHeader";
import Tabs from "./ui/Tabs";
import CardListSkeleton from "./ui/CardListSkeleton";
import { useToast } from "./ui/Toast";
import { formatMoney, TYPED_CONFIRMATION_THRESHOLD_MINOR } from "../lib/money";
import ErrorPanel from "./ui/ErrorPanel";
import { SUPPORTING_DOCUMENT_TYPES } from "../lib/supplierDocumentTypes";
import type { AdminUserRow, ApplicationStatus, DisputeRow, DisputeRuling, DisputeStatus, LedgerEntryRow, OrderRow, Role, SupplierVerificationApplicationRow } from "../lib/types";

// Reviewing admins see the human-readable label, not the raw stored
// value ("passport", not "national_id") — applications from before
// migration 0023 have no type on file at all, hence the "Document"
// fallback where this Map has no entry.
const SUPPORTING_DOCUMENT_TYPE_LABELS = new Map(SUPPORTING_DOCUMENT_TYPES.map((t) => [t.value, t.label]));

type Section = "overview" | "verification" | "orders" | "disputes" | "ledger" | "users";

// Same shape as OrderDetailsModal.tsx's own (unexported) FinancialError —
// a toast is never the only confirmation of a financial FAILURE, per the
// feedback-layer rule; resolveDispute and retry-release are the two
// admin actions that move real, unbounded amounts of money, and both
// previously only toasted on failure. Not imported from OrderDetailsModal
// (kept local, same small shape) to avoid a cross-component type
// dependency for something this small.
interface AdminFinancialError {
  title: string;
  detail?: string;
  fundPosition: string;
  referenceCode?: string;
}

interface LedgerBalance {
  account: string;
  currency: string;
  net_minor: number;
}

interface FailedReleaseRow {
  orderId: number;
  orderCode: string | null;
  stillStuck: boolean;
  providerState: string;
  errorReason: string | null;
  createdAt: string;
}

const ROLE_TONE: Record<Role, BadgeTone> = {
  buyer: "neutral",
  supplier: "accent",
  admin: "success",
};

type LedgerRangeKey = "all" | "24h" | "7d" | "30d" | "90d";

// Filters "Recent entries" only, never the balances panel above it,
// see the matching comment in app/api/admin/ledger/route.ts, those are
// explicitly all-time net figures.
const LEDGER_RANGE_OPTIONS: { key: LedgerRangeKey; label: string; hours: number | null }[] = [
  { key: "all", label: "All time", hours: null },
  { key: "24h", label: "Last 24 hours", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 24 * 7 },
  { key: "30d", label: "Last 30 days", hours: 24 * 30 },
  { key: "90d", label: "Last 90 days", hours: 24 * 90 },
];

const ALL_ROLES: Role[] = ["buyer", "supplier", "admin"];

export default function AdminDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { notify } = useToast();
  const { checkingSession, user, signingOut, handleSignOut } = useSession();

  const [section, setSection] = useState<Section>("overview");

  const [applications, setApplications] = useState<SupplierVerificationApplicationRow[]>([]);
  const [applicationsStatus, setApplicationsStatus] = useState<ApplicationStatus>("pending");
  const [loadingApplications, setLoadingApplications] = useState(true);
  const [reviewingId, setReviewingId] = useState<number | null>(null);

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [changingRoleId, setChangingRoleId] = useState<number | null>(null);
  const [suspendingTarget, setSuspendingTarget] = useState<AdminUserRow | null>(null);
  const [suspendReason, setSuspendReason] = useState("");
  const [suspendBusy, setSuspendBusy] = useState(false);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  // Production-hardening pass: an order stuck at release_submitted after
  // a real Circle release attempt failed (missing supplier wallet, no
  // USDC balance, ...) needs this explicit admin retry, see
  // app/api/admin/orders/[id]/retry-release/route.ts.
  const [retryReleaseOrder, setRetryReleaseOrder] = useState<OrderRow | null>(null);
  const [retryReleaseBusy, setRetryReleaseBusy] = useState(false);
  const [retryReleaseError, setRetryReleaseError] = useState<AdminFinancialError | null>(null);

  const [disputes, setDisputes] = useState<(DisputeRow & { order: Pick<OrderRow, "id" | "order_code" | "status" | "amount_minor"> | null; raised_by_email: string | null })[]>([]);
  const [disputesStatus, setDisputesStatus] = useState<DisputeStatus>("open");
  const [loadingDisputes, setLoadingDisputes] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  const [ledgerEntries, setLedgerEntries] = useState<(LedgerEntryRow & { order_code: string | null })[]>([]);
  const [ledgerBalances, setLedgerBalances] = useState<LedgerBalance[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(true);
  const [ledgerPaymentMode, setLedgerPaymentMode] = useState<{ ngnLive: boolean; usdcLive: boolean } | null>(null);
  const [failedReleases, setFailedReleases] = useState<FailedReleaseRow[]>([]);
  // Collapsed by default: a real, actionable alert (something needs a
  // manual retry), so it stays visible as a header the moment there's
  // anything to show, but doesn't permanently eat vertical space above
  // the balances/entries an admin more often actually came here for.
  const [failedReleasesOpen, setFailedReleasesOpen] = useState(false);
  const [ledgerRange, setLedgerRange] = useState<LedgerRangeKey>("all");

  const isAdmin = user?.role === "admin";

  // Push notificationclick deep-links here as e.g. /admin?order=482 (a
  // dispute-related push, since admins otherwise have no per-order URL).
  useEffect(() => {
    const orderParam = searchParams.get("order");
    if (orderParam && Number.isInteger(Number(orderParam))) setSelectedOrderId(Number(orderParam));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (checkingSession) return;
    if (!user) {
      router.replace("/");
      return;
    }
    if (!isAdmin) {
      // Same class of bug fixed in RootGate/BuyerDashboard: a supplier
      // hitting /admin directly must land on /supplier, not /buyer, a
      // supplier account has no buyer access at all.
      router.replace(user.role === "supplier" ? "/supplier" : "/buyer");
    }
  }, [checkingSession, user, isAdmin, router]);

  const loadApplications = useCallback(
    async (status: ApplicationStatus) => {
      setLoadingApplications(true);
      try {
        const res = await fetch(`/api/admin/supplier-verification?status=${status}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load applications.");
        setApplications(data.applications || []);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to load applications.");
      } finally {
        setLoadingApplications(false);
      }
    },
    [notify]
  );

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load users.");
      setUsers(data.users || []);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to load users.");
    } finally {
      setLoadingUsers(false);
    }
  }, [notify]);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const res = await fetch("/api/orders");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load orders.");
      setOrders(data.orders || []);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to load orders.");
    } finally {
      setLoadingOrders(false);
    }
  }, [notify]);

  const loadDisputes = useCallback(
    async (status: DisputeStatus) => {
      setLoadingDisputes(true);
      try {
        const res = await fetch(`/api/admin/disputes?status=${status}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load disputes.");
        setDisputes(data.disputes || []);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to load disputes.");
      } finally {
        setLoadingDisputes(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    if (!isAdmin) return;
    loadApplications(applicationsStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, applicationsStatus]);

  useEffect(() => {
    if (!isAdmin) return;
    loadUsers();
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    loadDisputes(disputesStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, disputesStatus]);

  const loadLedger = useCallback(
    async (rangeKey: LedgerRangeKey) => {
      setLoadingLedger(true);
      try {
        const range = LEDGER_RANGE_OPTIONS.find((o) => o.key === rangeKey);
        const qs = new URLSearchParams();
        if (range?.hours) qs.set("from", new Date(Date.now() - range.hours * 60 * 60 * 1000).toISOString());
        const res = await fetch(`/api/admin/ledger${qs.toString() ? `?${qs.toString()}` : ""}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load ledger.");
        setLedgerEntries(data.entries || []);
        setLedgerBalances(data.balances || []);
        setLedgerPaymentMode(data.paymentMode || null);
        setFailedReleases(data.failedReleases || []);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to load ledger.");
      } finally {
        setLoadingLedger(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    if (!isAdmin || section !== "ledger") return;
    loadLedger(ledgerRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, section, ledgerRange]);

  const handleReview = async (application: SupplierVerificationApplicationRow, action: "approve" | "reject") => {
    setReviewingId(application.id);
    try {
      const res = await fetch(`/api/admin/supplier-verification/${application.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to review application.");
      setApplications((rows) => rows.filter((r) => r.id !== application.id));
      notify(
        "success",
        action === "approve"
          ? `${application.applicant_username ? "@" + application.applicant_username : application.applicant_email} is now a verified supplier.`
          : "Application rejected."
      );
      if (action === "approve") loadUsers();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to review application.");
    } finally {
      setReviewingId(null);
    }
  };

  const handleRoleChange = async (target: AdminUserRow, nextRole: Role) => {
    if (nextRole === target.role) return;
    setChangingRoleId(target.id);
    try {
      const res = await fetch(`/api/admin/users/${target.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to change role.");
      setUsers((rows) => rows.map((u) => (u.id === target.id ? { ...u, role: nextRole } : u)));
      notify("success", `${target.username ? "@" + target.username : target.email} is now ${nextRole}.`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to change role.");
    } finally {
      setChangingRoleId(null);
    }
  };

  // Prompt 3, flow 10 / Decision 9, suspends/unsuspends a supplier.
  // Blocks new orders immediately (createOrder's check); existing
  // in-flight orders are deliberately untouched (see suspendSupplier's
  // doc comment), this action doesn't cancel or refund anything on its
  // own.
  const handleUnsuspend = async (target: AdminUserRow) => {
    setSuspendBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${target.id}/suspend`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unsuspend" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to reinstate account.");
      setUsers((rows) => rows.map((u) => (u.id === target.id ? { ...u, suspended_at: null } : u)));
      notify("success", `${target.username ? "@" + target.username : target.email} is reinstated.`);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to reinstate account.");
    } finally {
      setSuspendBusy(false);
    }
  };

  const handleConfirmSuspend = async () => {
    if (!suspendingTarget || !suspendReason.trim()) return;
    setSuspendBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${suspendingTarget.id}/suspend`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "suspend", reason: suspendReason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to suspend account.");
      setUsers((rows) => rows.map((u) => (u.id === suspendingTarget.id ? { ...u, suspended_at: new Date().toISOString() } : u)));
      notify("success", `${suspendingTarget.username ? "@" + suspendingTarget.username : suspendingTarget.email} is suspended.`);
      setSuspendingTarget(null);
      setSuspendReason("");
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to suspend account.");
    } finally {
      setSuspendBusy(false);
    }
  };

  const handleConfirmRetryRelease = async () => {
    if (!retryReleaseOrder) return;
    setRetryReleaseError(null);
    setRetryReleaseBusy(true);
    try {
      const res = await fetch(`/api/admin/orders/${retryReleaseOrder.id}/retry-release`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        // Persistent ErrorPanel, not just a toast — this retries a real
        // escrow release, same standard OrderDetailsModal's
        // runFinancialAction already holds fund/cancel/abandon to.
        setRetryReleaseError({
          title: data.error || "Failed to retry the release.",
          fundPosition: "Funds are still safely held in escrow, nothing was lost.",
          referenceCode: data.referenceCode,
        });
        return;
      }
      setOrders((rows) => rows.map((o) => (o.id === retryReleaseOrder.id ? data.order : o)));
      notify("success", `Retry sent for order ${retryReleaseOrder.order_code}.`);
      setRetryReleaseOrder(null);
    } catch {
      setRetryReleaseError({
        title: "Couldn't reach the server.",
        detail: "Check your connection and try again.",
        fundPosition: "Funds are still safely held in escrow, nothing was lost.",
      });
    } finally {
      setRetryReleaseBusy(false);
    }
  };

  // Returns a result instead of only toasting, so DisputeCard (which owns
  // the ConfirmDialog this fires from) can render a persistent
  // ErrorPanel on failure — this ruling can trigger a real, unbounded
  // refund or release (lib/orderService.ts's resolveDispute), a toast
  // alone doesn't meet the bar fund/cancel/abandon/retry-release hold
  // themselves to for that.
  const handleResolveDispute = async (
    disputeId: number,
    ruling: DisputeRuling,
    notes: string
  ): Promise<{ success: true } | { success: false; error: AdminFinancialError }> => {
    setResolvingId(disputeId);
    try {
      const res = await fetch(`/api/admin/disputes/${disputeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruling, notes }),
      });
      const data = await res.json();
      if (!res.ok) {
        return {
          success: false,
          error: {
            title: data.error || "Failed to resolve dispute.",
            fundPosition: "Nothing has changed — no refund or release was triggered.",
            referenceCode: data.referenceCode,
          },
        };
      }
      setDisputes((rows) => rows.filter((d) => d.id !== disputeId));
      const actionNote =
        data.autoActionTaken === "refund_initiated"
          ? " Refund initiated."
          : data.autoActionTaken === "release_initiated"
          ? " Release initiated."
          : " Ruling recorded. No automatic fund movement (order already settled or outside the pre-release window).";
      notify("success", `Dispute resolved for the ${ruling}.${actionNote}`);
      return { success: true };
    } catch {
      return {
        success: false,
        error: {
          title: "Couldn't reach the server.",
          detail: "Check your connection and try again.",
          fundPosition: "Nothing has changed — no refund or release was triggered.",
        },
      };
    } finally {
      setResolvingId(null);
    }
  };

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    {
      key: "verification",
      label: "Supplier verification",
      icon: <ShieldCheck size={16} />,
      active: section === "verification",
      onClick: () => setSection("verification"),
      badge: applicationsStatus === "pending" ? applications.length : undefined,
    },
    { key: "orders", label: "Orders", icon: <FileText size={16} />, active: section === "orders", onClick: () => setSection("orders") },
    {
      key: "disputes",
      label: "Disputes",
      icon: <AlertTriangle size={16} />,
      active: section === "disputes",
      onClick: () => setSection("disputes"),
      badge: disputesStatus === "open" ? disputes.length : undefined,
    },
    { key: "ledger", label: "Ledger", icon: <Scale size={16} />, active: section === "ledger", onClick: () => setSection("ledger") },
    { key: "users", label: "Users", icon: <UsersIcon size={16} />, active: section === "users", onClick: () => setSection("users") },
  ];

  if (checkingSession || !user || !isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 size={22} className="spin-icon text-accent" aria-label="Loading" />
      </div>
    );
  }

  const switchLinks: SwitchLink[] = [
    { label: "Switch to buyer dashboard", href: "/buyer" },
    { label: "Switch to supplier dashboard", href: "/supplier" },
  ];

  const supplierCount = users.filter((u) => u.role === "supplier").length;
  const buyerCount = users.filter((u) => u.role === "buyer").length;

  return (
    <DashboardShell
      activeDashboard="admin"
      switchLinks={switchLinks}
      navItems={navItems}
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      notificationBell={<NotificationBell />}
      pageTitle={
        section === "overview"
          ? "Admin overview"
          : section === "verification"
          ? "Supplier verification"
          : section === "orders"
          ? "Orders"
          : section === "disputes"
          ? "Disputes"
          : section === "ledger"
          ? "Ledger"
          : "Users"
      }
      pageSubtitle={
        section === "overview"
          ? "Verify suppliers, resolve disputes, and manage account access."
          : section === "verification"
          ? "Review who's applying for one-time business verification."
          : section === "orders"
          ? "Full-platform order visibility."
          : section === "disputes"
          ? "Buyer-raised issues, before and after settlement."
          : section === "ledger"
          ? "The double-entry record behind every order. Every account should net to what you'd expect."
          : "Every account on SourceFi and its current role."
      }
    >
      {section === "overview" && (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <StatCard
              label="Pending verifications"
              value={applicationsStatus === "pending" ? applications.length : "—"}
              icon={<ShieldCheck size={16} />}
              tone="accent"
              hint={applicationsStatus === "pending" ? undefined : "Switch to Verification to view"}
            />
            <StatCard label="Open disputes" value={disputesStatus === "open" ? disputes.length : "—"} icon={<AlertTriangle size={16} />} />
            {loadingUsers ? (
              <>
                <StatCardSkeleton />
                <StatCardSkeleton />
              </>
            ) : (
              <>
                <StatCard label="Suppliers" value={supplierCount} icon={<UserCog size={16} />} />
                <StatCard label="Buyers" value={buyerCount} icon={<UsersIcon size={16} />} />
              </>
            )}
          </div>

          <div>
            <SectionHeader
              title="Pending verification applications"
              action={
                <button type="button" onClick={() => setSection("verification")} className="text-sm font-semibold text-accent-text hover:underline">
                  View all
                </button>
              }
            />
            {loadingApplications ? (
              <CardListSkeleton rows={3} />
            ) : applications.length === 0 ? (
              <SharedEmptyState title="No pending applications right now" description="New supplier verification requests show up here for review." />
            ) : (
              <div className="grid gap-3">
                {applications.slice(0, 3).map((a) => (
                  <ApplicationCard key={a.id} application={a} reviewing={reviewingId === a.id} onReview={handleReview} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {section === "verification" && (
        <div>
          <Tabs
            className="mb-5"
            active={applicationsStatus}
            onChange={(key) => setApplicationsStatus(key as ApplicationStatus)}
            items={(["pending", "approved", "rejected"] as ApplicationStatus[]).map((s) => ({ key: s, label: s }))}
          />

          {loadingApplications ? (
            <CardListSkeleton rows={4} />
          ) : applications.length === 0 ? (
            <SharedEmptyState title={`No ${applicationsStatus} applications`} />
          ) : (
            <div className="grid gap-3">
              {applications.map((a) => (
                <ApplicationCard
                  key={a.id}
                  application={a}
                  reviewing={reviewingId === a.id}
                  onReview={applicationsStatus === "pending" ? handleReview : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "orders" && (
        <div>
          {!loadingOrders && orders.some((o) => o.status === "release_submitted") && (
            <div className="mb-4 flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2.5 text-sm text-warning-text">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  {orders.filter((o) => o.status === "release_submitted").length} order(s) stuck at &ldquo;release
                  submitted&rdquo; — a prior escrow release attempt failed. Funds are still safely held in escrow.
                  Fix the underlying issue (e.g. the supplier&rsquo;s wallet address) if needed, then retry.
                </span>
              </div>
              <div className="flex flex-wrap gap-2 pl-6">
                {orders
                  .filter((o) => o.status === "release_submitted")
                  .map((o) => (
                    <Button key={o.id} size="sm" variant="secondary" onClick={() => setRetryReleaseOrder(o)}>
                      Retry {o.order_code}
                    </Button>
                  ))}
              </div>
            </div>
          )}
          {loadingOrders ? (
            <CardListSkeleton rows={4} />
          ) : orders.length === 0 ? (
            <SharedEmptyState title="No orders on the platform yet" description="Orders appear here as soon as a buyer creates one." />
          ) : (
            <div className="grid gap-3">
              {orders.map((o) => (
                <OrderCard key={o.id} order={o} onOpen={(order) => setSelectedOrderId(order.id)} />
              ))}
            </div>
          )}

          {retryReleaseError && (
            <ErrorPanel
              title={retryReleaseError.title}
              detail={retryReleaseError.detail}
              fundPosition={retryReleaseError.fundPosition}
              referenceCode={retryReleaseError.referenceCode}
              retrying={retryReleaseBusy}
              onRetry={handleConfirmRetryRelease}
              onDismiss={() => setRetryReleaseError(null)}
              className="mb-3"
            />
          )}
          <ConfirmDialog
            open={retryReleaseOrder !== null}
            title="Retry escrow release"
            body={
              <p>
                Retry sending order <strong>{retryReleaseOrder?.order_code}</strong>&rsquo;s{" "}
                <strong>{retryReleaseOrder ? formatMoney(retryReleaseOrder.amount_minor, "NGN") : ""}</strong> escrow
                release to Circle. Safe to click even if a prior attempt partially went through, this uses the same
                idempotency key every time, it cannot pay the supplier twice.
              </p>
            }
            confirmLabel="Retry release"
            loading={retryReleaseBusy}
            requireTypedConfirmation={
              retryReleaseOrder && retryReleaseOrder.amount_minor >= TYPED_CONFIRMATION_THRESHOLD_MINOR
                ? formatMoney(retryReleaseOrder.amount_minor, "NGN")
                : undefined
            }
            onConfirm={handleConfirmRetryRelease}
            onCancel={() => setRetryReleaseOrder(null)}
          />
        </div>
      )}

      {section === "disputes" && (
        <div>
          <Tabs
            className="mb-5"
            active={disputesStatus}
            onChange={(key) => setDisputesStatus(key as DisputeStatus)}
            items={(["open", "under_review", "resolved_buyer", "resolved_supplier", "resolved_split"] as DisputeStatus[]).map((s) => ({
              key: s,
              label: s.replace("_", " "),
            }))}
          />

          {loadingDisputes ? (
            <CardListSkeleton rows={3} />
          ) : disputes.length === 0 ? (
            <SharedEmptyState title={`No ${disputesStatus.replace("_", " ")} disputes`} />
          ) : (
            <div className="grid gap-3">
              {disputes.map((d) => (
                <DisputeCard
                  key={d.id}
                  dispute={d}
                  resolving={resolvingId === d.id}
                  onResolve={disputesStatus === "open" || disputesStatus === "under_review" ? handleResolveDispute : undefined}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "ledger" && (
        <div className="flex flex-col gap-6">
          {loadingLedger ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : (
            <>
              {ledgerPaymentMode && (
                <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2.5 text-xs text-warning-text">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {ledgerPaymentMode.ngnLive
                      ? "NGN funding/refund is live via Yellow Card (bank transfer only). Settlement is still simulated, no integration exists for that leg yet."
                      : "NGN funding/refund (Yellow Card) is simulated until its credentials are configured."}{" "}
                    {ledgerPaymentMode.usdcLive
                      ? "USDC escrow release is live via Circle."
                      : "USDC escrow release is simulated too, until Circle credentials are configured."}
                  </span>
                </div>
              )}

              {failedReleases.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-danger bg-danger-soft">
                  <button
                    type="button"
                    onClick={() => setFailedReleasesOpen((v) => !v)}
                    aria-expanded={failedReleasesOpen}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-danger-text">
                      <AlertTriangle size={15} className="shrink-0" />
                      Recent failed releases
                      <span className="rounded-pill bg-danger px-2 py-0.5 text-[10px] font-bold text-white">{failedReleases.length}</span>
                    </span>
                    <ChevronDown
                      size={16}
                      className={cn("shrink-0 text-danger-text transition-transform duration-base ease-base", failedReleasesOpen && "rotate-180")}
                    />
                  </button>
                  {failedReleasesOpen && (
                    <div className="border-t border-danger px-4 pb-4 pt-3">
                      {/* A table, not a repeated bordered-box-per-row
                          list: that version scaled badly, "A later
                          attempt already went through" repeated in full
                          on every resolved row made a handful of entries
                          read as a wall of text. Table.tsx's own
                          overflow-x-auto wrapper keeps this from forcing
                          the page to scroll sideways on a narrow screen,
                          it scrolls internally instead. */}
                      <Table>
                        <Thead>
                          <Tr>
                            <Th>Order</Th>
                            <Th>Issue</Th>
                            <Th>When</Th>
                            <Th>Status</Th>
                          </Tr>
                        </Thead>
                        <Tbody>
                          {failedReleases.map((f) => (
                            <Tr key={`${f.orderId}:${f.createdAt}`}>
                              <Td className="font-mono text-xs">{f.orderCode || `#${f.orderId}`}</Td>
                              <Td className="text-danger-text">
                                {f.providerState}
                                {f.errorReason ? `: ${f.errorReason}` : ""}
                              </Td>
                              <Td className="text-text-secondary">{new Date(f.createdAt).toLocaleString()}</Td>
                              <Td>
                                {f.stillStuck ? (
                                  <Button size="sm" variant="secondary" onClick={() => setSection("orders")}>
                                    Go retry it
                                  </Button>
                                ) : (
                                  <span className="text-xs text-text-tertiary">Already resolved</span>
                                )}
                              </Td>
                            </Tr>
                          ))}
                        </Tbody>
                      </Table>
                    </div>
                  )}
                </div>
              )}

              <div>
                <SectionHeader title="Account balances (all-time, net)" size="sm" />
                {ledgerBalances.length === 0 ? (
                  <SharedEmptyState title="No ledger activity yet" description="Entries appear once an order reaches funded." />
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {ledgerBalances.map((b) => (
                      <div key={`${b.account}:${b.currency}`} className="rounded-lg border border-border bg-surface p-3">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">{b.account.replace(/_/g, " ")}</div>
                        <div className="mt-1 font-mono text-sm font-semibold text-text-primary">
                          {(b.net_minor / 100).toLocaleString()} {b.currency}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <SectionHeader
                  title="Recent entries"
                  size="sm"
                  action={
                    <div className="flex items-center gap-2">
                      <Select
                        aria-label="Filter recent entries by time range"
                        value={ledgerRange}
                        onChange={(e) => setLedgerRange(e.target.value as LedgerRangeKey)}
                        className="w-auto py-1.5 pr-8 text-xs"
                      >
                        {LEDGER_RANGE_OPTIONS.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                      {ledgerRange !== "all" && (
                        <Button size="sm" variant="ghost" onClick={() => setLedgerRange("all")}>
                          Clear
                        </Button>
                      )}
                    </div>
                  }
                />
                {ledgerEntries.length === 0 ? (
                  <SharedEmptyState
                    title="No ledger entries yet"
                    description={ledgerRange !== "all" ? "Nothing in this time range. Try a wider one, or clear the filter." : undefined}
                  />
                ) : (
                  <Table>
                    <Thead>
                      <Tr>
                        <Th>Order</Th>
                        <Th>Account</Th>
                        <Th>Direction</Th>
                        <Th>Amount</Th>
                        <Th>Txn</Th>
                        <Th>When</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {ledgerEntries.map((e) => (
                        <Tr key={e.id}>
                          <Td className="font-mono text-xs">{e.order_code || `#${e.order_id}`}</Td>
                          <Td>{e.account.replace(/_/g, " ")}</Td>
                          <Td>
                            <Badge tone={e.direction === "debit" ? "accent" : "neutral"}>{e.direction}</Badge>
                          </Td>
                          <Td>
                            {(e.amount_minor / 100).toLocaleString()} {e.currency}
                          </Td>
                          <Td className="font-mono text-[10px] text-text-tertiary" title={e.ledger_transaction_id}>
                            {e.ledger_transaction_id.slice(0, 8)}…
                          </Td>
                          <Td className="text-text-secondary">{new Date(e.created_at).toLocaleString()}</Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {section === "users" && (
        <div>
          {loadingUsers ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : users.length === 0 ? (
            <SharedEmptyState title="No users found" />
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>User</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Joined</Th>
                  <Th>Change role</Th>
                  <Th>Account</Th>
                </Tr>
              </Thead>
              <Tbody>
                {users.map((u) => (
                  <Tr key={u.id}>
                    <Td className="font-semibold">{u.username ? `@${u.username}` : "—"}</Td>
                    <Td className="text-text-secondary">{u.email}</Td>
                    <Td>
                      <Badge tone={ROLE_TONE[u.role]}>{u.role}</Badge>
                    </Td>
                    <Td>
                      {u.suspended_at ? <Badge tone="danger">Suspended</Badge> : <Badge tone="success">Active</Badge>}
                    </Td>
                    <Td className="text-text-secondary">{new Date(u.created_at).toLocaleDateString()}</Td>
                    <Td>
                      {u.email === user.identity ? (
                        <span className="text-xs text-text-tertiary">This is you</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Select
                            value={u.role}
                            disabled={changingRoleId === u.id}
                            onChange={(e) => handleRoleChange(u, e.target.value as Role)}
                            className="w-32 py-1.5 text-xs"
                          >
                            {ALL_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </Select>
                          {changingRoleId === u.id && <Loader2 size={14} className="spin-icon text-accent" />}
                        </div>
                      )}
                    </Td>
                    <Td>
                      {u.role === "supplier" && u.email !== user.identity && (
                        u.suspended_at ? (
                          <Button size="sm" variant="secondary" loading={suspendBusy} onClick={() => handleUnsuspend(u)}>
                            Reinstate
                          </Button>
                        ) : (
                          <Button size="sm" variant="danger" onClick={() => setSuspendingTarget(u)}>
                            Suspend
                          </Button>
                        )
                      )}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}

          <ConfirmDialog
            open={suspendingTarget !== null}
            tone="danger"
            title="Suspend supplier account"
            body={
              <>
                <p>
                  <strong>{suspendingTarget?.username ? "@" + suspendingTarget.username : suspendingTarget?.email}</strong>{" "}
                  won&rsquo;t be able to receive new orders. Their existing in-flight orders are NOT affected, they
                  continue normally.
                </p>
                <div className="mt-3">
                  <Label htmlFor="suspend-reason">Reason (required)</Label>
                  <Textarea id="suspend-reason" value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} required />
                </div>
              </>
            }
            confirmLabel="Suspend account"
            loading={suspendBusy}
            confirmDisabled={!suspendReason.trim()}
            onConfirm={handleConfirmSuspend}
            onCancel={() => {
              setSuspendingTarget(null);
              setSuspendReason("");
            }}
          />
        </div>
      )}

      {selectedOrderId && (
        <OrderDetailsModal
          orderId={selectedOrderId}
          role="admin"
          canTransact={false}
          onClose={() => setSelectedOrderId(null)}
          onOrderChange={(order) => setOrders((prev) => prev.map((o) => (o.id === order.id ? order : o)))}
          showNotification={notify}
        />
      )}
    </DashboardShell>
  );
}

function ApplicationCard({
  application,
  reviewing,
  onReview,
}: {
  application: SupplierVerificationApplicationRow;
  reviewing: boolean;
  onReview?: (application: SupplierVerificationApplicationRow, action: "approve" | "reject") => void;
}) {
  // "View" used to navigate away to the raw Cloudinary URL in a new tab
  // — an admin reviewing several applications in a row shouldn't lose
  // this page's scroll position/context for that. Same in-app preview
  // pattern as SupplierDashboard's material-listing photo preview.
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <UserCog size={15} className="text-text-tertiary" />
            <span className="font-semibold text-text-primary">{application.business_name}</span>
          </div>
          <div className="mt-0.5 text-xs text-text-tertiary">
            {application.applicant_username ? `@${application.applicant_username}` : application.applicant_email}
          </div>
        </div>
        <span className="text-xs text-text-tertiary">{new Date(application.created_at).toLocaleDateString()}</span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Phone</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{application.phone || "Not provided"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Location</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{application.business_location || "Not specified"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">CAC number</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{application.cac_registration_number || "Not provided"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Tax ID number</dt>
          <dd className="mt-0.5 text-sm text-text-primary">{application.tax_id_number || "Not provided"}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Supporting document</dt>
          <dd className="mt-0.5 text-sm text-text-primary">
            {application.supporting_document_url ? (
              <>
                {SUPPORTING_DOCUMENT_TYPE_LABELS.get(application.supporting_document_type || "") ?? "Document"}
                {" — "}
                <button type="button" onClick={() => setPreviewOpen(true)} className="text-accent-text underline">
                  View
                </button>
              </>
            ) : (
              "Not provided"
            )}
          </dd>
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">What they sell</dt>
          <dd className="mt-0.5 text-sm leading-relaxed text-text-primary">{application.what_they_sell || "Not specified"}</dd>
        </div>
      </dl>

      {onReview && (
        <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
          <Button size="sm" variant="primary" loading={reviewing} onClick={() => onReview(application, "approve")}>
            <Check size={14} /> Approve
          </Button>
          <Button size="sm" variant="secondary" disabled={reviewing} onClick={() => onReview(application, "reject")}>
            <X size={14} /> Reject
          </Button>
        </div>
      )}

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} size="lg">
        {application.supporting_document_url && (
          // eslint-disable-next-line @next/next/no-img-element -- a
          // Cloudinary URL, not a local Next.js image asset.
          <img src={application.supporting_document_url} alt="" className="max-h-[75dvh] w-full rounded-lg object-contain" />
        )}
      </Modal>
    </div>
  );
}

function DisputeCard({
  dispute,
  resolving,
  onResolve,
}: {
  dispute: DisputeRow & { order: Pick<OrderRow, "id" | "order_code" | "status" | "amount_minor"> | null; raised_by_email: string | null };
  resolving: boolean;
  onResolve?: (disputeId: number, ruling: DisputeRuling, notes: string) => Promise<{ success: true } | { success: false; error: AdminFinancialError }>;
}) {
  const [notes, setNotes] = useState("");
  // A ruling can trigger a REAL refund or release (see
  // lib/orderService.ts's resolveDispute, "if the order is still
  // pre-release, this auto-fires the payment boundary") with zero
  // confirmation before this fix, exactly the gap flagged after the
  // feedback-layer pass: financial/irreversible actions need explicit
  // confirmation with the exact amount, same as OrderDetailsModal.
  const [pendingRuling, setPendingRuling] = useState<DisputeRuling | null>(null);
  // Owned locally, not lifted to the parent: only this card's own
  // resolve attempt can produce this error, same "component owns what
  // only it needs" posture as ApplicationCard's previewOpen above.
  const [resolveError, setResolveError] = useState<AdminFinancialError | null>(null);
  // Survives the dialog closing (unlike pendingRuling, which the
  // ConfirmDialog's own open state is keyed on) — this is what
  // ErrorPanel's Retry button re-fires with, since by the time it's
  // clicked the dialog has already closed and pendingRuling is null.
  const [lastRuling, setLastRuling] = useState<DisputeRuling | null>(null);

  const attemptResolve = async (ruling: DisputeRuling) => {
    if (!onResolve) return;
    setLastRuling(ruling);
    setResolveError(null);
    const result = await onResolve(dispute.id, ruling, notes);
    if (!result.success) setResolveError(result.error);
  };

  const confirmResolve = async () => {
    if (!pendingRuling) return;
    const ruling = pendingRuling;
    // Same pattern as OrderDetailsModal's runCancel/runAbandon: the
    // dialog always closes, success or fail — the ErrorPanel below is
    // what persists on failure, not the dialog itself.
    setPendingRuling(null);
    await attemptResolve(ruling);
  };

  return (
    <div
      className={`rounded-xl border border-l-4 border-border bg-surface p-5 ${
        dispute.dispute_type === "post_settlement_report" ? "border-l-warning" : "border-l-danger"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={dispute.dispute_type === "post_settlement_report" ? "warning" : "danger"}>
              {dispute.dispute_type === "post_settlement_report" ? "Post-settlement report" : "Pre-approval rejection"}
            </Badge>
            <span className="text-sm font-semibold text-text-primary">{dispute.order?.order_code || `Order #${dispute.order_id}`}</span>
          </div>
          <div className="mt-1 text-xs text-text-tertiary">
            Raised by {dispute.raised_by_email || "—"} · {dispute.category.replace(/_/g, " ")} ·{" "}
            {dispute.order ? formatMoney(dispute.order.amount_minor, "NGN") : ""}
          </div>
        </div>
        <span className="text-xs text-text-tertiary">{new Date(dispute.created_at).toLocaleDateString()}</span>
      </div>

      {dispute.description && <p className="mt-3 text-sm leading-relaxed text-text-secondary">{dispute.description}</p>}

      {onResolve && (
        <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
          <Textarea placeholder="Resolution notes (required)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={!notes.trim()} onClick={() => setPendingRuling("buyer")}>
              Rule for buyer
            </Button>
            <Button size="sm" variant="secondary" disabled={!notes.trim()} onClick={() => setPendingRuling("supplier")}>
              Rule for supplier
            </Button>
          </div>
          {resolveError && (
            <ErrorPanel
              title={resolveError.title}
              detail={resolveError.detail}
              fundPosition={resolveError.fundPosition}
              referenceCode={resolveError.referenceCode}
              retrying={resolving}
              onRetry={lastRuling ? () => attemptResolve(lastRuling) : undefined}
              onDismiss={() => setResolveError(null)}
            />
          )}
          <ConfirmDialog
            open={pendingRuling !== null}
            tone="danger"
            title="Confirm ruling"
            body={
              <>
                Ruling for the <strong>{pendingRuling}</strong>
                {dispute.order && (
                  <>
                    {" "}
                    can move <strong>{formatMoney(dispute.order.amount_minor, "NGN")}</strong>
                  </>
                )}{" "}
                If this order&rsquo;s funds are still in escrow, ruling for the{" "}
                {pendingRuling === "buyer" ? "buyer triggers a refund" : "supplier triggers a release"} automatically.
                This can&rsquo;t be undone once the transfer confirms.
              </>
            }
            confirmLabel={`Yes, rule for the ${pendingRuling ?? ""}`}
            loading={resolving}
            requireTypedConfirmation={
              dispute.order && dispute.order.amount_minor >= TYPED_CONFIRMATION_THRESHOLD_MINOR
                ? formatMoney(dispute.order.amount_minor, "NGN")
                : undefined
            }
            onConfirm={confirmResolve}
            onCancel={() => setPendingRuling(null)}
          />
        </div>
      )}
    </div>
  );
}

