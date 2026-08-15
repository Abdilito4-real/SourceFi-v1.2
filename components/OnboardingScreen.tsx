// components/OnboardingScreen.tsx
//
// The "become a sourcing partner" path here submits an application, not a
// role — see app/api/sourcer-applications/route.ts. Every account still
// starts (and stays) buyer until an admin approves it; this screen just
// decides whether that application gets submitted alongside the normal
// profile setup, never a role itself.
import React from "react";
import { HardHat, Package, Wrench, Check } from "lucide-react";
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
  path: "buyer" | "sourcer";
  applicationExperience: string;
  applicationReason: string;
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
  const isSourcerPath = form.path === "sourcer";

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
              desc="Post requests, fund escrow, approve verified deliveries."
              selected={!isSourcerPath}
              onSelect={() => setForm({ ...form, path: "buyer" })}
            />
            <PathCard
              icon={Wrench}
              title="I want to become a sourcing partner"
              desc="Apply to visit suppliers and verify materials in person."
              selected={isSourcerPath}
              onSelect={() => setForm({ ...form, path: "sourcer" })}
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
            <Label htmlFor="onboard-fullname">Full name / company alias</Label>
            <Input
              id="onboard-fullname"
              placeholder="e.g. Alhaji Ibrahim Kano"
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </div>

          <div>
            <Label htmlFor="onboard-company">Company name</Label>
            <Input
              id="onboard-company"
              placeholder="e.g. Ibrahim Sourcing & Slabs Ltd"
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
            />
          </div>

          <div className="flex gap-3">
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
            <div className="flex-1">
              <Label htmlFor="onboard-location">{isSourcerPath ? "Base location" : "Primary location"}</Label>
              <Input
                id="onboard-location"
                placeholder="e.g. Lagos"
                value={form.primaryLocation}
                onChange={(e) => setForm({ ...form, primaryLocation: e.target.value })}
              />
            </div>
          </div>

          {isSourcerPath && (
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-sunken p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-accent-text">Sourcing partner application</div>
              <div>
                <Label htmlFor="onboard-experience">Relevant experience</Label>
                <Textarea
                  id="onboard-experience"
                  placeholder="Sourcing, procurement, or construction-materials experience, if any."
                  value={form.applicationExperience}
                  onChange={(e) => setForm({ ...form, applicationExperience: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="onboard-reason">Why do you want to become a sourcing partner?</Label>
                <Textarea
                  id="onboard-reason"
                  placeholder="What materials or regions you know well, and why you'd be a good fit."
                  value={form.applicationReason}
                  onChange={(e) => setForm({ ...form, applicationReason: e.target.value })}
                  required
                />
              </div>
              <p className="m-0 text-xs leading-relaxed text-text-tertiary">
                This submits an application, not a role. An admin reviews it before anything changes on your account —
                you'll get full buyer access right away either way.
              </p>
            </div>
          )}

          <ErrorText>{error}</ErrorText>

          <Button
            type="submit"
            fullWidth
            loading={submitting}
            disabled={submitting || form.username.trim().length < 3 || (isSourcerPath && !form.applicationReason.trim())}
          >
            {submitting ? "Saving…" : isSourcerPath ? "Save profile & submit application" : "Save profile & enter portal"}
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
