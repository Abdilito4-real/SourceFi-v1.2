"use client";

// components/OnboardingCarousel.tsx
//
// First-time-visitor intro, shown once before SignInScreen (see RootGate.tsx
// — gated behind a localStorage flag, same pattern as the theme
// preference). Mobile-first: each slide is a vertical image/content split
// on narrow viewports, switching to a horizontal split at sm+. Swipeable on
// touch, arrow/dot navigation everywhere else.
//
// Images are real photography, not icons — CLAUDE.md's "keep bundles
// small, metered mobile data" constraint is why only the active and
// adjacent slides' images are ever requested (next/image, no eager-loading
// the whole set up front) rather than preloading all five at once.
import React, { useRef, useState } from "react";
import Image from "next/image";
import { ArrowRight, X } from "lucide-react";
import { cn } from "./ui/cn";

interface Slide {
  eyebrow: string;
  title: string;
  body: string;
  image?: string;
}

const SLIDES: Slide[] = [
  {
    eyebrow: "Welcome to SourceFi",
    title: "Trusted sourcing. Stronger buildings.",
    body: "Specialty construction materials that are hard to find in Nigeria and risky to pay for sight-unseen, sourced, verified, and paid for safely, all in one place.",
    image: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=900&q=70",
  },
  {
    eyebrow: "01 · Post what you need",
    title: "Tell us the material, budget, and site.",
    body: "BubbleDeck slabs, LC3 cement, GFRP rebar: post a request and it goes out to our network of accredited sourcing partners.",
    image: "https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=900&q=70",
  },
  {
    eyebrow: "02 · Verified on-site",
    title: "A partner visits the supplier in person.",
    body: "Live video, GPS-tagged photos, and the supplier's own registration, captured on the ground, not typed in later.",
    image: "https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=900&q=70",
  },
  {
    eyebrow: "03 · Capital, protected",
    title: "Your funds stay in escrow until you approve.",
    body: "Nothing releases to a sourcing partner until you've reviewed the evidence yourself and confirmed the material is right.",
    image: "https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=900&q=70",
  },
  {
    eyebrow: "04 · You're in control",
    title: "Every step, your call.",
    body: "Approve, reject, or ask for more evidence. Reputations update on real outcomes, not seeded numbers.",
  },
];

export default function OnboardingCarousel({ onComplete }: { onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const isLast = index === SLIDES.length - 1;

  const goTo = (i: number) => setIndex(Math.max(0, Math.min(SLIDES.length - 1, i)));
  const next = () => (isLast ? onComplete() : goTo(index + 1));

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return;
    const deltaX = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(deltaX) < 40) return; // not a deliberate swipe
    if (deltaX < 0) goTo(index + 1); // swiped left -> next
    else goTo(index - 1); // swiped right -> back
  };

  const slide = SLIDES[index];
  if (!slide) return null;

  return (
    <div className="fixed inset-0 z-[1200] flex flex-col bg-bg">
      <button
        type="button"
        onClick={onComplete}
        className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-surface/80 px-3 py-1.5 text-xs font-semibold text-text-secondary backdrop-blur hover:text-text-primary sm:right-6 sm:top-6"
      >
        Skip <X size={13} />
      </button>

      <div
        className="relative flex flex-1 flex-col overflow-hidden sm:flex-row"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Background: full-bleed on mobile (content overlays on top of it —
            every slide, including the closing one, now gets this same
            treatment), left half on desktop. What renders inside differs:
            real photography for the first four slides, the brand mark on a
            solid brand-color backdrop for the closing slide, since there's
            no photo for it. */}
        <div className="absolute inset-0 shrink-0 overflow-hidden bg-nav-bg sm:relative sm:inset-auto sm:w-1/2">
          {slide.image ? (
            <Image
              src={slide.image}
              alt=""
              fill
              sizes="(min-width: 640px) 50vw, 100vw"
              className="object-cover"
              priority={index === 0}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Image
                src="/logo-mark.png"
                alt=""
                width={220}
                height={220}
                className="h-40 w-40 rounded-3xl sm:h-56 sm:w-56"
              />
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent sm:bg-gradient-to-r sm:from-black/10 sm:via-transparent sm:to-transparent" />
        </div>

        {/* Content: overlaid at the bottom on mobile (needs light text
            against the dark scrim above, on every slide now), a normal side
            panel on desktop (needs the theme's usual text tokens against the
            plain page background). */}
        <div className="relative z-10 mt-auto flex flex-1 flex-col justify-end px-6 pb-8 pt-16 sm:mt-0 sm:justify-between sm:px-14 sm:py-14 sm:w-1/2">
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center sm:flex-initial">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-accent sm:text-accent-text">{slide.eyebrow}</div>
            <h2 className="mb-4 font-display text-3xl italic leading-tight text-white sm:text-4xl sm:text-text-primary">{slide.title}</h2>
            <p className="text-base leading-relaxed text-white/90 sm:text-text-secondary">{slide.body}</p>
          </div>

          <div className="mx-auto flex w-full max-w-md items-center justify-between pt-8">
            <div className="flex items-center gap-2" role="tablist" aria-label="Onboarding progress">
              {SLIDES.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  aria-label={`Go to slide ${i + 1} of ${SLIDES.length}`}
                  onClick={() => goTo(i)}
                  className={cn(
                    "h-2 rounded-pill transition-[width,background-color] duration-base ease-base",
                    i === index ? "w-6 bg-accent" : "w-2 bg-border-strong hover:bg-text-tertiary"
                  )}
                />
              ))}
            </div>

            {isLast ? (
              <button
                type="button"
                onClick={onComplete}
                className="flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-bold text-accent-contrast transition-[filter] duration-base ease-base hover:brightness-95"
              >
                Get started <ArrowRight size={15} />
              </button>
            ) : (
              <button
                type="button"
                onClick={next}
                aria-label="Next"
                className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-accent-contrast transition-[filter] duration-base ease-base hover:brightness-95"
              >
                <ArrowRight size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
