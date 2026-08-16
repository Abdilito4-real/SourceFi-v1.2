// components/OnboardingScreen.tsx
//
// The "become a verified supplier" path here submits a KYB-style
// verification application, not a role — see
// app/api/supplier-verification/route.ts. Every account still starts
// (and stays) buyer until an admin approves it; this screen just decides
// whether that application gets submitted alongside the normal profile
// setup, never a role itself.
//
// Multi-step on purpose (was one long single-page form — real feedback
// from actually using it: "too tall/long"). Buyer path is 2 steps
// (about you -> profile details); supplier path is 3 (about you ->
// business identity -> what you sell + verification submit). The form
// stays a single <form> spanning every step so onSubmit only fires on
// the real final-step submit button — intermediate "Next" controls are
// type="button" and just advance local step state, no partial POSTs.
import React, { useState } from "react";
import { HardHat, Package, Store, Check, ArrowLeft } from "lucide-react";
import Button from "./ui/Button";
import { Label, Input, Textarea, ErrorText, HelperText } from "./ui/Field";
import { cn } from "./ui/cn";

export interface OnboardingForm {
  username: string;
  fullName: string;
  companyName: string;
  primaryLocation: string;
  path: "buyer" | "supplier";
  cacRegistrationNumber: string;
  taxIdNumber: string;
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

function StepDots({ count, current }: { count: number; current: number }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-1.5" role="tablist" aria-label="Onboarding progress">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn("h-1.5 rounded-pill transition-[width,background-color] duration-base ease-base", i === current ? "w-6 bg-accent" : "w-1.5 bg-border-strong")}
        />
      ))}
    </div>
  );
}

export default function OnboardingScreen({ form, setForm, error, onSubmit, onSignOut, submitting = false }: OnboardingScreenProps) {
  const isSupplierPath = form.path === "supplier";
  const totalSteps = isSupplierPath ? 3 : 2;
  const [step, setStep] = useState(0);

  const step0Valid = form.username.trim().length >= 3;
  const step1SupplierValid = form.companyName.trim() && form.primaryLocation.trim();
  const finalStepValid = isSupplierPath ? form.whatTheySell.trim().length > 0 : true;

  const goNext = () => setStep((s) => Math.min(totalSteps - 1, s + 1));
  const goBack = () => setStep((s) => Math.max(0, s - 1));

  // Switching path mid-flow could leave `step` pointing past the new
  // path's total steps (buyer has fewer) — clamp rather than let a stale
  // step index render nothing.
  const handleSelectPath = (path: OnboardingForm["path"]) => {
    setForm({ ...form, path });
    setStep(0);
  };

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (step < totalSteps - 1) {
      goNext();
      return;
    }
    onSubmit(e);
  };

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

        <StepDots count={totalSteps} current={step} />

        <form onSubmit={handleFormSubmit} className="flex flex-col gap-4">
          {step === 0 && (
            <>
              <div className="flex gap-3">
                <PathCard
                  icon={Package}
                  title="I'm sourcing materials"
                  desc="Order directly from verified suppliers, pay in Naira, approve delivery before funds release."
                  selected={!isSupplierPath}
                  onSelect={() => handleSelectPath("buyer")}
                />
                <PathCard
                  icon={Store}
                  title="I want to sell as a verified supplier"
                  desc="Apply for one-time business verification, then receive and fulfill orders directly."
                  selected={isSupplierPath}
                  onSelect={() => handleSelectPath("supplier")}
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
            </>
          )}

          {step === 1 && !isSupplierPath && (
            <div>
              <Label htmlFor="onboard-location">Primary location</Label>
              <Input id="onboard-location" placeholder="e.g. Lagos" value={form.primaryLocation} onChange={(e) => setForm({ ...form, primaryLocation: e.target.value })} />
            </div>
          )}

          {step === 1 && isSupplierPath && (
            <div className="flex flex-col gap-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Business identity</div>
              <div>
                <Label htmlFor="onboard-company">Business name</Label>
                <Input
                  id="onboard-company"
                  placeholder="e.g. Ibrahim Building Materials Ltd"
                  value={form.companyName}
                  onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                  required
                />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <Label htmlFor="onboard-cac">CAC number (optional)</Label>
                  <Input id="onboard-cac" placeholder="e.g. RC1234567" value={form.cacRegistrationNumber} onChange={(e) => setForm({ ...form, cacRegistrationNumber: e.target.value })} />
                </div>
                <div className="flex-1">
                  <Label htmlFor="onboard-tax">Tax ID (optional)</Label>
                  <Input id="onboard-tax" placeholder="e.g. TIN12345678" value={form.taxIdNumber} onChange={(e) => setForm({ ...form, taxIdNumber: e.target.value })} />
                </div>
              </div>
              <div>
                <Label htmlFor="onboard-location">Business location</Label>
                <Input id="onboard-location" placeholder="e.g. Lagos" value={form.primaryLocation} onChange={(e) => setForm({ ...form, primaryLocation: e.target.value })} required />
              </div>
            </div>
          )}

          {step === 2 && isSupplierPath && (
            <div className="flex flex-col gap-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Verification details</div>
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
              <p className="m-0 text-xs leading-relaxed text-text-tertiary">
                An admin reviews this once — confirming your business is real, your location, and what you sell.
                Verification is valid for 90 days or 20 orders, whichever comes first, then you re-apply the same
                way. This submits an application, not a role — you'll have full buyer access right away either way.
              </p>
            </div>
          )}

          <ErrorText>{error}</ErrorText>

          <div className="flex gap-3">
            {step > 0 && (
              <Button type="button" variant="secondary" onClick={goBack} disabled={submitting}>
                <ArrowLeft size={14} /> Back
              </Button>
            )}
            <Button
              type="submit"
              fullWidth
              loading={submitting}
              disabled={
                submitting ||
                (step === 0 && !step0Valid) ||
                (step === 1 && isSupplierPath && !step1SupplierValid) ||
                (step === totalSteps - 1 && !finalStepValid)
              }
            >
              {step < totalSteps - 1
                ? "Continue"
                : submitting
                ? "Saving…"
                : isSupplierPath
                ? "Save profile & apply for verification"
                : "Save profile & enter portal"}
            </Button>
          </div>
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
