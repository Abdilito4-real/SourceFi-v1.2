// components/SignInScreen.tsx
//
// Split-screen redesign to a supplied reference mockup (cream/gold/green
// editorial direction): an editorial hero on the left, a white auth card
// on the right, real site photography (public/site.jpg) faded in behind
// both via SiteBackground below. This IS the Rebrand-I palette already
// locked in by
// app/globals.css (--color-bg #f6f2ea, --color-accent #c9963c gold,
// --color-success #10bc7c/--color-success-text #0a7a54 for the green
// trust accent), just restructured, no new hex values added anywhere in
// this file, every color below is one of that token set's existing
// Tailwind names.
//
// Auth stays exactly what it was: a single Privy `login()` call
// (onAuthenticate, wired all the way up through SessionProvider ->
// RootGate). Privy's own modal is what actually offers Google/email/
// wallet once it opens, this app has never had three independent
// sign-in code paths. The reference mockup shows three buttons, so
// three render, but all four buttons on this page (the primary
// "Continue" included) call the same handleClick/onAuthenticate, same
// as the pre-redesign single-button version did. Wiring each to a
// distinct provider would mean inventing auth flows (direct Google
// OAuth, direct wallet-connect, bypassing Privy) that don't exist in
// this codebase, exactly what "don't rewrite the authentication logic"
// rules out.
import React, { useState } from "react";
import Image from "next/image";
import { ArrowRight, Loader2, MapPin, Camera, ShieldCheck, HandCoins, Mail, Wallet } from "lucide-react";
import Button from "./ui/Button";
import ThemeToggle from "./ui/ThemeToggle";

// How long the button stays suspended after a click. This isn't guessing at
// how long Privy's own modal takes, it's just long enough to absorb a
// rapid double-click before the modal has visibly opened, without ever
// getting permanently stuck if the user closes that modal without
// finishing (Privy doesn't give a clean "the user cancelled" callback to
// key a real loading state off of; RootGate's own checkingSession already
// covers the real slow phase, session establishment, once the user is
// actually authenticated).
const CLICK_SUSPEND_MS = 4000;

interface ProcessStepProps {
  icon: React.ReactNode;
  title: string;
  desc: string;
}

function ProcessStep({ icon, title, desc }: ProcessStepProps) {
  return (
    <div>
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border-strong text-text-primary">
        {icon}
      </div>
      <h3 className="mb-1 text-sm font-semibold text-text-primary">{title}</h3>
      <p className="m-0 text-xs leading-relaxed text-text-secondary">{desc}</p>
    </div>
  );
}

// Official Google "G" logomark, the standard four-color icon used on
// "Continue with Google" buttons everywhere, inlined so the button
// doesn't depend on an external icon font/image fetch.
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.9v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.9A9 9 0 0 0 0 9c0 1.45.35 2.83.9 4.03l3.05-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .9 4.97l3.05 2.33C4.66 5.17 6.65 3.58 9 3.58Z" />
    </svg>
  );
}

// Real site photography (public/site.jpg, added by the team), full-bleed
// behind the whole page, on every screen size. next/image's `sizes="100vw"`
// still keeps this data-conscious per CLAUDE.md's mobile-data constraint:
// it makes Next request a srcset variant matched to the actual device
// width, so a narrow phone downloads a small crop, not the same file a
// 1440px desktop gets, rather than skipping the photo outright.
//
// Two scrims, not one, because the two layouts put text in very
// different places. At lg+ (the two-column split) text only lives in
// the left half, so the scrim can fade left-to-right, strong over the
// hero copy and easing off toward the card (which is opaque and doesn't
// need the help). Below lg the sections stack full-width top to bottom,
// covering nearly the whole viewport height, so a directional fade
// would leave some stacked section under the "faded" end with too
// little contrast; the mobile scrim is instead a flat, strong tint
// applied uniformly.
//
// Both are built with CSS color-mix() against var(--color-bg) directly
// rather than Tailwind's bg-bg/NN opacity-modifier syntax: that syntax
// only computes a real alpha for colors Tailwind can decompose into RGB
// channels, and every token in this file's home (app/globals.css) is a
// plain hex string behind a CSS variable, so bg-bg/NN silently resolves
// to fully transparent instead of translucent cream (confirmed by
// inspecting the computed background-image, it fell back to
// rgba(255,255,255,0)). color-mix() reads the same --color-bg custom
// property directly, no new hex value added here, and both scrims stay
// correct in dark mode for free.
function SiteBackground() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <Image src="/site.jpg" alt="" fill sizes="100vw" className="object-cover" />
      <div
        className="absolute inset-0 lg:hidden"
        style={{ background: "color-mix(in srgb, var(--color-bg) 82%, transparent)" }}
      />
      <div
        className="absolute inset-0 hidden lg:block"
        style={{
          background:
            "linear-gradient(to right, color-mix(in srgb, var(--color-bg) 95%, transparent) 0%, color-mix(in srgb, var(--color-bg) 88%, transparent) 40%, color-mix(in srgb, var(--color-bg) 55%, transparent) 75%, color-mix(in srgb, var(--color-bg) 35%, transparent) 100%)",
        }}
      />
    </div>
  );
}

export default function SignInScreen({ onAuthenticate }: { onAuthenticate: () => void }) {
  const [suspended, setSuspended] = useState(false);

  const handleClick = () => {
    if (suspended) return;
    setSuspended(true);
    onAuthenticate();
    setTimeout(() => setSuspended(false), CLICK_SUSPEND_MS);
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-bg">
      <ThemeToggle className="fixed right-5 top-5 z-10" />
      <SiteBackground />

      <div className="relative mx-auto grid min-h-screen max-w-7xl grid-cols-1 items-center gap-14 px-6 py-16 lg:grid-cols-[1.15fr_0.85fr] lg:gap-10 lg:px-12">
        {/* Editorial side */}
        <div className="max-w-xl">
          <div className="mb-8 flex items-center gap-2.5">
            <Image src="/logo-mark.png" alt="" width={36} height={36} className="rounded-lg" priority />
            <span className="font-display text-xl font-bold text-text-primary">SourceFi</span>
          </div>

          <div className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-accent-text">
            Sourcing for Nigerian construction
          </div>
          <h1 className="mb-5 font-display text-5xl font-extrabold leading-[1.05] text-text-primary sm:text-6xl">
            Verify before
            <br />
            you pay<span className="text-accent-text">.</span>
          </h1>
          <p className="mb-10 max-w-md text-base leading-relaxed text-text-secondary">
            SourceFi helps you source hard-to-find construction materials with confidence. Vetted suppliers.
            Verified evidence. Funds held in escrow until you approve what you receive.
          </p>

          <div className="mb-8 grid grid-cols-2 gap-x-6 gap-y-7 sm:grid-cols-4">
            <ProcessStep
              icon={<HandCoins size={16} />}
              title="Post What You Need"
              desc="Share material, budget, location to our network."
            />
            <ProcessStep
              icon={<MapPin size={16} />}
              title="Partner Visits Supplier"
              desc="We verify in person and capture real evidence."
            />
            <ProcessStep
              icon={<Camera size={16} />}
              title="You Review Evidence"
              desc="See live proof before you approve or pay."
            />
            <ProcessStep
              icon={<ShieldCheck size={16} />}
              title="Funds Released"
              desc="Released to supplier only after your approval."
            />
          </div>

          <div className="flex items-start gap-3 rounded-xl border border-border bg-success-soft px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success text-white">
              <ShieldCheck size={17} />
            </div>
            <div>
              <div className="mb-0.5 text-sm font-semibold text-text-primary">Your funds stay safe</div>
              <p className="m-0 text-xs leading-relaxed text-text-secondary">
                Payments are held in escrow and only released when you approve.
              </p>
            </div>
          </div>
        </div>

        {/* Sign-in card */}
        <div className="relative mx-auto w-full max-w-[480px] rounded-2xl border border-border bg-surface p-9 shadow-lg sm:p-10 lg:justify-self-end">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-border bg-surface">
            <Image src="/logo-mark.png" alt="SourceFi" width={34} height={34} className="rounded-md" priority />
          </div>
          <h2 className="mb-1.5 text-center text-2xl font-bold text-text-primary">Welcome to SourceFi</h2>
          <p className="mb-7 text-center text-sm leading-relaxed text-text-secondary">
            Sign in to post a sourcing request, or review the mandates waiting for a verified partner.
          </p>

          <Button
            type="button"
            variant="primary"
            size="lg"
            fullWidth
            onClick={handleClick}
            disabled={suspended}
            aria-busy={suspended || undefined}
            className="font-bold"
          >
            {suspended ? (
              <>
                <Loader2 size={15} className="spin-icon" /> Opening…
              </>
            ) : (
              <>
                Continue <ArrowRight size={15} />
              </>
            )}
          </Button>

          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium text-text-tertiary">or continue with</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="flex flex-col gap-3">
            <Button type="button" variant="secondary" size="lg" fullWidth onClick={handleClick} disabled={suspended}>
              <GoogleIcon /> Continue with Google
            </Button>
            <Button type="button" variant="secondary" size="lg" fullWidth onClick={handleClick} disabled={suspended}>
              <Mail size={16} /> Continue with Email
            </Button>
            <Button type="button" variant="secondary" size="lg" fullWidth onClick={handleClick} disabled={suspended}>
              <Wallet size={16} /> Continue with Wallet
            </Button>
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-text-tertiary">
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}
