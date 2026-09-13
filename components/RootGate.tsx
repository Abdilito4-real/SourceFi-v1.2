"use client";

// components/RootGate.tsx
//
// The one thing this route does: figure out which of three screens to
// show, sign in, finish onboarding, or (once both are done) get out of
// the way and send you to your dashboard. Neither dashboard route
// re-renders this; they each do their own light auth check for
// direct/deep links (see BuyerDashboard.tsx / SourcerDashboard.tsx).
import React, { useEffect, useRef, useState } from "react";
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
import { SUPPORTING_DOCUMENT_TYPES } from "../lib/supplierDocumentTypes";

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
 * feedback at all, see the fix in SessionProvider.tsx. */
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
    profilePictureUrl: "",
    companyName: "",
    companyPhone: "",
    primaryLocation: "",
    path: "buyer",
    cacRegistrationNumber: "",
    taxIdNumber: "",
    whatTheySell: "",
    supportingDocumentType: SUPPORTING_DOCUMENT_TYPES[0]!.value,
    supportingDocumentUrl: "",
    payoutBankName: "",
    payoutAccountNumber: "",
    payoutAccountName: "",
  });
  const [error, setError] = useState("");
  // null while unknown (avoids a flash of the wrong screen before the
  // localStorage read resolves on mount), true/false once it has.
  const [introSeen, setIntroSeen] = useState<boolean | null>(null);

  // A first-time supplier applicant stays role='buyer' until an admin
  // approves them, per explicit product direction, that account does
  // NOT get normal buyer access while pending (see
  // PendingVerificationScreen.tsx's header comment). Re-verification
  // after expiry is different: that account is already role='supplier'
  // and isn't gated here at all, only checked for role==='buyer' below.
  const [pendingApplication, setPendingApplication] = useState<SupplierVerificationApplicationRow | null>(null);
  const [pendingApplicationChecked, setPendingApplicationChecked] = useState(false);
  // Real race, not theoretical: completeOnboarding() resolving flips
  // needsOnboarding -> readyForDashboard -> true on THIS render, which
  // fires the pending-application-check effect below via its own GET
  // /api/supplier-verification/me — concurrently with handleSubmit's own
  // POST /api/supplier-verification a few lines further down the SAME
  // function. The GET is a single read; the POST does a payout-profile
  // upsert + an insert, so the GET routinely wins the race and finds
  // nothing yet (the POST hasn't committed), locks in "not pending", and
  // the redirect effect fires router.replace("/buyer") before the POST's
  // own result — the actual pending application — ever lands. This ref
  // (not state: must be readable synchronously inside the effect the
  // instant it fires, not after a re-render) tells that effect to stand
  // down and let handleSubmit's own POST be the sole source of truth
  // whenever a submission is genuinely in flight.
  const submittingApplicationRef = useRef(false);
  // Set right when completeOnboarding() succeeds below, read by the
  // redirect effect that follows: distinguishes "this /buyer redirect is
  // happening because onboarding JUST finished" from "this /buyer
  // redirect is just an already-onboarded returning user bouncing
  // through / again" (which happens on every fresh app open, PWA
  // start_url is "/"). Only the former should carry the one-time
  // welcome push-notification prompt; a ref, not state, because it only
  // needs to be read once, synchronously, by the effect that fires
  // immediately after this same render.
  const justOnboardedRef = useRef(false);

  useEffect(() => {
    try {
      setIntroSeen(localStorage.getItem(INTRO_SEEN_KEY) === "1");
    } catch {
      setIntroSeen(true); // localStorage unavailable, don't block on it
    }
  }, []);

  const dismissIntro = () => {
    setIntroSeen(true);
    try {
      localStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      /* localStorage unavailable, intro just reappears next visit */
    }
  };

  const readyForDashboard = !checkingSession && !!user && !needsOnboarding;

  useEffect(() => {
    if (!readyForDashboard) return;
    // Already resolved once (including the direct-from-submit path in
    // handleSubmit below, which sets both these synchronously right
    // after a successful application POST), skip re-checking.
    if (pendingApplicationChecked) return;
    // A submission is genuinely in flight right now (handleSubmit set
    // this ref synchronously before its own POST) — stand down entirely
    // rather than race it. This isn't just a redundant check: the
    // redirect effect below fires router.replace("/buyer") the instant
    // pendingApplicationChecked flips true with a null application, and
    // that's a REAL navigation, not a flag — by the time handleSubmit's
    // own POST resolves with the correct (pending) application a moment
    // later, the page has already left. Confirmed live: this exact race
    // sent a first-time supplier applicant straight to /buyer with no
    // application ever visibly submitted.
    if (submittingApplicationRef.current) return;
    if (user?.role !== "buyer") {
      // Only a still-role='buyer' account can have a BLOCKING first-time
      // application, an already-'supplier' account's re-verification
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
    // pendingApplicationChecked is read (as a guard), not a re-trigger
    // deliberately excluded so this doesn't re-run the instant it flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyForDashboard, user]);

  useEffect(() => {
    if (!readyForDashboard) return;
    if (!pendingApplicationChecked) return; // wait for the pending-application check first
    if (pendingApplication) return; // blocked, PendingVerificationScreen renders instead of redirecting
    // Was `role === "admin" ? "/admin" : "/buyer"`, which silently sent
    // EVERY non-admin role, including 'supplier', to /buyer. A supplier
    // has no buyer access anymore (see BuyerDashboard's own guard below,
    // and SupplierDashboard's switchLinks no longer offering the link at
    // all), this was the actual root cause, not just a stray nav link.
    const destination = user?.role === "admin" ? "/admin" : user?.role === "supplier" ? "/supplier" : "/buyer";
    // ?welcome=1 is the buyer dashboard's cue to offer the push-
    // notification soft prompt as literally the first thing after sign
    // up, instead of waiting for a later "value is obvious" moment
    // (funding an order) some buyers might never reach quickly, or at
    // all. Only added on the actual onboarding-just-completed redirect,
    // never on a returning user's routine bounce through this same path.
    router.replace(justOnboardedRef.current ? `${destination}?welcome=1` : destination);
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
    // above is about to fire, both cases show the same loader.
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
    if (!form.profilePictureUrl.trim()) {
      setError("A profile picture is required.");
      return;
    }
    if (
      form.path === "supplier" &&
      !(form.companyName.trim() && form.companyPhone.trim() && form.primaryLocation.trim() && form.whatTheySell.trim())
    ) {
      setError("Business name, phone number, location, and what you sell are required for supplier verification.");
      return;
    }
    if (form.path === "supplier" && !(form.cacRegistrationNumber.trim() && form.taxIdNumber.trim())) {
      setError("CAC registration number and Tax ID are required for supplier verification.");
      return;
    }
    if (
      form.path === "supplier" &&
      !(
        form.supportingDocumentType.trim() &&
        form.supportingDocumentUrl.trim() &&
        form.payoutBankName.trim() &&
        form.payoutAccountNumber.trim() &&
        form.payoutAccountName.trim()
      )
    ) {
      setError("A document type, its supporting photo, and your payout bank details are required — this is how you'll be paid.");
      return;
    }

    // Set BEFORE completeOnboarding, not after: that call's own success
    // is what flips needsOnboarding -> readyForDashboard -> true, which
    // is exactly what fires the checking effect this ref exists to hold
    // off — it has to already be true by the time that state update
    // lands, not merely by the time this function gets around to its
    // own POST a few lines later.
    if (form.path === "supplier") submittingApplicationRef.current = true;

    const result = await completeOnboarding(form.username.trim(), form.profilePictureUrl.trim());
    if (!result.success) {
      submittingApplicationRef.current = false;
      setError(result.error || "Something went wrong.");
      return;
    }
    justOnboardedRef.current = true;

    // The profile save always happens; the application is a second,
    // independent step on top of it, a failure here shouldn't undo the
    // profile that already saved, just surface its own error and let them
    // retry from the (now buyer) dashboard rather than getting stuck here.
    if (form.path === "supplier") {
      try {
        const res = await fetch("/api/supplier-verification", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessName: form.companyName,
            phone: form.companyPhone,
            businessLocation: form.primaryLocation,
            whatTheySell: form.whatTheySell,
            cacRegistrationNumber: form.cacRegistrationNumber,
            taxIdNumber: form.taxIdNumber,
            supportingDocumentType: form.supportingDocumentType,
            supportingDocumentUrl: form.supportingDocumentUrl,
            payoutBankName: form.payoutBankName,
            payoutAccountNumber: form.payoutAccountNumber,
            payoutAccountName: form.payoutAccountName,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to submit your application.");
        notify("success", "Verification application submitted. An admin will review it.");
        // Set directly from the response rather than waiting on the
        // pending-application effect to refetch — this IS the correct
        // value, no need to ask again.
        setPendingApplicationChecked(true);
        setPendingApplication(data.application);
      } catch (err) {
        notify("error", err instanceof Error ? err.message : "Failed to submit your application.");
      } finally {
        // Either outcome: no submission is in flight anymore. On
        // success this is a no-op in practice (pendingApplicationChecked
        // is already true, so the checking effect's own earlier guard
        // stops it regardless) — on failure this is what lets that
        // effect run its normal check on a later render instead of
        // being held off forever.
        submittingApplicationRef.current = false;
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
