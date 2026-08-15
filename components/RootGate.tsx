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
  } = useSession();

  const [form, setForm] = useState<OnboardingForm>({
    username: "",
    fullName: "",
    companyName: "",
    professionalRole: "Contractor",
    primaryLocation: "",
    path: "buyer",
    applicationExperience: "",
    applicationReason: "",
  });
  const [error, setError] = useState("");
  // null while unknown (avoids a flash of the wrong screen before the
  // localStorage read resolves on mount) — true/false once it has.
  const [introSeen, setIntroSeen] = useState<boolean | null>(null);

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
    if (readyForDashboard) router.replace(user?.role === "admin" ? "/admin" : "/buyer");
  }, [readyForDashboard, user, router]);

  if (checkingSession || readyForDashboard || introSeen === null) {
    const phase: Phase = readyForDashboard ? 2 : authenticated ? 1 : 0;
    return <FullPageLoader phase={phase} />;
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
    if (form.path === "sourcer" && !form.applicationReason.trim()) {
      setError("Tell us why you want to become a sourcing partner.");
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
    if (form.path === "sourcer") {
      try {
        const res = await fetch("/api/sourcer-applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: form.primaryLocation,
            experience: form.applicationExperience,
            reason: form.applicationReason,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to submit your application.");
        notify("success", "Application submitted — an admin will review it.");
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
