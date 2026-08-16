"use client";

// components/RootGate.tsx
//
// The one thing this route does: figure out which of three screens to
// show — sign in, finish onboarding, or (once both are done) get out of
// the way and send you to your dashboard. Neither dashboard route
// re-renders this; they each do their own light auth check for
// direct/deep links (see BuyerDashboard.tsx / SourcerDashboard.tsx).
import React, { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck, LayoutGrid, Check, type LucideIcon } from "lucide-react";
import { cn } from "./ui/cn";
import { useToast } from "./ui/Toast";
import { useSession } from "./SessionProvider";
import SignInScreen from "./SignInScreen";
import OnboardingScreen, { type OnboardingForm } from "./OnboardingScreen";
import OnboardingCarousel from "./OnboardingCarousel";
import PendingVerificationScreen from "./PendingVerificationScreen";
import type { SupplierVerificationApplicationRow } from "../lib/types";

const INTRO_SEEN_KEY = "sourcefi_intro_seen";

type Phase = 0 | 1 | 2;

const STEPS: { icon: LucideIcon; label: string }[] = [
  { icon: KeyRound, label: "Loading" },
  { icon: ShieldCheck, label: "Signing you in" },
  { icon: LayoutGrid, label: "Taking you to your dashboard" },
];

/** The three real phases RootGate ever waits on, made visible instead of
 * one ambiguous spinner. Step 1 (signing in) is the one that used to sit
 * behind a stale `checkingSession` value and take several seconds with no
 * feedback at all — see the fix in SessionProvider.tsx. */
function FullPageLoader({ phase }: { phase: Phase }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-bg px-6">
      <Image src="/logo-mark.png" alt="" width={56} height={56} className="rounded-2xl" priority />

      <div className="flex items-center">
        {STEPS.map((step, i) => {
          const Icon = step.icon;
          const state = i < phase ? "done" : i === phase ? "active" : "pending";
          return (
            <React.Fragment key={step.label}>
              {i > 0 && (
                <div className={cn("h-px w-8 transition-colors duration-base ease-base sm:w-14", state === "pending" ? "bg-border" : "bg-accent")} />
              )}
              <div
                className={cn(
                  "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors duration-base ease-base",
                  state === "done" && "border-accent bg-accent text-accent-contrast",
                  state === "active" && "border-accent bg-accent-soft text-accent-text",
                  state === "pending" && "border-border bg-surface text-text-tertiary"
                )}
              >
                {state === "done" ? <Check size={16} /> : <Icon size={16} />}
                {state === "active" && (
                  <span className="absolute inset-0 animate-ping rounded-full border-[1.5px] border-accent opacity-75" aria-hidden="true" />
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      <p role="status" className="text-sm font-medium text-text-secondary">
        {STEPS[phase]?.label}…
      </p>
    </div>
  );
}

export default function RootGate() {
  const router = useRouter();
  const { notify } = useToast();
  const {
    checkingSession,
    authenticated,
    user,
    needsOnboarding,
    login,
    completeOnboarding,
    completingOnboarding,
    handleSignOut,
    signingOut,
  } = useSession();

  const [form, setForm] = useState<OnboardingForm>({
    username: "",
    fullName: "",
    companyName: "",
    primaryLocation: "",
    path: "buyer",
    cacRegistrationNumber: "",
    taxIdNumber: "",
    whatTheySell: "",
    supportingDocumentUrl: "",
  });
  const [error, setError] = useState("");
  // null while unknown (avoids a flash of the wrong screen before the
  // localStorage read resolves on mount) — true/false once it has.
  const [introSeen, setIntroSeen] = useState<boolean | null>(null);

  // A first-time supplier applicant stays role='buyer' until an admin
  // approves them — per explicit product direction, that account does
  // NOT get normal buyer access while pending (see
  // PendingVerificationScreen.tsx's header comment). Re-verification
  // after expiry is different: that account is already role='supplier'
  // and isn't gated here at all, only checked for role==='buyer' below.
  const [pendingApplication, setPendingApplication] = useState<SupplierVerificationApplicationRow | null>(null);
  const [pendingApplicationChecked, setPendingApplicationChecked] = useState(false);

  useEffect(() => {
    try {
      setIntroSeen(localStorage.getItem(INTRO_SEEN_KEY) === "1");
    } catch {
      setIntroSeen(true); // localStorage unavailable — don't block on it
    }
  }, []);

  const dismissIntro = () => {
    setIntroSeen(true);
    try {
      localStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      /* localStorage unavailable — intro just reappears next visit */
    }
  };

  const readyForDashboard = !checkingSession && !!user && !needsOnboarding;

  useEffect(() => {
    if (!readyForDashboard) return;
    // Already resolved once (including the direct-from-submit path in
    // handleSubmit below, which sets both these synchronously right
    // after a successful application POST) — skip re-checking. Without
    // this guard, this effect firing on the SAME render pass that
    // needsOnboarding flips (readyForDashboard becoming true) can race
    // the just-submitted application's own insert and briefly read back
    // "no pending application yet", clobbering the correct value handleSubmit
    // just set and causing a flash toward /buyer before self-correcting.
    if (pendingApplicationChecked) return;
    if (user?.role !== "buyer") {
      // Only a still-role='buyer' account can have a BLOCKING first-time
      // application — an already-'supplier' account's re-verification
      // pending state is handled inside SupplierDashboard instead, with
      // full dashboard access kept.
      setPendingApplicationChecked(true);
      return;
    }
    let cancelled = false;
    fetch("/api/supplier-verification/me")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setPendingApplication(data.latestApplication?.status === "pending" ? data.latestApplication : null);
      })
      .catch(() => {
        if (!cancelled) setPendingApplication(null);
      })
      .finally(() => {
        if (!cancelled) setPendingApplicationChecked(true);
      });
    return () => {
      cancelled = true;
    };
    // pendingApplicationChecked is read (as a guard), not a re-trigger —
    // deliberately excluded so this doesn't re-run the instant it flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyForDashboard, user]);

  useEffect(() => {
    if (!readyForDashboard) return;
    if (!pendingApplicationChecked) return; // wait for the pending-application check first
    if (pendingApplication) return; // blocked — PendingVerificationScreen renders instead of redirecting
    // Was `role === "admin" ? "/admin" : "/buyer"` — which silently sent
    // EVERY non-admin role, including 'supplier', to /buyer. A supplier
    // has no buyer access anymore (see BuyerDashboard's own guard below,
    // and SupplierDashboard's switchLinks no longer offering the link at
    // all) — this was the actual root cause, not just a stray nav link.
    const destination = user?.role === "admin" ? "/admin" : user?.role === "supplier" ? "/supplier" : "/buyer";
    router.replace(destination);
  }, [readyForDashboard, pendingApplicationChecked, pendingApplication, user, router]);

  if (checkingSession || introSeen === null) {
    const phase: Phase = authenticated ? 1 : 0;
    return <FullPageLoader phase={phase} />;
  }

  if (readyForDashboard) {
    if (pendingApplicationChecked && pendingApplication) {
      return <PendingVerificationScreen application={pendingApplication} onSignOut={handleSignOut} signingOut={signingOut} />;
    }
    // Either still checking, or checked-clear and the redirect effect
    // above is about to fire — both cases show the same loader.
    return <FullPageLoader phase={2} />;
  }

  if (!user) {
    if (!introSeen) {
      return <OnboardingCarousel onComplete={dismissIntro} />;
    }
    return <SignInScreen onAuthenticate={login} />;
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (form.username.trim().length < 3) {
      setError("Please choose a username of at least 3 characters.");
      return;
    }
    if (form.path === "supplier" && !(form.companyName.trim() && form.primaryLocation.trim() && form.whatTheySell.trim())) {
      setError("Business name, location, and what you sell are required for supplier verification.");
      return;
    }

    const result = await completeOnboarding(form.username.trim());
    if (!result.success) {
      setError(result.error || "Something went wrong.");
      return;
    }

    // The profile save always happens; the application is a second,
    // independent step on top of it — a failure here shouldn't undo the
    // profile that already saved, just surface its own error and let them
    // retry from the (now buyer) dashboard rather than getting stuck here.
    if (form.path === "supplier") {
      try {
        const res = await fetch("/api/supplier-verification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessName: form.companyName,
            businessLocation: form.primaryLocation,
            whatTheySell: form.whatTheySell,
            cacRegistrationNumber: form.cacRegistrationNumber,
            taxIdNumber: form.taxIdNumber,
            supportingDocumentUrl: form.supportingDocumentUrl,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to submit your application.");
        notify("success", "Verification application submitted — an admin will review it.");
        // Set directly from the response rather than waiting on the
        // pending-application effect to refetch — avoids a flash of the
        // redirect-to-/buyer race between this submit and that fetch.
        setPendingApplicationChecked(true);
        setPendingApplication(data.application);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to submit your application.");
      }
    }
  };

  return (
    <OnboardingScreen
      form={form}
      setForm={setForm}
      error={error}
      onSubmit={handleSubmit}
      onSignOut={handleSignOut}
      submitting={completingOnboarding}
    />
  );
}
