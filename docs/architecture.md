# Architecture

How SourceFi is put together: the stack, the request flow, and where
to look for each concern.

## Stack

### Application

- **Next.js 16** (App Router, webpack, not Turbopack, see
  `next.config.mjs` for why: the PWA plugin needs
  `workbox-webpack-plugin`)
- **React 18**, **TypeScript** (strict mode)
- **Tailwind CSS** with theme-aware design tokens (dark = green
  accent, light = navy/gold), all defined in `app/globals.css`.
- **`@ducanh2912/next-pwa`** for the service worker, offline fallback,
  and install prompt.
- **Vitest** for the test suite.

### Data and identity

- **Supabase** (Postgres) via a single service-role client. There are
  no RLS policies doing real work; the API route layer is the actual
  authorization boundary (see [security.md](security.md)).
- **Privy** for identity (email/Google/wallet login). This app never
  implements its own login, OTP, or 2FA, Privy owns that entirely.

### Payments and comms

- **Circle** for on-chain USDC escrow release. **Yellow Card** for NGN
  funding/settlement, currently unbuilt (see
  [payment-integration.md](payment-integration.md)).
- **`web-push`** for push notifications, with an email fallback via
  Resend.

## Request flow

### 1. Sign-in

A user signs in through Privy. The server verifies Privy's access
token once (`lib/privyServer.ts`) and mints its own signed, httpOnly
session cookie (`lib/session.ts`, using `jose`).

### 2. Authorization

Every protected API route calls `requireSession()` or `requireRole()`
(`lib/authz.ts`) before doing anything. Role, ownership, and status
are always re-read from the database, never trusted from the client
or the JWT.

### 3. Money movement

Money-moving actions go through `lib/orderService.ts`, which:

- Re-derives amounts server-side, never accepts one from the client.
- Uses `assertTransition()` (`lib/orderStateMachine.ts`) to check the
  move is legal, then a compare-and-swap `.eq("status", from)` on the
  actual DB update so a race can't double-process an order.
- Writes to `lib/ledger.ts`, a balanced double-entry ledger. Every
  transaction must net to zero per currency or the write is refused.

### 4. Payment boundary

Anything that touches real money or a blockchain call goes through
`lib/paymentBoundary.ts`'s `PaymentBoundary` interface, never a Circle
or Yellow Card SDK call directly from a route. See
[payment-integration.md](payment-integration.md).

## Order state machine

`lib/orderStateMachine.ts` is the single source of truth for which
`orders.status` transitions are legal. Full annotated diagram in
[marketplace-payments-design.md](marketplace-payments-design.md)
Section D.1.

Two things worth knowing before touching it:

- `buyer_approved` is intent only, no funds have moved. There is
  deliberately no direct `buyer_approved -> escrow_released`
  transition.
- `settled` is terminal. A problem discovered after settlement opens a
  **new** dispute row (`dispute_type = 'post_settlement_report'`), it
  never transitions the order status backwards.

## Termination and dispute paths

Every way an order can end besides a clean settle is in
`lib/orderService.ts`: `cancelBeforeFunding`, `cancelFundedOrder`,
`abandonOrder`, `withdrawProof`, plus admin dispute resolution and a
cron job (`app/api/cron/order-timeouts`) that auto-expires stale
orders.

Each records its reason in `order_status_history` /
`order_cancellations` so `getOrderTimeline` can show a full audit
trail to both parties.

## Live verification call

`components/JitsiMeetRoom.tsx` embeds a private room (a server-generated
UUID, never the guessable order code) so the buyer and supplier can
verify a delivery together before funds release. Two independent gates
must both be satisfied before `approveOrder` will release funds, one
alone isn't enough:

- **Call length**: `MIN_VERIFICATION_CALL_SECONDS` of real join-to-leave
  time (Jitsi's own lifecycle events, not just "the panel was open").
- **Order-code confirmation**: the buyer explicitly confirms the
  supplier showed the order's own code on camera and it matched
  (`call_code_confirmed_at`, migration 0013). Call length alone doesn't
  prove the call was genuinely about this order rather than a looped or
  pre-recorded video, this closes that gap. See `confirmCallCode` in
  `lib/orderService.ts`.

Arriving at a call via a push notification's deep link requires an
explicit in-app "Answer" tap before the camera/mic ever activate, an
open notification alone never auto-joins.

Runs on meet.jit.si (free, zero setup) by default. `lib/jaasAuth.ts`
upgrades it to 8x8 JaaS the moment `JAAS_APP_ID` / `JAAS_API_KEY_ID` /
`JAAS_PRIVATE_KEY` are all set: a JWT signed server-side per request
(`GET /api/orders/[id]`) authenticates this app's own tenant as
moderator, removing meet.jit.si's "log in to become a moderator,
otherwise wait" gate on brand-new rooms. Without those three set, the
call still fully works, that gate just occasionally shows and
self-resolves once both parties are in.

Presence (who's currently in the call) is tracked separately from the
verification-time requirement, `buyer_call_active_since` /
`supplier_call_active_since` (migration 0012) back an incoming-call
prompt for the other party, see `lib/orderService.ts`'s
`setCallPresence`.

## Notifications

`lib/notifications/dispatch.ts` is the one place that decides whether
a notification goes out and by which channel.

- Push (`webPush.ts`) is the primary channel.
- Email (`emailProvider.ts`, via Resend) is the fallback for critical
  financial events if push isn't available.
- Security/account alerts are never opt-out; everything else respects
  the user's per-category preferences and quiet hours
  (`notification_preferences` table).

## Folder structure

```
app/
  (main)/              Wrapped in Web3Providers (Privy) + SessionProvider
    buyer/, supplier/, admin/    The three dashboards
  api/
    auth/               Session establishment, logout, "who am I"
    orders/[id]/        Fund, approve, reject, cancel, abandon,
                         withdraw-proof, report-issue, rating, timeline
    admin/               Disputes, ledger, user roles, supplier verification
    push/, notification-preferences/, notifications/
    supplier-listings/, supplier-verification/, suppliers/, materials/
    cron/order-timeouts/  Vercel cron, protected by CRON_SECRET
  design-system/        Component/token preview, no auth required
  offline/              PWA offline fallback page
components/
  ui/                   Shared primitives: Button, Toast, ConfirmDialog,
                         ErrorPanel, TransactionProgress, OfflineBanner...
  *Dashboard.tsx         Buyer / Supplier / Admin dashboards
  OrderDetailsModal.tsx   Every order action lives here
lib/
  orderService.ts        Order lifecycle: fund, approve, reject, cancel...
  orderStateMachine.ts    Legal status transitions
  ledger.ts               Double-entry bookkeeping
  paymentBoundary.ts      The provider-agnostic payment interface
  paymentProvider.ts      Picks Stub vs. CircleEscrowProvider at runtime
  circleEscrowProvider.ts  Real Circle USDC release
  authz.ts                requireSession/requireRole, the auth choke point
  session.ts               This app's own signed session cookie
  rateLimit.ts              In-memory backoff + dual quota limiters
  notifications/            dispatch, webPush, emailProvider
supabase/migrations/     Numbered, additive. Read the header of each
                          before applying; some are marked for a specific
                          project lineage.
tests/                   Vitest: authz, state machine, ledger, order
                          service, termination flows, adversarial suite
```

## What's stubbed today

### Yellow Card

NGN funding/settlement: entirely simulated. No credentials exist
anywhere in this project.

### On-chain rating submission

Always returns `"submitted"`, never `"confirmed"`, the contract/chain
for this isn't decided yet.

### Row Level Security

Policies exist in name but the app always connects with the
service-role key, which bypasses them. The API route layer is the
real (and only) authorization boundary right now.

See [security.md](security.md) for the full, blunt list of what's
protected, partially protected, and unmitigated.
