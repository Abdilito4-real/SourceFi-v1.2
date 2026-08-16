"use client";

// components/BuyerDashboard.tsx
//
// Real route (/buyer) — Overview, Suppliers, Orders, Materials.
// Marketplace pivot: no more "post a request and a sourcer claims it" —
// the buyer picks a currently-verified supplier directly and creates an
// order against them (design doc Section 0). No wallet/crypto UI
// anywhere here — Fund Order is a single button, NGN in, NGN shown
// (design doc Section 3).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Info, Coins, Package, LayoutGrid, FileText, History, Store, ShieldCheck, XCircle, Search } from "lucide-react";

import { formatMoney } from "../lib/money";
import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import OrderCard from "./OrderCard";
import OrderDetailsModal from "./OrderDetailsModal";
import SupplierVerificationForm from "./SupplierVerificationForm";
import Button from "./ui/Button";
import { Card } from "./ui/Card";
import Modal from "./ui/Modal";
import StatCard from "./ui/StatCard";
import { Label, Input, Textarea } from "./ui/Field";
import { useToast } from "./ui/Toast";
import type { OrderRow, SupplierListingRow, SupplierVerificationApplicationRow } from "../lib/types";

type Section = "overview" | "suppliers" | "orders" | "materials";

interface SupplierListing {
  id: number;
  business_name: string;
  business_location: string;
  what_they_sell: string;
  rating_average: number | null;
  rating_count: number;
}

const TERMINAL_STATUSES = new Set(["settled", "refunded", "cancelled", "expired"]);

function MaterialListingCard({ listing, onOrder }: { listing: SupplierListingRow; onOrder: (listing: SupplierListingRow) => void }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft">
          <Package size={20} className="text-accent-text" />
        </div>
        {listing.category && <span className="rounded bg-accent-soft px-2 py-1 text-[10.5px] font-bold leading-tight text-accent-text">{listing.category}</span>}
      </div>
      <div>
        <h3 className="mb-1 font-display text-lg italic leading-tight text-text-primary">{listing.name}</h3>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary">
          {listing.supplier_business_name} · {listing.supplier_business_location}
        </div>
        {listing.description && <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{listing.description}</p>}
      </div>
      <div className="mt-auto flex items-center justify-between pt-1">
        <span className="text-sm font-semibold text-text-secondary">
          {listing.price_minor ? `${formatMoney(listing.price_minor, "NGN")}${listing.unit ? ` ${listing.unit}` : ""}` : "Price on request"}
        </span>
        <Button size="sm" onClick={() => onOrder(listing)}>
          Order
        </Button>
      </div>
    </Card>
  );
}

function SupplierCard({ supplier, onOrder }: { supplier: SupplierListing; onOrder: (s: SupplierListing) => void }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
          <Store size={18} />
        </div>
        <span className="flex items-center gap-1 rounded-pill bg-success-soft px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-success-text">
          <ShieldCheck size={11} /> Verified
        </span>
      </div>
      <div>
        <h3 className="font-display text-lg italic leading-tight text-text-primary">{supplier.business_name}</h3>
        <div className="mt-0.5 text-xs text-text-tertiary">{supplier.business_location}</div>
      </div>
      <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{supplier.what_they_sell}</p>
      <div className="mt-auto flex items-center justify-between pt-1">
        <span className="text-xs font-semibold text-text-secondary">
          {supplier.rating_count > 0 ? `★ ${supplier.rating_average?.toFixed(1)} (${supplier.rating_count})` : "No ratings yet"}
        </span>
        <Button size="sm" onClick={() => onOrder(supplier)}>
          Create order
        </Button>
      </div>
    </Card>
  );
}

interface NewOrderModalProps {
  onClose: () => void;
  onSubmit: (form: {
    supplierId: number;
    supplierListingId?: number | null;
    title: string;
    amount: string;
    deliveryLocation: string;
    quantity: string;
    description: string;
  }) => void | Promise<void>;
  supplier: SupplierListing;
  /** Set when the buyer got here by ordering a specific listing from
   * search/browse, rather than starting from the supplier directory —
   * prefills title/amount and links the order back to that listing. */
  prefillListing?: SupplierListingRow | null;
  submitting: boolean;
}

function NewOrderModal({ onClose, onSubmit, supplier, prefillListing, submitting }: NewOrderModalProps) {
  // A listing with a set per-unit price (e.g. "₦9,000 per bag") drives
  // the total from quantity x price — it must NOT just prefill the raw
  // per-unit price as the whole order amount and leave it there
  // regardless of how many units the buyer actually wants (the exact bug
  // reported: a ₦9,000/bag listing produced a ₦9,000 order no matter
  // what quantity was entered). No listing price -> the old freeform
  // path (buyer types both an amount and a quantity description).
  const unitPriceMinor = prefillListing?.price_minor ?? null;
  const unitPriceMajor = unitPriceMinor !== null ? unitPriceMinor / 100 : null;

  const [title, setTitle] = useState(prefillListing?.name ?? "");
  const [unitCount, setUnitCount] = useState(unitPriceMinor !== null ? "1" : "");
  const [freeformQuantity, setFreeformQuantity] = useState("");
  const [amount, setAmount] = useState(unitPriceMajor !== null ? unitPriceMajor.toString() : "");
  const [deliveryLocation, setDeliveryLocation] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (unitPriceMajor === null) return;
    const n = Number(unitCount);
    setAmount(Number.isFinite(n) && n > 0 ? (unitPriceMajor * n).toString() : "");
  }, [unitPriceMajor, unitCount]);

  const validAmount = amount.trim() !== "" && !isNaN(Number(amount)) && Number(amount) > 0;
  const quantity = unitPriceMinor !== null ? `${unitCount}${prefillListing?.unit ? ` (${prefillListing.unit})` : ""}` : freeformQuantity;

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validAmount) return;
    onSubmit({ supplierId: supplier.id, supplierListingId: prefillListing?.id ?? null, title, amount, deliveryLocation, quantity, description });
  };

  return (
    <Modal open onClose={onClose} title={`Order from ${supplier.business_name}`} size="sm">
      <form onSubmit={handleFormSubmit} className="flex flex-col gap-3.5">
        <div>
          <Label htmlFor="new-order-title">What are you ordering?</Label>
          <Input id="new-order-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 500 units of compressed earth blocks" required />
        </div>

        {unitPriceMinor !== null ? (
          <>
            <div>
              <Label htmlFor="new-order-unit-count">Quantity{prefillListing?.unit ? ` (${prefillListing.unit})` : ""}</Label>
              <Input
                id="new-order-unit-count"
                inputMode="decimal"
                value={unitCount}
                onChange={(e) => setUnitCount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="e.g. 100"
                required
              />
            </div>
            <div className="rounded-lg border border-border bg-surface-sunken px-3 py-2.5 text-sm">
              <div className="text-text-secondary">
                {formatMoney(unitPriceMinor, "NGN")}
                {prefillListing?.unit ? ` ${prefillListing.unit}` : ""} × {unitCount || 0}
              </div>
              <div className="mt-0.5 font-semibold text-text-primary">
                Total: {validAmount ? formatMoney(Math.round(Number(amount) * 100), "NGN") : "—"}
              </div>
            </div>
          </>
        ) : (
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="new-order-amount">Order amount (₦)</Label>
              <Input id="new-order-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500000" required />
            </div>
            <div className="flex-1">
              <Label htmlFor="new-order-quantity">Quantity</Label>
              <Input id="new-order-quantity" value={freeformQuantity} onChange={(e) => setFreeformQuantity(e.target.value)} placeholder="e.g. 500 units" />
            </div>
          </div>
        )}

        <div>
          <Label htmlFor="new-order-location">Delivery location</Label>
          <Input id="new-order-location" value={deliveryLocation} onChange={(e) => setDeliveryLocation(e.target.value)} placeholder="e.g. Lekki, Lagos" required />
        </div>
        <div>
          <Label htmlFor="new-order-desc">Notes (optional)</Label>
          <Textarea id="new-order-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <Button type="submit" fullWidth loading={submitting} disabled={submitting || !(title.trim() && validAmount && deliveryLocation.trim())}>
          {submitting ? "Creating…" : "Create order"}
        </Button>
      </form>
    </Modal>
  );
}

export default function BuyerDashboard() {
  const router = useRouter();
  const { notify } = useToast();
  const { checkingSession, user, orders, setOrders, loadingOrders, canBeSupplier, signingOut, handleSignOut } = useSession();

  const [section, setSection] = useState<Section>("overview");
  const [tab, setTab] = useState<"active" | "history">("active");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierListing[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [orderingSupplier, setOrderingSupplier] = useState<SupplierListing | null>(null);
  const [orderingListing, setOrderingListing] = useState<SupplierListingRow | null>(null);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [materials, setMaterials] = useState<SupplierListingRow[]>([]);
  const [loadingMaterials, setLoadingMaterials] = useState(true);
  const [materialsQuery, setMaterialsQuery] = useState("");
  const [latestSupplierApplication, setLatestSupplierApplication] = useState<SupplierVerificationApplicationRow | null>(null);
  const [showReapplyForm, setShowReapplyForm] = useState(false);

  const isBuyer = user?.role === "buyer";

  useEffect(() => {
    if (checkingSession) return;
    if (!user) {
      router.replace("/");
      return;
    }
    // A supplier account has no buyer access — RootGate is the real gate
    // (fixed to redirect a supplier to /supplier, not /buyer, on sign-in)
    // and SupplierDashboard no longer offers a "Switch to buyer
    // dashboard" link at all; this is the defensive second layer for
    // direct navigation (bookmark, back button, a stale tab). Admin
    // keeps view access here on purpose — oversight, not "being a buyer".
    if (user.role === "supplier") {
      router.replace("/supplier");
    }
  }, [checkingSession, user, router]);

  // RootGate is the real gate for this (a first-time supplier applicant
  // doesn't get redirected to /buyer at all while pending — see
  // PendingVerificationScreen.tsx). This is the defensive second layer:
  // someone reaching /buyer directly anyway (a bookmark, browser back
  // button, a stale tab) gets bounced back to "/" so RootGate's check
  // runs again and shows the real pending screen, rather than quietly
  // landing on a working buyer dashboard while pending — per explicit
  // product direction, that account is not a buyer during this window.
  const loadSupplierApplication = () => {
    fetch("/api/supplier-verification/me")
      .then((res) => res.json())
      .then((data) => {
        const latest: SupplierVerificationApplicationRow | null = data.latestApplication ?? null;
        setLatestSupplierApplication(latest);
        if (latest?.status === "pending") router.replace("/");
      })
      .catch(() => {});
  };

  useEffect(() => {
    if (!user || !isBuyer) return;
    loadSupplierApplication();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isBuyer, router]);

  useEffect(() => {
    if (!user) return;
    setLoadingSuppliers(true);
    fetch("/api/suppliers")
      .then((res) => res.json())
      .then((data) => setSuppliers(data.suppliers || []))
      .catch(() => notify("error", "Failed to load suppliers."))
      .finally(() => setLoadingSuppliers(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Debounced so typing a search term doesn't fire a request per
  // keystroke — only loaded once the buyer actually visits the section
  // (or types in it), not eagerly on every dashboard mount.
  const materialsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!user || section !== "materials") return;
    if (materialsDebounceRef.current) clearTimeout(materialsDebounceRef.current);
    materialsDebounceRef.current = setTimeout(() => {
      setLoadingMaterials(true);
      fetch(`/api/materials?q=${encodeURIComponent(materialsQuery)}`)
        .then((res) => res.json())
        .then((data) => setMaterials(data.materials || []))
        .catch(() => notify("error", "Failed to load materials."))
        .finally(() => setLoadingMaterials(false));
    }, 300);
    return () => {
      if (materialsDebounceRef.current) clearTimeout(materialsDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, section, materialsQuery]);

  const activeCount = orders.filter((o) => !TERMINAL_STATUSES.has(o.status)).length;
  const completedCount = orders.filter((o) => o.status === "settled").length;
  const inEscrowMinor = orders
    .filter((o) => o.status === "funded" || o.status === "fulfilling" || o.status === "proof_submitted")
    .reduce((acc, o) => acc + o.amount_minor, 0);

  const tabbed = useMemo(
    () => (tab === "active" ? orders.filter((o) => !TERMINAL_STATUSES.has(o.status)) : orders.filter((o) => TERMINAL_STATUSES.has(o.status))),
    [orders, tab]
  );

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    { key: "suppliers", label: "Suppliers", icon: <Store size={16} />, active: section === "suppliers", onClick: () => setSection("suppliers") },
    { key: "orders", label: "Orders", icon: <FileText size={16} />, active: section === "orders", onClick: () => setSection("orders"), badge: activeCount },
    { key: "materials", label: "Materials", icon: <Package size={16} />, active: section === "materials", onClick: () => setSection("materials") },
  ];

  const openOrderModal = (supplier: SupplierListing) => {
    if (!isBuyer) {
      notify("error", "Creating an order needs the buyer role on this account.");
      return;
    }
    setOrderingSupplier(supplier);
  };

  const openOrderModalFromListing = (listing: SupplierListingRow) => {
    if (!isBuyer) {
      notify("error", "Creating an order needs the buyer role on this account.");
      return;
    }
    setOrderingListing(listing);
    setOrderingSupplier({
      id: listing.supplier_id,
      business_name: listing.supplier_business_name || "Supplier",
      business_location: listing.supplier_business_location || "",
      what_they_sell: "",
      rating_average: null,
      rating_count: 0,
    });
  };

  const handleCreateOrder = async (form: {
    supplierId: number;
    supplierListingId?: number | null;
    title: string;
    amount: string;
    deliveryLocation: string;
    quantity: string;
    description: string;
  }) => {
    setCreatingOrder(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok || !data.order) throw new Error(data.error || "Failed to create order.");
      setOrders((prev) => [data.order as OrderRow, ...prev]);
      notify("success", "Order created — fund it to get started.");
      setOrderingSupplier(null);
      setOrderingListing(null);
      setSection("orders");
      setSelectedOrderId(data.order.id);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to create order.");
    } finally {
      setCreatingOrder(false);
    }
  };

  const switchLinks: SwitchLink[] = [
    ...(canBeSupplier ? [{ label: "Switch to supplier dashboard", href: "/supplier" }] : []),
    ...(user?.role === "admin" ? [{ label: "Admin dashboard", href: "/admin" }] : []),
  ];

  if (checkingSession || !user || user.role === "supplier") {
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
      pageTitle={
        section === "overview" ? `Welcome back, ${user.username || "Buyer"}` : section === "suppliers" ? "Verified suppliers" : section === "materials" ? "Materials" : "Orders"
      }
      pageSubtitle={
        section === "overview"
          ? "Your procurement activity at a glance."
          : section === "suppliers"
          ? "Every supplier here has passed one-time business verification."
          : section === "materials"
          ? "Uploaded directly by verified suppliers — search to find who has what you need."
          : undefined
      }
    >
      {latestSupplierApplication?.status === "rejected" && (
        <div className="mb-6 rounded-lg border border-danger bg-danger-soft p-4 text-sm text-danger-text">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <XCircle size={15} className="shrink-0" />
              Your supplier verification application for <strong>{latestSupplierApplication.business_name}</strong> was
              not approved.
            </span>
            {!showReapplyForm && (
              <Button size="sm" variant="secondary" onClick={() => setShowReapplyForm(true)}>
                Reapply
              </Button>
            )}
          </div>
          {latestSupplierApplication.review_notes && (
            <p className="mt-2 text-xs leading-relaxed text-danger-text">Admin note: {latestSupplierApplication.review_notes}</p>
          )}
          {showReapplyForm && (
            <div className="mt-4">
              <SupplierVerificationForm
                onSubmitted={() => {
                  setShowReapplyForm(false);
                  loadSupplierApplication();
                }}
              />
            </div>
          )}
        </div>
      )}

      {section === "overview" && (
        <div className="flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Active orders" value={activeCount} icon={<FileText size={16} />} />
            <StatCard label="In escrow" value={formatMoney(inEscrowMinor, "NGN")} icon={<Coins size={16} />} tone="accent" />
            <StatCard label="Completed" value={completedCount} icon={<History size={16} />} />
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
              <EmptyOrders onBrowse={() => setSection("suppliers")} />
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

      {section === "suppliers" && (
        <div>
          {loadingSuppliers ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : suppliers.length === 0 ? (
            <div className="rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-5 py-10 text-center">
              <Info size={24} className="mx-auto mb-2 text-text-tertiary" />
              <p className="mx-auto max-w-[320px] text-sm text-text-secondary">No verified suppliers yet. Check back soon.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {suppliers.map((s) => (
                <SupplierCard key={s.id} supplier={s} onOrder={openOrderModal} />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "materials" && (
        <div>
          <div className="relative mb-5 max-w-md">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <Input
              value={materialsQuery}
              onChange={(e) => setMaterialsQuery(e.target.value)}
              placeholder="Search materials — e.g. cement, GFRP rebar…"
              className="pl-9"
            />
          </div>

          {loadingMaterials ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : materials.length === 0 ? (
            <div className="rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-5 py-10 text-center">
              <Info size={24} className="mx-auto mb-2 text-text-tertiary" />
              <p className="mx-auto max-w-[320px] text-sm text-text-secondary">
                {materialsQuery ? `No materials matching "${materialsQuery}".` : "No materials listed yet — suppliers add these from their own dashboard."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {materials.map((listing) => (
                <MaterialListingCard key={listing.id} listing={listing} onOrder={openOrderModalFromListing} />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "orders" && (
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
              <History size={13} /> History
            </button>
          </div>

          {loadingOrders ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : tabbed.length === 0 ? (
            <EmptyOrders onBrowse={() => setSection("suppliers")} historyTab={tab === "history"} />
          ) : (
            <div className="grid gap-3">
              {tabbed.map((o) => (
                <OrderCard key={o.id} order={o} onOpen={(order) => setSelectedOrderId(order.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {orderingSupplier && (
        <NewOrderModal
          onClose={() => {
            setOrderingSupplier(null);
            setOrderingListing(null);
          }}
          onSubmit={handleCreateOrder}
          supplier={orderingSupplier}
          prefillListing={orderingListing}
          submitting={creatingOrder}
        />
      )}
      {selectedOrderId && (
        <OrderDetailsModal
          orderId={selectedOrderId}
          role="buyer"
          canTransact={isBuyer}
          onClose={() => setSelectedOrderId(null)}
          onOrderChange={(order) => setOrders((prev) => prev.map((o) => (o.id === order.id ? order : o)))}
          showNotification={notify}
        />
      )}
    </DashboardShell>
  );
}

function EmptyOrders({ onBrowse, historyTab = false }: { onBrowse?: () => void; historyTab?: boolean }) {
  return (
    <div className="rounded-[10px] border-[1.5px] border-dashed border-border bg-surface px-5 py-10 text-center">
      <Info size={24} className="mx-auto mb-2 text-text-tertiary" />
      <div className="text-sm font-semibold text-text-primary">{historyTab ? "No completed orders yet" : "No orders yet"}</div>
      <p className="mx-auto mt-1 max-w-[300px] text-xs text-text-secondary">
        {historyTab ? "Completed orders will appear here once they settle." : "Browse verified suppliers to place your first order."}
      </p>
      {!historyTab && onBrowse && (
        <Button size="sm" className="mt-4" onClick={onBrowse}>
          Browse suppliers
        </Button>
      )}
    </div>
  );
}
