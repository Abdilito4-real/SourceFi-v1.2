"use client";

// components/SupplierDashboard.tsx
//
// Real route (/supplier), supersedes SourcerDashboard.tsx. Overview
// Orders, Verification. Marketplace pivot: no more "claim an open job,
// visit a supplier, submit an audit", the account HOLDING this
// dashboard now IS the supplier, verified once at onboarding (design doc
// Section 0), receiving orders buyers place directly and fulfilling them.
import React, { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Coins, ShieldCheck, ShieldAlert, LayoutGrid, FileText, History, Clock, Package, Plus, Pencil, Trash2, EyeOff, Eye } from "lucide-react";

import { formatMoney } from "../lib/money";
import { useSession } from "./SessionProvider";
import DashboardShell, { type NavItem, type SwitchLink } from "./DashboardShell";
import NotificationBell from "./NotificationBell";
import PushSoftPrompt from "./PushSoftPrompt";
import OrderCard from "./OrderCard";
import OrderDetailsModal from "./OrderDetailsModal";
import SupplierVerificationForm from "./SupplierVerificationForm";
import Button from "./ui/Button";
import { Card } from "./ui/Card";
import Modal from "./ui/Modal";
import StatCard from "./ui/StatCard";
import Badge from "./ui/Badge";
import { Label, Input, Textarea } from "./ui/Field";
import SharedEmptyState from "./ui/EmptyState";
import { useToast } from "./ui/Toast";
import type { SupplierListingRow, SupplierProfileRow, SupplierVerificationApplicationRow } from "../lib/types";

type Section = "overview" | "orders" | "listings" | "verification";

const TERMINAL_STATUSES = new Set(["settled", "refunded", "cancelled", "expired"]);

interface ListingFormValues {
  name: string;
  category: string;
  description: string;
  unit: string;
  priceAmount: string;
  imageUrl: string;
}

const EMPTY_LISTING_FORM: ListingFormValues = { name: "", category: "", description: "", unit: "", priceAmount: "", imageUrl: "" };

function ListingFormModal({
  title,
  initial,
  onClose,
  onSubmit,
  submitting,
}: {
  title: string;
  initial: ListingFormValues;
  onClose: () => void;
  onSubmit: (values: ListingFormValues) => void;
  submitting: boolean;
}) {
  const [values, setValues] = useState<ListingFormValues>(initial);

  return (
    <Modal open onClose={onClose} title={title} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(values);
        }}
        className="flex flex-col gap-3.5"
      >
        <div>
          <Label htmlFor="listing-name">Name</Label>
          <Input id="listing-name" value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} placeholder="e.g. LC3 Cement" required />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <Label htmlFor="listing-category">Category</Label>
            <Input id="listing-category" value={values.category} onChange={(e) => setValues({ ...values, category: e.target.value })} placeholder="e.g. Cement" />
          </div>
          <div className="flex-1">
            <Label htmlFor="listing-unit">Unit</Label>
            <Input id="listing-unit" value={values.unit} onChange={(e) => setValues({ ...values, unit: e.target.value })} placeholder="e.g. per bag" />
          </div>
        </div>
        <div>
          <Label htmlFor="listing-price">Indicative price (optional)</Label>
          <Input
            id="listing-price"
            prefix="₦"
            inputMode="decimal"
            value={values.priceAmount}
            onChange={(e) => setValues({ ...values, priceAmount: e.target.value })}
            placeholder="8,500"
          />
        </div>
        <div>
          <Label htmlFor="listing-image">Image URL (optional)</Label>
          <Input id="listing-image" value={values.imageUrl} onChange={(e) => setValues({ ...values, imageUrl: e.target.value })} placeholder="https://…" />
        </div>
        <div>
          <Label htmlFor="listing-desc">Description</Label>
          <Textarea id="listing-desc" value={values.description} onChange={(e) => setValues({ ...values, description: e.target.value })} placeholder="Grade, typical quantities, delivery notes…" />
        </div>
        <Button type="submit" fullWidth loading={submitting} disabled={submitting || !values.name.trim()}>
          Save
        </Button>
      </form>
    </Modal>
  );
}

export default function SupplierDashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { notify } = useToast();
  const { checkingSession, user, orders, setOrders, loadingOrders, canBeSupplier, signingOut, handleSignOut } = useSession();

  const [section, setSection] = useState<Section>("overview");
  const [ordersTab, setOrdersTab] = useState<"active" | "history">("active");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [pushPromptOpen, setPushPromptOpen] = useState(false);
  const [profile, setProfile] = useState<SupplierProfileRow | null>(null);
  const [currentlyVerified, setCurrentlyVerified] = useState(false);
  const [latestApplication, setLatestApplication] = useState<SupplierVerificationApplicationRow | null>(null);
  const [loadingVerification, setLoadingVerification] = useState(true);
  const [listings, setListings] = useState<SupplierListingRow[]>([]);
  const [loadingListings, setLoadingListings] = useState(true);
  const [showNewListing, setShowNewListing] = useState(false);
  const [editingListing, setEditingListing] = useState<SupplierListingRow | null>(null);
  const [savingListing, setSavingListing] = useState(false);

  const isSupplier = user?.role === "supplier";

  // Push notificationclick deep-links here as e.g. /supplier?order=482 or
  // /supplier?section=verification.
  useEffect(() => {
    const orderParam = searchParams.get("order");
    if (orderParam && Number.isInteger(Number(orderParam))) setSelectedOrderId(Number(orderParam));
    const sectionParam = searchParams.get("section");
    if (sectionParam === "overview" || sectionParam === "orders" || sectionParam === "listings" || sectionParam === "verification") {
      setSection(sectionParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const loadListings = () => {
    setLoadingListings(true);
    fetch("/api/supplier-listings")
      .then((res) => res.json())
      .then((data) => setListings(data.listings || []))
      .catch(() => notify("error", "Failed to load your listings."))
      .finally(() => setLoadingListings(false));
  };

  useEffect(() => {
    if (!user || !isSupplier) return;
    loadListings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isSupplier]);

  const handleCreateListing = async (values: ListingFormValues) => {
    // Captured before the request, not after: this is "did they have zero
    // listings when they started this action" (the real "about to
    // receive your first order" moment), not "do they still have zero
    // after the state update lands" (which is always false by then).
    const isFirstListing = listings.length === 0;

    setSavingListing(true);
    try {
      const res = await fetch("/api/supplier-listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          category: values.category,
          description: values.description,
          unit: values.unit,
          priceAmount: values.priceAmount || null,
          imageUrl: values.imageUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create listing.");
      setListings((rows) => [data.listing, ...rows]);
      notify("success", "Listing added.");
      setShowNewListing(false);
      // Push-notification soft prompt (feedback-layer Prompt 2), the
      // "moment value is obvious" for a supplier: buyers can now find and
      // order this, and a push is how they'll learn one did without
      // sitting on the dashboard waiting.
      if (isFirstListing) setPushPromptOpen(true);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to create listing.");
    } finally {
      setSavingListing(false);
    }
  };

  const handleEditListing = async (values: ListingFormValues) => {
    if (!editingListing) return;
    setSavingListing(true);
    try {
      const res = await fetch(`/api/supplier-listings/${editingListing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: values.name,
          category: values.category,
          description: values.description,
          unit: values.unit,
          priceAmount: values.priceAmount || null,
          imageUrl: values.imageUrl,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update listing.");
      setListings((rows) => rows.map((r) => (r.id === data.listing.id ? data.listing : r)));
      notify("success", "Listing updated.");
      setEditingListing(null);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to update listing.");
    } finally {
      setSavingListing(false);
    }
  };

  const handleToggleActive = async (listing: SupplierListingRow) => {
    try {
      const res = await fetch(`/api/supplier-listings/${listing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !listing.active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update listing.");
      setListings((rows) => rows.map((r) => (r.id === data.listing.id ? data.listing : r)));
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to update listing.");
    }
  };

  // Not financial, and the API route is a soft delete (deleted_at, never a
  // hard DELETE), a genuinely, safely undoable action. Feedback-layer
  // rule: "Where an action can be safely undone, offer a 5-10s undo window
  // instead of a confirmation dialog." So this removes the card from view
  // immediately and only calls the DELETE route if the window lapses
  // without Undo, the row never actually leaves the database at all if
  // the buyer/supplier changes their mind in time, no separate restore
  // endpoint needed. (Trade-off, stated plainly: if this dashboard
  // unmounts, navigating away, logging out, before the window closes
  // the pending delete is dropped rather than fired; same posture as most
  // "undo send" implementations.)
  const deleteTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = deleteTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
    };
  }, []);

  const handleDeleteListing = (listing: SupplierListingRow) => {
    setListings((rows) => rows.filter((r) => r.id !== listing.id));
    notify("info", `${listing.name} removed.`, {
      duration: 7000,
      action: {
        label: "Undo",
        onClick: () => {
          const timer = deleteTimers.current.get(listing.id);
          if (timer) {
            clearTimeout(timer);
            deleteTimers.current.delete(listing.id);
          }
          setListings((rows) => [listing, ...rows]);
        },
      },
    });

    const timer = setTimeout(async () => {
      deleteTimers.current.delete(listing.id);
      try {
        const res = await fetch(`/api/supplier-listings/${listing.id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to delete listing.");
      } catch (err) {
        // The undo window already closed and deletion still failed, put
        // it back rather than leave the screen showing it gone while the
        // database still has it.
        setListings((rows) => [listing, ...rows]);
        notify("error", err instanceof Error ? err.message : "Failed to delete listing. It's back in your list.");
      }
    }, 7000);
    deleteTimers.current.set(listing.id, timer);
  };

  const activeOrders = orders.filter((o) => !TERMINAL_STATUSES.has(o.status));
  const historyOrders = orders.filter((o) => TERMINAL_STATUSES.has(o.status));
  const ordersTabbed = ordersTab === "active" ? activeOrders : historyOrders;
  const settledOrders = orders.filter((o) => o.status === "settled");
  const earningsMinor = settledOrders.reduce((acc, o) => acc + (o.amount_minor - o.platform_fee_minor), 0);
  const incomingCount = orders.filter((o) => o.status === "funded" || o.status === "fulfilling").length;

  const navItems: NavItem[] = [
    { key: "overview", label: "Overview", icon: <LayoutGrid size={16} />, active: section === "overview", onClick: () => setSection("overview") },
    { key: "orders", label: "Orders", icon: <FileText size={16} />, active: section === "orders", onClick: () => setSection("orders"), badge: incomingCount },
    { key: "listings", label: "Listings", icon: <Package size={16} />, active: section === "listings", onClick: () => setSection("listings") },
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

  // No "Switch to buyer dashboard" link, a supplier account has no
  // buyer access (see BuyerDashboard's own redirect guard). Admin still
  // gets both links: oversight of every dashboard, not "being" any role.
  const switchLinks: SwitchLink[] = [...(user.role === "admin" ? [{ label: "Buyer dashboard", href: "/buyer" }, { label: "Admin dashboard", href: "/admin" }] : [])];

  return (
    <DashboardShell
      activeDashboard="supplier"
      switchLinks={switchLinks}
      navItems={navItems}
      user={user}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      notificationBell={<NotificationBell />}
      pageTitle={
        section === "overview"
          ? `Supplier portal · @${user.username || "Supplier"}`
          : section === "orders"
          ? "Orders"
          : section === "listings"
          ? "Listings"
          : "Verification"
      }
      pageSubtitle={
        section === "overview"
          ? "Fulfill orders, submit delivery proof, get paid."
          : section === "listings"
          ? "What buyers see when they search or browse your business."
          : undefined
      }
    >
      {!loadingVerification && isSupplier && !currentlyVerified && section !== "verification" && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-warning-text">
          <span className="flex items-center gap-2">
            <ShieldAlert size={15} /> Your verification isn't currently active. You can't receive new orders until it's renewed.
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
              <SharedEmptyState title="No orders yet" description="They'll show up here as soon as a buyer funds one against your business." />
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
            <SharedEmptyState title={ordersTab === "history" ? "No completed orders yet" : "No active orders right now"} />
          ) : (
            <div className="grid gap-3">
              {ordersTabbed.map((o) => (
                <OrderCard key={o.id} order={o} onOpen={(order) => setSelectedOrderId(order.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {section === "listings" && (
        <div>
          <div className="mb-5 flex justify-end">
            <Button size="sm" onClick={() => setShowNewListing(true)}>
              <Plus size={14} /> Add listing
            </Button>
          </div>

          {loadingListings ? (
            <div className="flex justify-center py-10">
              <Loader2 size={22} className="spin-icon text-accent" />
            </div>
          ) : listings.length === 0 ? (
            <SharedEmptyState title="No listings yet" description="Add what you sell so buyers can find it in search." />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {listings.map((listing) => (
                <Card key={listing.id} className="flex flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                      <Package size={18} />
                    </div>
                    <Badge tone={listing.active ? "success" : "neutral"}>{listing.active ? "Active" : "Paused"}</Badge>
                  </div>
                  <div>
                    <h3 className="font-display text-lg italic leading-tight text-text-primary">{listing.name}</h3>
                    {listing.category && <div className="mt-0.5 text-xs text-text-tertiary">{listing.category}</div>}
                  </div>
                  {listing.description && <p className="line-clamp-2 text-sm leading-relaxed text-text-secondary">{listing.description}</p>}
                  <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
                    <span className="text-sm font-semibold text-text-secondary">
                      {listing.price_minor ? `${formatMoney(listing.price_minor, "NGN")}${listing.unit ? ` ${listing.unit}` : ""}` : "No price set"}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(listing)}
                        title={listing.active ? "Pause" : "Resume"}
                        className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-sunken hover:text-text-primary"
                      >
                        {listing.active ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingListing(listing)}
                        title="Edit"
                        className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-sunken hover:text-text-primary"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteListing(listing)}
                        title="Delete"
                        className="rounded-md p-1.5 text-text-tertiary hover:bg-danger-soft hover:text-danger-text"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </Card>
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
                  Verification is valid for 90 days or 20 orders, whichever comes first. This is a one-time business check, not a
                  per-order visit. Once it expires you can't receive new orders until you're re-verified.
                </p>
              </Card>

              {!currentlyVerified && (
                <div>
                  {latestApplication?.status === "pending" ? (
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm text-text-secondary">
                      <Clock size={15} className="shrink-0" /> Your re-verification is under review. Most reviews complete
                      within a couple of minutes, but it can take up to 48 hours.
                    </div>
                  ) : (
                    <>
                      <h3 className="mb-3 font-display text-lg italic text-text-primary">
                        {profile ? "Re-apply for verification" : "Apply for verification"}
                      </h3>
                      <SupplierVerificationForm onSubmitted={loadVerification} />
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

      {showNewListing && (
        <ListingFormModal title="Add listing" initial={EMPTY_LISTING_FORM} onClose={() => setShowNewListing(false)} onSubmit={handleCreateListing} submitting={savingListing} />
      )}
      {editingListing && (
        <ListingFormModal
          title="Edit listing"
          initial={{
            name: editingListing.name,
            category: editingListing.category || "",
            description: editingListing.description || "",
            unit: editingListing.unit || "",
            priceAmount: editingListing.price_minor ? (editingListing.price_minor / 100).toString() : "",
            imageUrl: editingListing.image_url || "",
          }}
          onClose={() => setEditingListing(null)}
          onSubmit={handleEditListing}
          submitting={savingListing}
        />
      )}
      <PushSoftPrompt open={pushPromptOpen} onClose={() => setPushPromptOpen(false)} reason="You just added your first listing. Buyers can now find and order it." />
    </DashboardShell>
  );
}
