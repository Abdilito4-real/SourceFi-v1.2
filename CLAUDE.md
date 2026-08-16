# SourceFi Project Context

## What this is
A construction-materials sourcing platform for Nigeria. Buyers need
specialty materials (BubbleDeck slabs, LC3 cement, geopolymer concrete,
compressed earth blocks, GFRP rebar) that are hard to find locally and
risky to pay for sight-unseen. SourceFi solves trust, not catalog.

## The core flow
1. Buyer posts a sourcing request: material, budget, delivery location.
2. A vetted "sourcer" (field agent) claims it and names their fee.
3. Buyer funds escrow.
4. Sourcer physically visits the supplier: live video, GPS-tagged photos,
   supplier CAC/licence number, one-time handshake code from supplier.
5. Sourcer submits a verified audit report.
6. Buyer approves; funds release. Sourcer's reputation updates.
7. Buyer can reject; the dispute path takes over.

## Users
- **Buyers**: contractors, developers, architects. Desktop and mobile.
- **Sourcers**: field agents in Lagos, Kano, Abuja, Port Harcourt.
  Working from a phone, in a warehouse, on patchy mobile data.
  Mobile experience is not a nice-to-have for them; it is the product.
- **Admins**: vet sourcers, resolve disputes.

## Constraints that shape every decision
- Users are on Android mid-range phones and metered data. Keep bundles small.
- Naira is the unit people think in. Any crypto rails stay invisible.
- Nigerian business context: CAC registration numbers, VAT, WHT on invoices.
- Network drops mid-task. Offline tolerance matters for the sourcer flow.

## Engineering rules
- Never write money-moving logic without a matching test that proves
  funds cannot be lost, double-spent, or released without authorisation.
- Every state transition on a request must be explicit and logged.
- No secrets in client code. No trusting client-supplied amounts, roles,
  or status values, ever.
- If a task touches escrow, KYC, or payouts, stop and flag it for human
  review rather than guessing at the rules.

## Rebrand direction (locked in)
Two visual directions exist as PNG mockups (`Rebrand-I` = light surface,
navy sidebar, gold/amber accents; `Rebrand-II` = dark surface, green
accents). Decision: this is not an either/or, build the design system
theme-aware. `Rebrand-II` (dark/green) is the dark-mode palette;
`Rebrand-I` (light/navy+gold) is the light-mode palette. Both must be
defined as token sets from the start (see Stage 2), not one retrofitted
onto the other.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
