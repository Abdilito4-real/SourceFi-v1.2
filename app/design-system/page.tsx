"use client";

// app/design-system/page.tsx
//
// Stage 2 preview route — every shared primitive in one place, both
// themes, checked here before it gets used in the buyer/sourcer
// dashboards. Not linked from product nav; reachable at /design-system.
import React, { useState } from "react";
import { Package, ShieldAlert, Inbox } from "lucide-react";
import ThemeToggle from "../../components/ui/ThemeToggle";
import Button from "../../components/ui/Button";
import { Label, HelperText, ErrorText, Input, Textarea } from "../../components/ui/Field";
import Select from "../../components/ui/Select";
import { Card, CardHeader, CardBody, CardFooter } from "../../components/ui/Card";
import { Table, Thead, Tbody, Tr, Th, Td } from "../../components/ui/Table";
import Badge, { STATUS_TONE } from "../../components/ui/Badge";
import Modal from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";
import EmptyState from "../../components/ui/EmptyState";
import Skeleton from "../../components/ui/Skeleton";
import type { RequestStatus } from "../../lib/types";

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
  status: RequestStatus;
  fee: string;
}

const SAMPLE_ROWS: SampleRow[] = [
  { id: "REQ-482913", material: "BubbleDeck Slabs", buyer: "@lagos_builds", status: "escrow", fee: "45.00" },
  { id: "REQ-118820", material: "LC3 Cement", buyer: "@kano_materials", status: "verified", fee: "60.00" },
  { id: "REQ-905517", material: "Compressed Earth Blocks", buyer: "@abuja_dev", status: "open", fee: "—" },
  { id: "REQ-330214", material: "GFRP Reinforcing Bars", buyer: "@ph_contracts", status: "escrow_released", fee: "80.00" },
];

export default function DesignSystemPreview() {
  const { notify } = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [invalidDemo, setInvalidDemo] = useState(false);

  return (
    <div className="min-h-screen bg-bg pb-24">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg px-5 py-4">
        {/* Same opacity-modifier caveat as Toast.tsx — var()-based colors
            don't support Tailwind's /alpha suffix, so this stays fully opaque. */}
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent">
            <Package size={16} className="text-accent-contrast" />
          </div>
          <span className="font-display text-lg font-semibold text-text-primary">SourceFi — Design System</span>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto max-w-3xl px-5 pt-10">
        <p className="mb-14 max-w-xl text-base text-text-secondary">
          Stage 2 preview. Everything below is styled entirely through Tailwind color names that resolve to the CSS
          custom properties in <code className="font-mono text-accent-text">app/globals.css</code>. Toggle the theme
          — nothing here should need a code change to look right in either mode.
        </p>

        <Section title="Color tokens (current theme)">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {COLOR_TOKENS.map(([name, varName]) => (
              <Swatch key={varName} name={name} varName={varName} />
            ))}
          </div>
        </Section>

        <Section title="Type scale — Fraunces display / Space Grotesk body / IBM Plex Mono labels">
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
            {/* Tailwind's JIT only picks up class names it can see literally in
                source — no string-interpolated class names, so each radius
                gets its own explicit div rather than a computed className. */}
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
              <Button
                onClick={() => notify("success", "Escrow deposit recorded successfully.")}
              >
                Trigger success toast
              </Button>
              <Button variant="danger" onClick={() => notify("error", "Sourcing claim failed to submit.")}>
                Trigger error toast
              </Button>
            </div>
            <Button fullWidth className="max-w-sm">
              Full width
            </Button>
          </div>
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
                <p className="text-sm text-text-secondary">Lagos, NG — posted 2 days ago.</p>
              </CardBody>
              <CardFooter>
                <Badge tone={STATUS_TONE.escrow}>Funds in escrow</Badge>
                <span className="text-sm text-text-tertiary">45.00 USD</span>
              </CardFooter>
            </Card>
            <Card>
              <CardBody>
                <EmptyState
                  icon={Inbox}
                  title="No archived requests"
                  description="Completed sourcing requests will appear here once payouts are disbursed."
                />
              </CardBody>
            </Card>
          </div>
        </Section>

        <Section title="Status badges">
          <div className="flex flex-wrap gap-2.5">
            {(Object.entries(STATUS_TONE) as [RequestStatus, (typeof STATUS_TONE)[RequestStatus]][]).map(([status, tone]) => (
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
                <Th>Request</Th>
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
                    <Badge tone={STATUS_TONE[r.status]}>{r.status.replace(/_/g, " ")}</Badge>
                  </Td>
                  <Td>{r.fee} USD</Td>
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
        </Section>

        <Section title="Empty state">
          <EmptyState
            icon={ShieldAlert}
            title="No active mandates"
            description="Post a new request or use the material library to launch your mandate."
            action={<Button size="sm">New Sourcing Request</Button>}
          />
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
