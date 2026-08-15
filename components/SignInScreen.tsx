// components/SignInScreen.tsx
//
// Rewritten for the architectural-editorial direction: the previous
// version leaned on crypto-security theater copy ("Establish Secure
// Connection", "Multi-factor hardware key management", a glowing green
// shield SVG with colors hardcoded outside the token system, "CONFORMS TO
// SECURE CUSTODY STANDARDS ON SYSTEM NETWORK INFRASTRUCTURE" — a sentence
// that doesn't actually mean anything). None of that is what SourceFi
// does. What it does: a person physically visits a supplier and proves
// it, before money moves. That's the pitch now.
import React, { useState } from "react";
import Image from "next/image";
import { ArrowRight, Loader2, MapPin, Camera, ShieldCheck, HandCoins } from "lucide-react";
import ThemeToggle from "./ui/ThemeToggle";

// How long the button stays suspended after a click. This isn't guessing at
// how long Privy's own modal takes — it's just long enough to absorb a
// rapid double-click before the modal has visibly opened, without ever
// getting permanently stuck if the user closes that modal without
// finishing (Privy doesn't give a clean "the user cancelled" callback to
// key a real loading state off of; RootGate's own checkingSession already
// covers the real slow phase — session establishment — once the user is
// actually authenticated).
const CLICK_SUSPEND_MS = 4000;

interface StepProps {
  index: string;
  icon: React.ReactNode;
  title: string;
  desc: string;
}

function Step({ index, icon, title, desc }: StepProps) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-accent-text">
          {icon}
        </div>
        <div className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="pb-8">
        <div className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">{index}</div>
        <h3 className="mb-1 text-base font-semibold text-text-primary">{title}</h3>
        <p className="m-0 text-sm leading-relaxed text-text-secondary">{desc}</p>
      </div>
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
    <div className="relative min-h-screen bg-bg">
      <ThemeToggle className="fixed right-5 top-5 z-10" />

      <div className="mx-auto grid min-h-screen max-w-6xl grid-cols-1 items-center gap-16 px-6 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:px-10">
        {/* Editorial side */}
        <div className="max-w-xl">
          <Image src="/logo-mark.png" alt="SourceFi" width={44} height={44} className="mb-5 rounded-lg" priority />
          <div className="mb-6 text-xs font-semibold uppercase tracking-[0.2em] text-accent-text">
            Sourcing for Nigerian construction
          </div>
          <h1 className="mb-5 font-display text-5xl italic leading-[1.05] text-text-primary sm:text-6xl">
            Materials you can&rsquo;t find, verified before you pay.
          </h1>
          <p className="mb-10 max-w-md text-base leading-relaxed text-text-secondary">
            BubbleDeck slabs, LC3 cement, GFRP rebar: specialty materials that are hard to source and risky to pay
            for sight-unseen. A vetted field agent visits the supplier in person, and your funds stay in escrow
            until you approve what they found.
          </p>

          <div>
            <Step
              index="01"
              icon={<HandCoins size={16} />}
              title="Post what you need"
              desc="Material, budget, delivery location: broadcast to our network of accredited sourcing partners."
            />
            <Step
              index="02"
              icon={<MapPin size={16} />}
              title="A partner visits the supplier"
              desc="Live video, GPS-tagged photos, and the supplier's registration, captured on-site, not typed in later."
            />
            <Step
              index="03"
              icon={<Camera size={16} />}
              title="You review the evidence"
              desc="See exactly what was found before a naira moves. Reject it and your funds stay put."
            />
            <div className="flex gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-accent-text">
                <ShieldCheck size={16} />
              </div>
              <div>
                <div className="mb-0.5 text-xs font-semibold uppercase tracking-wide text-text-tertiary">04</div>
                <h3 className="mb-1 text-base font-semibold text-text-primary">Funds release on your approval</h3>
                <p className="m-0 text-sm leading-relaxed text-text-secondary">
                  Not before. Not automatically. Your call, every time.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Sign-in card */}
        <div className="w-full rounded-2xl border border-border bg-surface p-9 shadow-lg">
          <h2 className="mb-1.5 font-display text-2xl italic text-text-primary">Welcome to SourceFi</h2>
          <p className="mb-7 text-sm leading-relaxed text-text-secondary">
            Sign in to post a sourcing request, or to review the mandates waiting for a verified partner.
          </p>

          <button
            type="button"
            onClick={handleClick}
            disabled={suspended}
            aria-busy={suspended || undefined}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-0 py-3.5 text-sm font-bold text-accent-contrast transition-[filter] duration-base ease-base hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
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
          </button>

          <p className="mt-4 text-center text-xs leading-relaxed text-text-tertiary">
            Email, Google, or a connected wallet: whichever you already use.
          </p>
        </div>
      </div>
    </div>
  );
}
