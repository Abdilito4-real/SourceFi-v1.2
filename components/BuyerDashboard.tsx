"use client";

// components/BuyerDashboard.tsx
//
// Real route (/buyer) — Overview, Suppliers, Orders, Materials.
// Marketplace pivot: no more "post a request and a sourcer claims it" —
// the buyer picks a currently-verified supplier directly and creates an
// order against them (design doc Section 0). No wallet/crypto UI
// anywhere here — Fund Order is a single button, NGN in, NGN shown
// (design doc Section 3).
import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Info, ArrowRight, Layers, Coins, Building2, Package, HardHat, LayoutGrid, FileText, History, X, ChevronRight, Store, ShieldCheck } from "lucide-react";

import { materialLibrary } from "../lib/constants";
import { formatMoney } from "../lib/money";
import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import OrderCard from "./OrderCard";
import OrderDetailsModal from "./OrderDetailsModal";
import Button from "./ui/Button";
import { Card } from "./ui/Card";
import Modal from "./ui/Modal";
import StatCard from "./ui/StatCard";
import { Label, Input, Textarea } from "./ui/Field";
import Select from "./ui/Select";
import { useToast } from "./ui/Toast";
import type { Material, OrderRow, SupplierVerificationApplicationRow } from "../lib/types";

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

function materialIcon(id: string) {
  if (id === "earthblocks" || id === "hempcrete") return <Building2 size={20} className="text-accent-text" />;
  if (id === "bubbledeck" || id === "structuralsystems") return <Layers size={20} className="text-accent-text" />;
  if (id === "lc3cement" || id === "cement") return <Package size={20} className="text-accent-text" />;
  if (id === "geopolymer" || id === "passivecooling") return <HardHat size={20} className="text-accent-text" />;
  return <Layers size={20} className="text-accent-text" />;
}

function MaterialCard({ material, onOpen }: { material: Material; onOpen: (m: Material) => void }) {
  return (
    <Card interactive onClick={() => onOpen(material)} className="flex cursor-pointer flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft">{materialIcon(material.id)}</div>
        <span className="rounded bg-accent-soft px-2 py-1 text-right text-[10.5px] font-bold leading-tight text-accent-text">{material.savings}</span>
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

function MaterialDetail({ material, onClose, onFindSuppliers }: { material: Material; onClose: () => void; onFindSuppliers: (m: Material) => void }) {
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
      <Button fullWidth onClick={() => onFindSuppliers(material)}>
        Find verified suppliers <ArrowRight size={14} />
      </Button>
    </Modal>
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
  onSubmit: (form: { supplierId: number; title: string; amount: string; deliveryLocation: string; quantity: string; description: string }) => void | Promise<void>;
  supplier: SupplierListing;
  submitting: boolean;
}

function NewOrderModal({ onClose, onSubmit, supplier, submitting }: NewOrderModalProps) {
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [quantity, setQuantity] = useState("");
  const [deliveryLocation, setDeliveryLocation] = useState("");
  const [description, setDescription] = useState("");

  const validAmount = amount.trim() !== "" && !isNaN(Number(amount)) && Number(amount) > 0;

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validAmount) return;
    onSubmit({ supplierId: supplier.id, title, amount, deliveryLocation, quantity, description });
  };

  return (
    <Modal open onClose={onClose} title={`Order from ${supplier.business_name}`} size="sm">
      <form onSubmit={handleFormSubmit} className="flex flex-col gap-3.5">
        <div>
          <Label htmlFor="new-order-title">What are you ordering?</Label>
          <Input id="new-order-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 500 units of compressed earth blocks" required />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="new-order-amount">Order amount (₦)</Label>
            <Input id="new-order-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 500000" required />
          </div>
          <div className="flex-1">
            <Label htmlFor="new-order-quantity">Quantity</Label>
            <Input id="new-order-quantity" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="e.g. 500 units" />
          </div>
        </div>
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
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [viewingMaterial, setViewingMaterial] = useState<Material | null>(null);
  const [pendingSupplierApplication, setPendingSupplierApplication] = useState<SupplierVerificationApplicationRow | null>(null);

  const isBuyer = user?.role === "buyer";

  useEffect(() => {
    if (checkingSession) return;
    if (!user) router.replace("/");
  }, [checkingSession, user, router]);

  // RootGate is the real gate for this (a first-time supplier applicant
  // doesn't get redirected to /buyer at all while pending — see
  // PendingVerificationScreen.tsx). This is the defensive second layer:
  // someone reaching /buyer directly anyway (a bookmark, browser back
  // button, a stale tab) gets bounced back to "/" so RootGate's check
  // runs again and shows the real pending screen, rather than quietly
  // landing on a working buyer dashboard while pending — per explicit
  // product direction, that account is not a buyer during this window.
  useEffect(() => {
    if (!user || !isBuyer) return;
    fetch("/api/supplier-verification/me")
      .then((res) => res.json())
      .then((data) => {
        const pending = data.latestApplication?.status === "pending" ? data.latestApplication : null;
        setPendingSupplierApplication(pending);
        if (pending) router.replace("/");
      })
      .catch(() => {});
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

  const handleCreateOrder = async (form: { supplierId: number; title: string; amount: string; deliveryLocation: string; quantity: string; description: string }) => {
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
      pageTitle={
        section === "overview" ? `Welcome back, ${user.username || "Buyer"}` : section === "suppliers" ? "Verified suppliers" : section === "materials" ? "Material library" : "Orders"
      }
      pageSubtitle={
        section === "overview"
          ? "Your procurement activity at a glance."
          : section === "suppliers"
          ? "Every supplier here has passed one-time business verification."
          : section === "materials"
          ? "Hard-to-source architectural materials, verified before they leave the warehouse."
          : undefined
      }
    >
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {materialLibrary.map((m) => (
            <MaterialCard key={m.id} material={m} onOpen={setViewingMaterial} />
          ))}
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

      {viewingMaterial && (
        <MaterialDetail
          material={viewingMaterial}
          onClose={() => setViewingMaterial(null)}
          onFindSuppliers={() => {
            setViewingMaterial(null);
            setSection("suppliers");
          }}
        />
      )}
      {orderingSupplier && (
        <NewOrderModal onClose={() => setOrderingSupplier(null)} onSubmit={handleCreateOrder} supplier={orderingSupplier} submitting={creatingOrder} />
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
