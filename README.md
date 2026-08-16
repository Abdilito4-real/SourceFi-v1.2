# SourceFi

Verified sourcing and escrow-protected procurement for hard-to-find
construction materials in Nigeria (BubbleDeck slabs, LC3 cement, geopolymer
concrete, compressed earth blocks, GFRP rebar). A buyer posts what they
need; a vetted field agent ("sourcer") visits the supplier in person,
verifies it with photos/video/handshake code, and funds only release once
the buyer approves. See [CLAUDE.md](CLAUDE.md) for the full product context
and engineering rules this project follows.

## Project status

This is an MVP-stage codebase, not a production system. Design system, PWA,
the TypeScript migration, Stage 4 (real auth/roles), and Stage 5 (real data
layer: normalized schema, money as integer minor units, a server-side
state machine, real row-level visibility) are done, as is a full dashboard
redesign — separate `/buyer`, `/sourcer`, and `/admin` routes instead of one
role-toggled page. Becoming a sourcer is now a real in-app flow too: pick
"become a sourcing partner" at onboarding, an admin reviews it at `/admin`
and approves or rejects. Still open:

- **Escrow release has a known type-level bug in the Circle SDK call**
  (`app/api/escrow/route.ts`) — the transfer request uses the wrong field
  name and the response type has no `txHash` field, meaning real escrow
  releases currently fall through to a fabricated transaction hash rather
  than the real one. Deliberately left as-is and flagged, not silently
  patched, since it's money-moving code (see CLAUDE.md's engineering
  rules).
- **No double-entry ledger yet.** `escrow_transactions` is an append-only
  log, not the balanced ledger with timeouts/refunds Stage 6 builds.
- **The handshake code is still hardcoded `1234`**, and photo evidence
  isn't checked against GPS/EXIF — both explicitly Stage 7's job
  ("verification integrity"), not touched by Stage 5 or the redesign.
- **No dispute path.** A buyer who rejects an audit has no recourse yet
  (Stage 8).

Treat this as a strong foundation to keep building on, not a finished
product.

## Tech stack

- **Next.js 16** (App Router, webpack — see note below) + **React 18** +
  **TypeScript 7** (strict mode)
- **Tailwind CSS**, theme-aware design tokens (light = navy/gold, dark =
  slate/mint) driven entirely by CSS custom properties — see
  `app/globals.css` and `components/ui/*`. Light is the default theme
  regardless of OS preference (`components/ui/ThemeScript.tsx`); dark is
  opt-in via the toggle. Display type is Circular (Lineto), scoped to
  headings/prominent UI text — a paid font this repo doesn't bundle, so
  it renders only where already available (a viewer's device, or a real
  licensed self-host later); body text, UI chrome, and the display
  fallback all render as Roboto today. See `app/layout.tsx`.
- **Auth: Privy proves identity once, this app runs its own session.**
  Privy (email/Google/wallet login) issues a short-lived access token;
  the server verifies it once via `@privy-io/node` and mints its own
  signed, httpOnly session cookie (`jose`) that every protected route
  actually checks. See "Auth & roles" below.
- **wagmi** + **viem** for the wallet layer, **Circle** developer-controlled
  wallets for escrow transfers
- **Supabase** (Postgres) for data
- Installable **PWA** via `@ducanh2912/next-pwa` (Workbox under the hood):
  offline fallback page, update-available prompt, install prompt
- **Vitest** for the authorization test suite

> **Why webpack, not Turbopack?** Next 16 defaults to Turbopack for both
> `dev` and `build`, but the PWA plugin wraps `workbox-webpack-plugin` — a
> webpack-only tool. `package.json`'s scripts pass `--webpack` explicitly;
> this is intentional, not a leftover migration step (see the comment in
> `next.config.mjs`).

## Auth & roles

Three roles: `buyer`, `sourcer`, `admin` — stored in `users.role`, checked
server-side on every protected action via `lib/authz.ts`'s
`requireRole()`. The client's copy of the role (from `GET /api/auth/me`)
is a display hint only; nothing trusts it for an authorization decision.

- **No self-service path to `sourcer` or `admin`.** The old "Sourcer
  Access" shared-password gate is gone entirely. A buyer can apply to
  become a sourcer at onboarding (`sourcer_applications` table), but
  applying isn't granting — only an admin approving it at `/admin` flips
  `users.role`. `admin` has no application path at all; it's only ever
  `PATCH /api/admin/users/[id]/role` by an existing admin, audit-logged.
- **The first admin is a direct database write** — see the bottom of
  `supabase/migrations/0000_fresh_project_full_schema.sql` (or
  `0001_stage4_auth.sql` if you're on the original project). There's no
  bootstrap UI on purpose; that first grant is exactly the moment you
  don't want a client request deciding anything. Everyone after that is
  granted through the `/admin` dashboard, no SQL required.
- **Login/session-establishment and role changes are rate-limited** with
  exponential backoff (`lib/rateLimit.ts`). It's in-memory, which is fine
  for a single dev server but won't hold limits across serverless
  instances — swapping in a shared store (Upstash Redis, etc.) behind the
  same three-function interface is the production follow-up.
- **`npm test`** runs `tests/authz.test.ts`, which proves a buyer session
  can't reach sourcer- or admin-only actions — including via a forged
  session claiming a different role, since `SessionClaims` never carries
  a role field to forge in the first place.
- **Admin can view every dashboard, not act on any of them.** `/sourcer`
  and `/buyer` let an admin in for oversight, but claiming a job, funding
  escrow, submitting an audit — every one of those routes still checks
  `requireRole(["sourcer"])` or `requireRole(["buyer"])` specifically, never `admin`
  as a fallback. The UI disables those buttons for an admin viewer too
  (`canTransact` prop on `RequestDetailsModal`/`TransactionLedger`)
  instead of letting them fill out a form that was always going to 403.

## Getting started

**Prerequisites:** Node.js 18.17+, npm.

```bash
git clone <this-repo>
cd arc-sourcing-app
npm install
cp .env.local.example .env.local
```

Fill in the values in `.env.local` — see that file for what each one is
and where to get it (Supabase, Privy, Reown, Circle dashboards).

Before running the app, apply the migrations against your Supabase project
(SQL editor, or `supabase db push` if you use the CLI). Two starting
points, pick one:

- **Brand-new, empty project:** `0000_fresh_project_full_schema.sql`, then
  `fresh_0001_sourcer_applications.sql`.
- **The original project** (predates Stage 5): `0001_stage4_auth.sql`,
  `0002_stage5_data_layer.sql`, `0003_align_sourcing_requests.sql`, then
  `fresh_0001_sourcer_applications.sql` — yes, despite the name, that last
  one is a plain additive `create table if not exists` and runs fine on
  either lineage.

Each file says at the top which project it's for — read that before
running anything. Then:

```bash
npm run dev
```

Open http://localhost:3000. If it errors, copy the terminal output before
changing anything else.

On Windows, if `npm run dev` takes ages just to boot (`next.config.mjs`
alone taking 40s+), check your antivirus's real-time scanning first —
Defender scanning the project folder on every file read is the usual
cause, and excluding the folder (`Add-MpPreference -ExclusionPath`) can
turn that 40s+ into ~2s.

### A note on `.env.local`

Without a real `NEXT_PUBLIC_PRIVY_APP_ID` (and `PRIVY_APP_SECRET`,
`SESSION_SECRET`), the app shows a "Privy isn't configured yet" screen
instead of the sign-in flow — see `components/Web3Providers.tsx`. Two
routes work with **no** credentials at all, useful for checking the app
itself is healthy: **`/design-system`** (every shared UI primitive, both
themes) and **`/offline`** (the PWA offline fallback page).

## Available scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server (webpack, not Turbopack — see Tech stack). PWA/service worker is **disabled** in dev — HMR and SW caching fight each other. |
| `npm run build` | Production build. This is what actually generates the service worker, precache manifest, and icons. |
| `npm start` | Serves the production build from `npm run build`. Use this (not `dev`) to test PWA install/offline/update behavior. |
| `npm test` | Runs the Vitest authorization test suite. |
| `npm run lint` | Next's built-in ESLint config. |

## Project structure

```
app/
  (main)/            # Wrapped in Web3Providers (Privy) + SessionProvider.
                      # Route group so routes outside it don't pay for the
                      # wallet bundle or need Privy creds.
    page.tsx          # Gate: sign in / finish onboarding / redirect to /buyer or /admin
    buyer/page.tsx      # Buyer dashboard route
    sourcer/page.tsx      # Sourcer dashboard route (redirects out if ineligible)
    admin/page.tsx        # Admin dashboard route (applications, users) — admin-only
  api/
    auth/            # session (login/logout), me (read role, set username)
    admin/           # users (list), users/[id]/role (promote/demote), sourcer-applications (review) — all admin-only, audit-logged
    sourcer-applications/  # POST — a buyer applying to become a sourcer; never grants anything by itself
    escrow/, requests/  # every state-changing action is role-, ownership-,
                         # and state-machine-checked server-side; see
                         # lib/authz.ts and lib/requestStateMachine.ts
    create-wallet/   # unused — dead remnant of an abandoned Circle flow, kept only because it's harmless and documented as such in the Stage 1 audit
  design-system/      # Design-system preview route — no auth, no wallet deps
  offline/            # PWA offline fallback page
  icon.png, apple-icon.png  # Static files, cropped from the brand logo — see public/logo-mark.png
  manifest.ts
  globals.css         # All design tokens (light + dark) live here, nowhere else
components/
  ui/                 # Shared primitives: Button, Modal, Toast, Field, Table, Badge, StatCard…
  SessionProvider.tsx    # Auth/requests state shared across every (main) route
  DashboardShell.tsx       # Sidebar + header shell all three dashboards render inside
  BuyerDashboard.tsx, SourcerDashboard.tsx, AdminDashboard.tsx  # The three real dashboards
  RootGate.tsx              # Sign-in / onboarding / redirect logic for "/"
  OnboardingScreen.tsx, OnboardingCarousel.tsx  # Profile setup + the buyer/sourcer-applicant path choice
  RequestCard.tsx, RequestDetailsModal.tsx, TransactionLedger.tsx  # Shared request UI
  ClientOnly*.tsx            # ssr:false boundaries — see the comment in each
lib/
  types.ts            # Shared TypeScript types, matching the real schema (Stage 5)
  money.ts             # Integer minor units <-> display amount, in one place
  requestStateMachine.ts # The one place sourcing_requests.status transitions are defined
  authz.ts               # requireSession/requireRole/logAudit — the one choke point every protected route goes through
  session.ts               # this app's own signed httpOnly session cookie
  privyServer.ts             # server-side Privy access-token verification
  rateLimit.ts                # in-memory backoff limiter
  constants.ts                 # Material catalog, chain config, on-chain transfer helper
  supabaseServer.ts, wagmi-config.ts
supabase/migrations/  # 0000_fresh_project_full_schema.sql (new project) or
                       # 0001..0003 (original project), plus
                       # fresh_0001_sourcer_applications.sql either way —
                       # see the comment at the top of each and "Getting started" above
tests/                # Vitest — authz boundary tests + state machine tests
```

## Design system

`/design-system` renders every shared primitive (buttons, form fields,
cards, tables, badges, modal, toast, skeleton, empty state) against the
live theme tokens, with a toggle to check both palettes. Check here before
building new UI, and update it alongside `components/ui/*` if you add a
new primitive.

## Deploying

**GitHub:**
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin YOUR_REPO_URL_HERE
git push -u origin main
```

**Vercel:** go to vercel.com → Add New Project → select the repo → add the
same environment variables from `.env.local` in the project settings →
Deploy. Vercel auto-detects Next.js; no config changes needed. Remember to
apply the same migrations from "Getting started" against your production
Supabase project too — that's a manual step, not part of the deploy.
