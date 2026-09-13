"use client";

// app/design-system/page.tsx
//
// Stage 2 preview route, every shared primitive in one place, both
// themes, checked here before it gets used in the buyer/sourcer
// dashboards. Not linked from product nav; reachable at /design-system.
import React, { useState } from "react";
import { Package, ShieldAlert, Inbox, Coins, FileText, History } from "lucide-react";
import ThemeToggle from "../../components/ui/ThemeToggle";
import Button from "../../components/ui/Button";
import { Label, HelperText, ErrorText, Input, Textarea } from "../../components/ui/Field";
import Select from "../../components/ui/Select";
import { Card, CardHeader, CardBody, CardFooter } from "../../components/ui/Card";
import { Table, Thead, Tbody, Tr, Th, Td } from "../../components/ui/Table";
import Badge, { ORDER_STATUS_TONE } from "../../components/ui/Badge";
import Modal from "../../components/ui/Modal";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ErrorPanel from "../../components/ui/ErrorPanel";
import TransactionProgress, { type TransactionStep } from "../../components/ui/TransactionProgress";
import Stepper from "../../components/ui/Stepper";
import { useToast } from "../../components/ui/Toast";
import EmptyState from "../../components/ui/EmptyState";
import Skeleton from "../../components/ui/Skeleton";
import StatCard, { StatCardSkeleton } from "../../components/ui/StatCard";
import SectionHeader from "../../components/ui/SectionHeader";
import Tabs from "../../components/ui/Tabs";
import CardListSkeleton from "../../components/ui/CardListSkeleton";
import OrderCard from "../../components/OrderCard";
import { formatMoney, TYPED_CONFIRMATION_THRESHOLD_MINOR } from "../../lib/money";
import type { OrderRow, OrderStatus } from "../../lib/types";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-4 font-mono text-xs font-semibold uppercase tracking-widest text-accent-text">{children}</h2>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-14">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div
        className="h-10 w-10 shrink-0 rounded-md border border-border"
        style={{ background: `var(${varName})` }}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-text-primary">{name}</div>
        <div className="truncate font-mono text-xs text-text-tertiary">{varName}</div>
      </div>
    </div>
  );
}

const COLOR_TOKENS: [string, string][] = [
  ["Background", "--color-bg"],
  ["Surface", "--color-surface"],
  ["Surface sunken", "--color-surface-sunken"],
  ["Border", "--color-border"],
  ["Border strong", "--color-border-strong"],
  ["Text primary", "--color-text-primary"],
  ["Text secondary", "--color-text-secondary"],
  ["Accent", "--color-accent"],
  ["Accent soft", "--color-accent-soft"],
  ["Success", "--color-success"],
  ["Warning", "--color-warning"],
  ["Danger", "--color-danger"],
  ["Nav background", "--color-nav-bg"],
  ["Nav active bg", "--color-nav-active-bg"],
];

const TYPE_SCALE: [string, string][] = [
  ["display", "font-display text-display"],
  ["4xl", "font-display text-4xl"],
  ["3xl", "font-display text-3xl"],
  ["2xl", "font-body text-2xl font-semibold"],
  ["xl", "font-body text-xl font-semibold"],
  ["lg", "font-body text-lg font-semibold"],
  ["md", "font-body text-md"],
  ["base", "font-body text-base"],
  ["sm", "font-body text-sm"],
  ["xs mono", "font-mono text-xs uppercase tracking-wide"],
];

interface SampleRow {
  id: string;
  material: string;
  buyer: string;
  status: OrderStatus;
  fee: string;
}

const SAMPLE_ROWS: SampleRow[] = [
  { id: "ORD-482913", material: "BubbleDeck Slabs", buyer: "@lagos_builds", status: "funded", fee: "45.00" },
  { id: "ORD-118820", material: "LC3 Cement", buyer: "@kano_materials", status: "proof_submitted", fee: "60.00" },
  { id: "ORD-905517", material: "Compressed Earth Blocks", buyer: "@abuja_dev", status: "pending_payment", fee: "—" },
  { id: "ORD-330214", material: "GFRP Reinforcing Bars", buyer: "@ph_contracts", status: "settled", fee: "80.00" },
];

// Minimal fake OrderRows for the OrderCard demo below, only the fields
// OrderCard actually reads carry meaningful values, the rest are inert
// placeholders satisfying the type.
function sampleOrder(overrides: Pick<OrderRow, "id" | "order_code" | "title" | "status" | "amount_minor" | "supplier_business_name">): OrderRow {
  return {
    buyer_id: 1,
    supplier_id: 1,
    material_id: null,
    supplier_listing_id: null,
    description: null,
    quantity: null,
    delivery_location: "Lekki, Lagos",
    currency: "NGN",
    platform_fee_minor: 0,
    supplier_verified_at_order_time: null,
    verification_call_seconds: 0,
    call_code_confirmed_at: null,
    verification_call_room_id: null,
    buyer_call_active_since: null,
    supplier_call_active_since: null,
    release_usdc_total_minor: null,
    release_usdc_platform_fee_minor: null,
    release_ngn_per_usd: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const SAMPLE_ORDERS: OrderRow[] = [
  sampleOrder({ id: 1, order_code: "482913", title: "500 units BubbleDeck Slabs", status: "funded", amount_minor: 4_500_000_00, supplier_business_name: "Lagos BuildCo" }),
  sampleOrder({ id: 2, order_code: "118820", title: "40 bags LC3 Cement", status: "proof_submitted", amount_minor: 850_000_00, supplier_business_name: "Kano Materials Ltd" }),
  sampleOrder({ id: 3, order_code: "905517", title: "1,200 Compressed Earth Blocks", status: "disputed", amount_minor: 1_200_000_00, supplier_business_name: "Abuja Dev Supplies" }),
  sampleOrder({ id: 4, order_code: "330214", title: "60 GFRP Reinforcing Bars", status: "settled", amount_minor: 2_400_000_00, supplier_business_name: "PH Contracts Co" }),
];

export default function DesignSystemPreview() {
  const { notify, update } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [invalidDemo, setInvalidDemo] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedConfirmOpen, setTypedConfirmOpen] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [txStep, setTxStep] = useState<TransactionStep>("submitted");
  const [txFailed, setTxFailed] = useState(false);
  const [showErrorPanel, setShowErrorPanel] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [demoTab, setDemoTab] = useState("active");
  const bigAmount = formatMoney(TYPED_CONFIRMATION_THRESHOLD_MINOR + 50_000_00, "NGN");

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg px-5 py-4">
        {/* var()-based colors don't support Tailwind's /alpha suffix, stays opaque. */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
            <Package size={16} className="text-accent-contrast" />
          </div>
          <span className="font-display text-lg font-semibold text-text-primary">SourceFi Design System</span>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto max-w-3xl px-5 pt-10">
        <p className="mb-14 max-w-xl text-base text-text-secondary">
          Stage 2 preview. Everything below is styled entirely through Tailwind color names that resolve to the CSS
          custom properties in <code className="font-mono text-accent-text">app/globals.css</code>. Toggle the theme:
          nothing here should need a code change to look right in either mode.
        </p>

        <Section title="Color tokens (current theme)">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {COLOR_TOKENS.map(([name, varName]) => (
              <Swatch key={varName} name={name} varName={varName} />
            ))}
          </div>
        </Section>

        <Section title="Type scale: Circular (Lineto) display, Roboto body, IBM Plex Mono labels">
          <div className="flex flex-col gap-3">
            {TYPE_SCALE.map(([label, classes]) => (
              <div key={label} className="flex flex-wrap items-baseline gap-3 border-b border-border pb-3">
                <span className="w-16 shrink-0 font-mono text-xs text-text-tertiary">{label}</span>
                <span className={`${classes} text-text-primary`}>Verified sourcing, stronger structures</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Radii & shadow">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {/* Tailwind's JIT needs literal class names, so no computed className here. */}
            <div className="flex h-16 items-center justify-center rounded-sm border border-border bg-surface text-xs text-text-secondary">
              sm
            </div>
            <div className="flex h-16 items-center justify-center rounded border border-border bg-surface text-xs text-text-secondary">
              default
            </div>
            <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-surface text-xs text-text-secondary">
              lg
            </div>
            <div className="flex h-16 items-center justify-center rounded-2xl border border-border bg-surface text-xs text-text-secondary">
              2xl
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-surface text-xs text-text-secondary shadow-sm">
              shadow-sm
            </div>
            <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-surface text-xs text-text-secondary shadow-md">
              shadow-md
            </div>
            <div className="flex h-16 items-center justify-center rounded-lg border border-border bg-surface text-xs text-text-secondary shadow-lg">
              shadow-lg
            </div>
          </div>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button loading>Loading</Button>
              <Button disabled>Disabled</Button>
            </div>
            <Button fullWidth className="max-w-sm">
              Full width
            </Button>
          </div>
        </Section>

        <Section title="Tabs: segmented control">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            Shared across BuyerDashboard, SupplierDashboard, and AdminDashboard's Active/History and status filters,
            one place to fix the look instead of copy-pasted pill markup.
          </p>
          <Tabs
            active={demoTab}
            onChange={setDemoTab}
            items={[
              { key: "active", label: "Active (3)" },
              {
                key: "history",
                label: (
                  <span className="flex items-center gap-1.5">
                    <History size={13} /> History
                  </span>
                ),
              },
              { key: "disputed", label: "disputed" },
            ]}
          />
        </Section>

        <Section title="Toasts: transient, non-critical feedback only">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            Success/info/loading auto-dismiss after 4s. Error and warning don't, the user dismisses them. Fire the
            same message twice fast to see it dedupe into a count instead of stacking.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => notify("success", "Draft saved.")}>Success</Button>
            <Button variant="danger" onClick={() => notify("error", "Couldn't fund escrow. Your bank declined the transfer. No money has left your account.")}>
              Error (sticky)
            </Button>
            <Button variant="secondary" onClick={() => notify("warning", "This is taking longer than usual.")}>
              Warning (sticky)
            </Button>
            <Button variant="secondary" onClick={() => notify("info", "Filters cleared.")}>
              Info
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                // update() turns the sticky "loading" toast into "success"
                // in place instead of stacking a second toast.
                const id = notify("loading", "Submitting…");
                setTimeout(() => update(id, "success", "Submitted."), 1400);
              }}
            >
              Loading → success (update() demo)
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                notify("error", "Failed to load orders.");
                notify("error", "Failed to load orders.");
                notify("error", "Failed to load orders.");
              }}
            >
              Fire same error ×3 (dedupe demo)
            </Button>
          </div>
        </Section>

        <Section title="Transaction progress: submitted / processing / confirmed">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            Escalates a bare spinner into three distinguishable, non-color-only states. Used inline in{" "}
            <code className="font-mono text-accent-text">OrderDetailsModal</code> while a fund/release leg is in
            flight.
          </p>
          <div className="max-w-sm rounded-lg border border-border bg-surface-sunken p-4">
            <TransactionProgress state={txStep} failed={txFailed} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setTxStep("submitted"); setTxFailed(false); }}>
              Submitted
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setTxStep("processing"); setTxFailed(false); }}>
              Processing
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setTxStep("confirmed"); setTxFailed(false); }}>
              Confirmed
            </Button>
            <Button size="sm" variant="danger" onClick={() => setTxFailed(true)}>
              Mark current step failed
            </Button>
          </div>
        </Section>

        <Section title="Stepper: a linear, gated process">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            For a multi-step flow where each step carries real, different, actionable content — distinct from
            Transaction progress above, which is a fixed three-state indicator for one payment leg. Used in{" "}
            <code className="font-mono text-accent-text">OrderDetailsModal</code>&rsquo;s delivery verification
            (live call → confirm order code → accept delivery).
          </p>
          <div className="max-w-md rounded-lg border border-border bg-surface-sunken p-4">
            <Stepper
              steps={[
                {
                  key: "call",
                  title: "Complete a 5-minute live verification call",
                  status: "complete",
                  content: <div className="text-xs text-success-text">✓ 5:12 verified, requirement met</div>,
                },
                {
                  key: "code",
                  title: "Confirm your supplier's order code on camera",
                  status: "current",
                  content: (
                    <Button size="sm" variant="secondary">
                      Confirm code match
                    </Button>
                  ),
                },
                {
                  key: "accept",
                  title: "Accept delivery",
                  status: "upcoming",
                  summary: "Unlocks once verification above is complete.",
                },
              ]}
            />
          </div>
        </Section>

        <Section title="Confirm dialog: irreversible/financial actions">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            Non-dismissible by backdrop click or Escape, only its own buttons close it. Above a configurable
            threshold ({formatMoney(TYPED_CONFIRMATION_THRESHOLD_MINOR, "NGN")}), Confirm stays disabled until the
            exact amount is typed back.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => setConfirmOpen(true)}>Release {formatMoney(45_000_00, "NGN")} (plain confirm)</Button>
            <Button variant="danger" onClick={() => setTypedConfirmOpen(true)}>
              Release {bigAmount} (typed confirm)
            </Button>
          </div>
          <ConfirmDialog
            open={confirmOpen}
            tone="danger"
            title="Confirm release"
            body={
              <>
                You&rsquo;re about to release <strong>{formatMoney(45_000_00, "NGN")}</strong> to{" "}
                <strong>Lagos BuildCo</strong>. This can&rsquo;t be undone once the transfer confirms.
              </>
            }
            confirmLabel={`Yes, release ${formatMoney(45_000_00, "NGN")}`}
            loading={confirmLoading}
            onConfirm={() => {
              setConfirmLoading(true);
              setTimeout(() => {
                setConfirmLoading(false);
                setConfirmOpen(false);
                notify("success", "Funds released.");
              }, 900);
            }}
            onCancel={() => setConfirmOpen(false)}
          />
          <ConfirmDialog
            open={typedConfirmOpen}
            tone="danger"
            title="Confirm release"
            body={
              <>
                You&rsquo;re about to release <strong>{bigAmount}</strong> to <strong>Lagos BuildCo</strong>. This
                can&rsquo;t be undone once the transfer confirms.
              </>
            }
            confirmLabel={`Yes, release ${bigAmount}`}
            requireTypedConfirmation={bigAmount}
            loading={confirmLoading}
            onConfirm={() => {
              setConfirmLoading(true);
              setTimeout(() => {
                setConfirmLoading(false);
                setTypedConfirmOpen(false);
                notify("success", "Funds released.");
              }, 900);
            }}
            onCancel={() => setTypedConfirmOpen(false)}
          />
        </Section>

        <Section title="Error panel: persistent financial failure state">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            A toast is never the only confirmation of a financial event, failures included. This stays on screen
            until dismissed, always states the fund position explicitly, and Retry reruns the same action.
          </p>
          {showErrorPanel ? (
            <div className="max-w-md">
              <ErrorPanel
                title="Couldn't fund escrow. Your bank declined the transfer."
                detail="Try another card, or contact your bank."
                fundPosition="No money has left your account."
                referenceCode="ERR-M1A2B3-C4D5"
                retrying={retrying}
                onRetry={() => {
                  setRetrying(true);
                  setTimeout(() => setRetrying(false), 900);
                }}
                onDismiss={() => setShowErrorPanel(false)}
              />
            </div>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setShowErrorPanel(true)}>
              Reset demo
            </Button>
          )}
        </Section>

        <Section title="Form fields">
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="ds-fee">Sourcing Fee (USD)</Label>
              <Input id="ds-fee" placeholder="e.g. 50" />
              <HelperText>Buyer locks this amount in escrow once you claim.</HelperText>
            </div>
            <div>
              <Label htmlFor="ds-invalid">Handshake code</Label>
              <Input
                id="ds-invalid"
                invalid={invalidDemo}
                defaultValue={invalidDemo ? "0000" : ""}
                placeholder="Enter the code the supplier gave you"
                onChange={() => setInvalidDemo(false)}
              />
              <ErrorText>{invalidDemo ? "Incorrect verification handshake code." : null}</ErrorText>
              {!invalidDemo && (
                <button
                  type="button"
                  className="mt-1.5 text-xs text-accent-text underline"
                  onClick={() => setInvalidDemo(true)}
                >
                  Preview error state
                </button>
              )}
            </div>
            <div>
              <Label htmlFor="ds-select">Sourcing Category</Label>
              <Select id="ds-select" defaultValue="earthblocks">
                <option value="earthblocks">Compressed Earth Blocks</option>
                <option value="bubbledeck">BubbleDeck Slabs</option>
                <option value="lc3cement">LC3 Cement</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ds-notes">Audit Notes</Label>
              <Textarea id="ds-notes" placeholder="Verified materials are in stock at warehouse..." />
            </div>
          </div>
        </Section>

        <Section title="Cards">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card interactive>
              <CardHeader>
                <div>
                  <div className="font-mono text-xs text-accent-text">REQ-482913 · Structural</div>
                  <div className="mt-1 font-display text-lg font-semibold text-text-primary">
                    500 units BubbleDeck Slabs
                  </div>
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-sm text-text-secondary">Lagos, NG · posted 2 days ago.</p>
              </CardBody>
              <CardFooter>
                <Badge tone={ORDER_STATUS_TONE.funded}>Funded · awaiting fulfillment</Badge>
                <span className="text-sm text-text-tertiary">₦45,000.00</span>
              </CardFooter>
            </Card>
            <Card>
              <CardBody>
                <EmptyState
                  icon={Inbox}
                  title="No archived orders"
                  description="Completed orders will appear here once they settle."
                />
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section title="Stat cards">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Active orders" value={12} icon={<FileText size={16} />} />
            <StatCard label="In escrow" value={formatMoney(4_500_000_00, "NGN")} icon={<Coins size={16} />} tone="accent" />
            <StatCardSkeleton />
          </div>
        </Section>

        <Section title="Section header">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            The "&lt;h2&gt;Section title&lt;/h2&gt; ... View all" row every dashboard's overview list uses, one
            place instead of three near-identical inline copies.
          </p>
          <SectionHeader
            title="Recent orders"
            count={4}
            action={
              <button type="button" className="text-sm font-semibold text-accent-text hover:underline">
                View all
              </button>
            }
          />
          <SectionHeader
            title="Nested subsection"
            size="sm"
            subtitle={
              <>
                <code className="font-mono text-accent-text">size=&quot;sm&quot;</code>, for a heading inside an
                already-sectioned tab, e.g. the Ledger view.
              </>
            }
          />
        </Section>

        <Section title="Order card">
          <p className="mb-4 max-w-xl text-sm text-text-secondary">
            The left edge carries the same status→tone mapping as the badge below it (
            <code className="font-mono text-accent-text">ORDER_STATUS_TONE</code>), so a list reads status at a
            glance without reading every badge.
          </p>
          <div className="grid gap-3">
            {SAMPLE_ORDERS.map((o) => (
              <OrderCard key={o.id} order={o} onOpen={() => {}} />
            ))}
          </div>
        </Section>

        <Section title="Status badges">
          <div className="flex flex-wrap gap-2.5">
            {(Object.entries(ORDER_STATUS_TONE) as [OrderStatus, (typeof ORDER_STATUS_TONE)[OrderStatus]][]).map(([status, tone]) => (
              <Badge key={status} tone={tone}>
                {status.replace(/_/g, " ")}
              </Badge>
            ))}
          </div>
        </Section>

        <Section title="Table">
          <Table>
            <Thead>
              <Tr>
                <Th>Order</Th>
                <Th>Material</Th>
                <Th>Buyer</Th>
                <Th>Status</Th>
                <Th>Fee</Th>
              </Tr>
            </Thead>
            <Tbody>
              {SAMPLE_ROWS.map((r) => (
                <Tr key={r.id}>
                  <Td className="font-mono text-xs">{r.id}</Td>
                  <Td>{r.material}</Td>
                  <Td className="text-text-secondary">{r.buyer}</Td>
                  <Td>
                    <Badge tone={ORDER_STATUS_TONE[r.status]}>{r.status.replace(/_/g, " ")}</Badge>
                  </Td>
                  <Td>₦{r.fee}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Section>

        <Section title="Skeleton / loading state">
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
          <p className="mb-3 mt-8 max-w-xl text-sm text-text-secondary">
            <code className="font-mono text-accent-text">CardListSkeleton</code> replaces the bare centered spinner
            every dashboard used to show while an order/listing/application list is loading.
          </p>
          <CardListSkeleton rows={2} />
        </Section>

        <Section title="Empty state">
          <EmptyState
            icon={ShieldAlert}
            title="No active mandates"
            description="Post a new request or use the material library to launch your mandate."
            action={<Button size="sm">New Sourcing Request</Button>}
          />
        </Section>

        <Section title="Connection state">
          <p className="mb-3 max-w-xl text-sm text-text-secondary">
            The real thing is a fixed, unmissable banner mounted globally in <code className="font-mono text-accent-text">app/layout.tsx</code> (
            <code className="font-mono text-accent-text">components/ui/OfflineBanner.tsx</code>). It appears the moment
            <code className="font-mono text-accent-text"> navigator.onLine</code> goes false anywhere in the app, and posts a
            &ldquo;Back online&rdquo; toast on reconnect. Turn off your connection (or DevTools&rsquo; network throttling) to
            see the real one; this is a static copy of its markup for reference without leaving this page.
          </p>
          <div className="relative flex items-center justify-center gap-2 rounded-lg bg-danger px-4 py-2 text-center text-sm font-semibold text-white">
            You&rsquo;re offline. Payment actions are paused until your connection comes back.
          </div>
        </Section>

        <Section title="Modal">
          <Button onClick={() => setModalOpen(true)}>Open modal</Button>
          <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="State Sourcing Fee">
            <p className="mb-4 text-sm text-text-secondary">
              State your required sourcing fee in USD. The buyer will lock this amount in escrow to secure your
              contract.
            </p>
            <Label htmlFor="ds-modal-fee">Sourcing Fee (USD)</Label>
            <Input id="ds-modal-fee" placeholder="e.g. 50" className="mb-5" />
            <div className="flex justify-end gap-2.5">
              <Button variant="ghost" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setModalOpen(false)}>Confirm & Claim</Button>
            </div>
          </Modal>
        </Section>
      </main>
    </div>
  );
}
