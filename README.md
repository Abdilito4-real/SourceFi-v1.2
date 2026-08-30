# SourceFi

Verified sourcing and escrow-protected procurement for hard-to-find
construction materials in Nigeria (BubbleDeck slabs, LC3 cement,
geopolymer concrete, compressed earth blocks, GFRP rebar). A buyer
orders directly from a verified supplier; a live verification call
confirms the delivery before funds release from escrow. See
[CLAUDE.md](CLAUDE.md) for the full product context and engineering
rules this project follows.

## Docs

- [docs/architecture.md](docs/architecture.md), stack, request flow,
  folder structure, what's stubbed today.
- [docs/changelog.md](docs/changelog.md), what's been built, stage by
  stage.
- [docs/security.md](docs/security.md), the honest security posture:
  what's protected, partially protected, and unmitigated.
- [docs/payment-integration.md](docs/payment-integration.md), how to
  turn on real Circle/Yellow Card credentials, and what's still
  simulated either way.

## Project status

This is a working marketplace MVP, not a hardened production system.
Real auth, a normalized data layer, a double-entry ledger, a full
order state machine, push notifications, every termination/dispute
flow, and an adversarial security pass are all done (see
[docs/changelog.md](docs/changelog.md)).

Treat this as a strong foundation to keep building on, not a finished
product.

### Still open

**Row Level Security is real on 11 tables, a default-deny backstop
everywhere else.** A per-request JWT (`lib/supabaseUserClient.ts`)
switches the Postgres role to `authenticated` for self- and
order-scoped reads — `orders`, `supplier_profiles`, `payment_events`,
`delivery_proofs`, `disputes`, `ratings`, `notifications`,
`notification_preferences`, `supplier_verification_applications`,
`buyer_kyc_profiles`, `buyer_wallets` — so RLS policies actually run
there instead of being bypassed by the service-role key every other
query still (legitimately) uses. The API route layer stays the primary
authorization boundary everywhere; RLS is a genuine second, independent
layer on those 11 tables specifically, not yet the rest. See
[docs/security.md](docs/security.md).

**Yellow Card funding/refund/settlement are all real now — real
credentials are genuinely the only remaining blocker, one caveat below.**
`lib/yellowCardProvider.ts` calls Yellow Card's actual Business API
(bank-transfer funding, full-amount-only refund, and a real supplier
payout: escrow release pays the supplier's bank account via Yellow
Card's Send API instead of their own crypto wallet) once
`YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` are set; simulated
otherwise. Real settlement additionally needs
`YELLOW_CARD_ESCROW_CRYPTO_NETWORK` set to match Circle's escrow wallet's
actual chain, and production credentials additionally need a static
outbound IP whitelisted.

Audited end to end (integration, security, feedback) to confirm this:
rate limiting and error-message sanitization added to the wallet
top-up/order-fund routes, `ErrorPanel`/typed-confirmation parity added
across every financial admin/buyer/supplier action, and a reconciliation
cron (`lib/yellowCardReconciliation.ts`, mirroring Circle's own) now
backstops the refund/settlement/wallet-topup legs the same way
`lib/releaseReconciliation.ts` already did for Circle. The one thing
that genuinely can't be resolved by writing more code: the webhook
signature scheme (HMAC-SHA256, base64) is confirmed **textually** from
Yellow Card's own docs, but has never been verified byte-for-byte
against a real received webhook (no worked example exists, unlike
request signing) — if that reading is subtly wrong, verification fails
*closed* (401, logged), not open, but every funding/refund/settlement/
top-up webhook would be silently rejected with no crash. Watch server
logs for `Yellow Card webhook: signature did not verify` the moment
real sandbox credentials go in. See
[docs/payment-integration.md](docs/payment-integration.md).

**The buyer wallet's top-up is real but one-way, deliberately.** A
buyer tops up a platform balance and funds orders from it instantly
(`lib/walletService.ts`, `lib/yellowCardWalletTopupProvider.ts`, real
the moment Yellow Card credentials are set), but there is no
withdrawal: Yellow Card's refund API can't give back an unspent
*portion* of a top-up, only refund one whole original transfer. A buyer
who tops up more than they spend has no way to get the difference back
today. See [docs/payment-integration.md](docs/payment-integration.md).

**The live verification call's duration is corroborated between both
parties by default, but only truly tamper-proof once JaaS webhooks are
configured.** `lib/callVerification.ts` requires the buyer's and
supplier's independently reported segments to actually overlap before
any time counts (`lib/orderService.ts`'s `recordVerificationCallProgress`)
— a single dishonest party can no longer fake the whole requirement
alone. What that alone can't stop: two **colluding** accounts (or one
attacker controlling both logins) fabricating matching fake segments
with no real call ever happening. Closing that needs a server-
authoritative signal instead of trusting either client — set
`JAAS_WEBHOOK_SECRET` (see `.env.local.example`) once 8x8 JaaS is
configured, and `app/api/webhooks/jaas/route.ts` takes over as the
sole source of truth, driven by JaaS's own signed `PARTICIPANT_JOINED`/
`PARTICIPANT_LEFT` events instead of client self-reports. Registration
is a manual step in the JaaS Console (Webhooks section), not an API
call — see that route's own header comment.

**On-chain rating submission always returns `"submitted"`, never
`"confirmed"`.** The contract/chain for this isn't decided yet.

**The `ws` and `serialize-javascript` high-severity vulnerabilities are
fixed**, via a `package.json` `overrides` pin
(`ws` >=8.21.0, `serialize-javascript` >=7.0.5) rather than a
major-version bump of Privy or next-pwa themselves, since neither
publishes a version whose own dependency tree resolves to a patched
copy. Verified with a full `npm run build` (the service worker
actually regenerates through `workbox-build`, the path that pulls in
`serialize-javascript`) and the full test suite, not just `npm audit`'s
say-so.

**15 moderate-severity advisories remain**, all several levels deep in
Privy's wallet-connector tree (Reown/WalletConnect, MetaMask, Farcaster,
Solana packages pulled in transitively for wallet login). `npm audit`
has no fix for any of them short of a major Privy bump, which risks
breaking the auth flow every buyer/supplier/admin session depends on —
not attempted blind. Re-run `npm audit` after any Privy upgrade to see
if it's closed the gap upstream.

## Tech stack

### Application

- **Next.js 16** (App Router, webpack, not Turbopack, see the note in
  `next.config.mjs`: the PWA plugin needs `workbox-webpack-plugin`,
  which is webpack-only) + **React 18** + **TypeScript** (strict mode)
- **Tailwind CSS**, theme-aware design tokens (dark = slate/green,
  light = navy/gold) driven entirely by CSS custom properties, see
  `app/globals.css` and `components/ui/*`.
- Installable **PWA** via `@ducanh2912/next-pwa`: offline fallback
  page, update-available prompt, install prompt

### Identity and payments

- **Auth**: Privy proves identity once (email/Google/wallet login),
  this app runs its own session on top. The server verifies Privy's
  token once via `@privy-io/node` and mints its own signed, httpOnly
  session cookie (`jose`) that every protected route checks. See
  [docs/architecture.md](docs/architecture.md).
- **Circle** developer-controlled wallets for USDC escrow release,
  **Yellow Card** for NGN funding/refund (settlement stays simulated by
  design, see [docs/payment-integration.md](docs/payment-integration.md))
- **Supabase** (Postgres) for data

### Comms and testing

- **Jitsi** for the live buyer/supplier verification call
- **web-push** + Resend (email fallback) for notifications
- **Vitest**, 291 tests across auth, the state machine, the ledger,
  order lifecycle, termination flows, reconciliation sweeps, the live
  verification call's cross-party corroboration, and an adversarial
  attack suite

## Auth & roles

Three roles: `buyer`, `supplier`, `admin`, stored in `users.role`,
checked server-side on every protected action via `lib/authz.ts`'s
`requireRole()`. The client's copy of the role is a display hint only,
nothing trusts it for an authorization decision, and the session token
itself never carries a role claim to forge.

### Admin access

No self-service path to `admin`. The very first admin is a direct
database write, see the bottom of
`supabase/migrations/0000_fresh_project_full_schema.sql`. Everyone
after that is granted through `PATCH /api/admin/users/[id]/role` by an
existing admin, audit-logged.

### Supplier verification

A real reviewed flow, not a role grant: a buyer applies (business
name, location, CAC number), an admin approves or rejects it at
`/admin`. Verification is valid for 90 days or 20 orders before
re-verification is required.

### Session revocation

Sessions can be revoked on all devices, not just logged out locally.
Logging out, or an admin suspending a supplier, stamps
`session_valid_after` so every existing token for that account stops
working immediately, see `lib/authz.ts`.

### Rate limiting

Login/session-establishment, disputes, and every termination route are
rate-limited (`lib/rateLimit.ts`). It's in-memory, fine for a single
server, but won't hold limits across serverless instances, a shared
store (Upstash Redis, etc.) is the production follow-up.

### Test coverage

`npm test` runs the full suite, including `tests/authz.test.ts` and
`tests/adversarial.test.ts`, which prove a session can't reach another
role's actions, can't act on another account's orders, and can't
tamper with an amount, even via a forged token.

## Getting started

### Prerequisites

Node.js 18.17+, npm.

```bash
git clone <this-repo>
cd arc-sourcing-app
npm install
cp .env.local.example .env.local
```

### Environment variables

Fill in the values in `.env.local`, see that file for what each one is
and where to get it (Supabase, Privy, Reown, Circle dashboards).
Payment credentials (Circle, Yellow Card) are optional for local dev,
see [docs/payment-integration.md](docs/payment-integration.md), the
app runs on a fully simulated payment provider without them.

Without a real `NEXT_PUBLIC_PRIVY_APP_ID` (and `PRIVY_APP_SECRET`,
`SESSION_SECRET`), the app shows a "Privy isn't configured yet" screen
instead of the sign-in flow, see `components/Web3Providers.tsx`. Two
routes work with **no** credentials at all: **`/design-system`**
(every shared UI primitive, both themes) and **`/offline`** (the PWA
offline fallback page).

### Database

Before running the app, apply the migrations against your Supabase
project (SQL editor, or `supabase db push`), in order, from
`supabase/migrations/0000_fresh_project_full_schema.sql` through the
highest-numbered file. Each file's header says which project lineage
it's for, read that before running anything if you're on an older
checkout.

### Run it

```bash
npm run dev
```

Open http://localhost:3000. If it errors, copy the terminal output
before changing anything else.

On Windows, if `npm run dev` takes ages just to boot, check your
antivirus's real-time scanning first, Defender scanning the project
folder on every file read is the usual cause; excluding the folder
(`Add-MpPreference -ExclusionPath`) can turn 40s+ into ~2s.

## Available scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server. PWA/service worker is **disabled** in dev, HMR and SW caching fight each other. |
| `npm run build` | Production build. Generates the service worker, precache manifest, and icons. |
| `npm start` | Serves the production build. Use this (not `dev`) to test PWA install/offline/update behavior and to verify security headers. |
| `npm test` | Runs the full Vitest suite. |
| `npm run lint` | Next's built-in ESLint config. |

## Project structure

See [docs/architecture.md](docs/architecture.md) for the full,
annotated folder structure and the flow money takes through the
codebase.

## Design system

`/design-system` renders every shared primitive (buttons, form fields,
cards, tables, badges, modal, toast, transaction progress, error
panel, offline banner, skeleton, empty state) against the live theme
tokens, with a toggle to check both palettes. Check here before
building new UI, and update it alongside `components/ui/*` if you add
a new primitive.

## Deploying

### GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin YOUR_REPO_URL_HERE
git push -u origin main
```

### Vercel

Go to vercel.com → Add New Project → select the repo → add the same
environment variables from `.env.local` in the project settings →
Deploy. Vercel auto-detects Next.js, no config changes needed.

`vercel.json` already declares the `order-timeouts` cron job, set
`CRON_SECRET` in your Vercel project settings or that job refuses to
run. Remember to apply the same migrations from "Getting started"
against your production Supabase project too, that's a manual step,
not part of the deploy.
