// components/OnboardingScreen.tsx
//
// The "become a verified supplier" path here submits a KYB-style
// verification application, not a role — see
// app/api/supplier-verification/route.ts. Every account still starts
// (and stays) buyer until an admin approves it; this screen just decides
// whether that application gets submitted alongside the normal profile
// setup, never a role itself. Repurposed from the old "become a sourcing
// partner" (field-agent) application — see docs/marketplace-payments-design.md
// Section 0 for why that's a pivot, not a rename: this form now asks what
// the design doc's verification requirement actually needs (is the
// business real, where is it, what do they sell), not field-agent
// experience.
import React from "react";
import { HardHat, Package, Store, Check } from "lucide-react";
import Button from "./ui/Button";
import Select from "./ui/Select";
import { Label, Input, Textarea, ErrorText, HelperText } from "./ui/Field";
import { cn } from "./ui/cn";

export interface OnboardingForm {
  username: string;
  fullName: string;
  companyName: string;
  professionalRole: string;
  primaryLocation: string;
  path: "buyer" | "supplier";
  cacRegistrationNumber: string;
  whatTheySell: string;
  supportingDocumentUrl: string;
}

export interface OnboardingScreenProps {
  form: OnboardingForm;
  setForm: React.Dispatch<React.SetStateAction<OnboardingForm>>;
  error: string;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onSignOut: () => void;
  submitting?: boolean;
}

function PathCard({
  icon: Icon,
  title,
  desc,
  selected,
  onSelect,
}: {
  icon: typeof Package;
  title: string;
  desc: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-1 flex-col items-start gap-2 rounded-xl border-[1.5px] p-4 text-left transition-colors duration-base ease-base",
        selected ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-border-strong"
      )}
    >
      <div className="flex w-full items-center justify-between">
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", selected ? "bg-accent text-accent-contrast" : "bg-surface-sunken text-text-tertiary")}>
          <Icon size={16} />
        </div>
        {selected && <Check size={16} className="text-accent-text" />}
      </div>
      <div className="text-sm font-semibold text-text-primary">{title}</div>
      <p className="m-0 text-xs leading-relaxed text-text-secondary">{desc}</p>
    </button>
  );
}

export default function OnboardingScreen({ form, setForm, error, onSubmit, onSignOut, submitting = false }: OnboardingScreenProps) {
  const isSupplierPath = form.path === "supplier";

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-5">
      <div className="w-full max-w-[460px] rounded-2xl border border-border bg-surface-elevated p-9 shadow-lg">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border-[1.5px] border-accent bg-accent-soft">
            <HardHat size={20} className="text-accent-text" />
          </div>
          <h2 className="mb-1.5 font-display text-2xl italic text-text-primary">Complete your profile</h2>
          <p className="text-base leading-relaxed text-text-secondary">Choose a username and tell us what brings you to SourceFi.</p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex gap-3">
            <PathCard
              icon={Package}
              title="I'm sourcing materials"
              desc="Order directly from verified suppliers, pay in Naira, approve delivery before funds release."
              selected={!isSupplierPath}
              onSelect={() => setForm({ ...form, path: "buyer" })}
            />
            <PathCard
              icon={Store}
              title="I want to sell as a verified supplier"
              desc="Apply for one-time business verification, then receive and fulfill orders directly."
              selected={isSupplierPath}
              onSelect={() => setForm({ ...form, path: "supplier" })}
            />
          </div>

          <div>
            <Label htmlFor="onboard-username">Username</Label>
            <Input
              id="onboard-username"
              placeholder="e.g. kano_materials"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })}
              required
            />
            <HelperText>Only lowercase letters, numbers, and underscores allowed.</HelperText>
          </div>

          <div>
            <Label htmlFor="onboard-fullname">Full name</Label>
            <Input
              id="onboard-fullname"
              placeholder="e.g. Alhaji Ibrahim Kano"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </div>

          <div>
            <Label htmlFor="onboard-company">{isSupplierPath ? "Business name" : "Company name"}</Label>
            <Input
              id="onboard-company"
              placeholder="e.g. Ibrahim Building Materials Ltd"
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              required={isSupplierPath}
            />
          </div>

          <div className="flex gap-3">
            {!isSupplierPath && (
              <div className="flex-[1.2]">
                <Label htmlFor="onboard-role">Professional role</Label>
                <Select
                  id="onboard-role"
                  value={form.professionalRole}
                  onChange={(e) => setForm({ ...form, professionalRole: e.target.value })}
                >
                  {["Contractor", "Developer", "Specialty Supplier", "Accredited Auditor"].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="flex-1">
              <Label htmlFor="onboard-location">{isSupplierPath ? "Business location" : "Primary location"}</Label>
              <Input
                id="onboard-location"
                placeholder="e.g. Lagos"
                value={form.primaryLocation}
                onChange={(e) => setForm({ ...form, primaryLocation: e.target.value })}
                required={isSupplierPath}
              />
            </div>
          </div>

          {isSupplierPath && (
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-sunken p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Supplier verification application</div>
              <div>
                <Label htmlFor="onboard-cac">CAC registration number (optional)</Label>
                <Input
                  id="onboard-cac"
                  placeholder="e.g. RC1234567"
                  value={form.cacRegistrationNumber}
                  onChange={(e) => setForm({ ...form, cacRegistrationNumber: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="onboard-doc">Supporting document (optional)</Label>
                <Input
                  id="onboard-doc"
                  placeholder="Link to your CAC certificate, utility bill, etc."
                  value={form.supportingDocumentUrl}
                  onChange={(e) => setForm({ ...form, supportingDocumentUrl: e.target.value })}
                />
                <HelperText>A link (Google Drive, Dropbox, etc.) — no file upload yet, so paste a shareable URL.</HelperText>
              </div>
              <div>
                <Label htmlFor="onboard-sells">What do you produce or sell?</Label>
                <Textarea
                  id="onboard-sells"
                  placeholder="e.g. LC3 cement, compressed earth blocks — materials and typical quantities."
                  value={form.whatTheySell}
                  onChange={(e) => setForm({ ...form, whatTheySell: e.target.value })}
                  required
                />
              </div>
              <p className="m-0 text-xs leading-relaxed text-text-tertiary">
                An admin reviews this once — confirming your business is real, your location, and what you sell.
                Verification is valid for 90 days or 20 orders, whichever comes first, then you re-apply the same
                way. This submits an application, not a role — you'll have full buyer access right away either way.
              </p>
            </div>
          )}

          <ErrorText>{error}</ErrorText>

          <Button
            type="submit"
            fullWidth
            loading={submitting}
            disabled={
              submitting ||
              form.username.trim().length < 3 ||
              (isSupplierPath && !(form.companyName.trim() && form.primaryLocation.trim() && form.whatTheySell.trim()))
            }
          >
            {submitting ? "Saving…" : isSupplierPath ? "Save profile & apply for verification" : "Save profile & enter portal"}
          </Button>
        </form>

        <div className="mt-4.5 text-center">
          <button
            type="button"
            onClick={onSignOut}
            className="border-none bg-transparent text-xs text-text-secondary underline hover:text-text-primary"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
