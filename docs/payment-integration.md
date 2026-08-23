# Payment integration

How to plug real payment credentials into SourceFi, and exactly what
each one turns on. Read [security.md](security.md) first if you
haven't, this file assumes you know the app's overall posture.

## The abstraction

Every route that moves money calls one of four functions on the
`PaymentBoundary` interface (`lib/paymentBoundary.ts`):

```ts
initiateOrderFunding(orderId)     // buyer funds an order
initiateEscrowRelease(orderId)    // buyer approves, funds release to supplier
initiateRefund(orderId, amount)   // cancellation or dispute ruling
submitRatingOnChain(...)          // buyer rates a settled order
```

No route ever imports a Circle or Yellow Card SDK directly. Which
implementation actually runs is decided in one place,
`lib/paymentProvider.ts`, based on which environment variables are
set. Nothing else in the codebase needs to change when you add real
credentials.

## Current state, function by function

| Function | Today | Turns real when |
|---|---|---|
| `initiateOrderFunding` | **Real** (bank-transfer only) if Yellow Card credentials + the buyer's KYC are set, simulated otherwise | `YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` set, see below |
| `initiateEscrowRelease` | **Real** if Circle credentials are set, simulated otherwise. Production-hardened: idempotency-safe retry, a real webhook, and a reconciliation cron (see below) | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `ESCROW_WALLET_ID` are all set |
| `initiateRefund` | **Real** (full-amount only) if Yellow Card credentials are set, simulated otherwise | `YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` set, see below |
| `submitRatingOnChain` | Always simulated, returns `"submitted"`, never `"confirmed"` | The rating contract/chain is decided (not scoped yet) |

`lib/paymentProvider.ts`'s `getPaymentProvider()` composes each of the 4
legs independently, not a flat stub-vs-Circle switch: release upgrades
to `CircleEscrowProvider` the moment its three env vars are all set,
funding/refund upgrade to `YellowCardProvider` the moment its two env
vars are set, independently of each other. `getCircleEscrowProvider()`/
`getYellowCardProvider()` return the concrete provider instance
directly (needed by each provider's own webhook route and admin
webhook-registration route, which call methods `PaymentBoundary`
doesn't expose).

## Turning on real Circle escrow release

### Setup steps

1. Create a Circle account at [console.circle.com](https://console.circle.com)
   and set up developer-controlled wallets.
2. **API key**: Developer Dashboard → API Keys. This is `CIRCLE_API_KEY`.
3. **Entity secret**: generated once during Circle's entity setup
   flow, not a normal API key, follow Circle's developer-controlled
   wallets docs for this step specifically. This is
   `CIRCLE_ENTITY_SECRET`.
4. **Escrow wallet**: create a developer-controlled wallet in Circle's
   dashboard to hold funds in escrow. Its internal Circle ID is
   `ESCROW_WALLET_ID` (server-only). Its public address is
   `NEXT_PUBLIC_ESCROW_WALLET_ADDRESS` (safe to expose).
5. Fund that wallet with USDC before testing a real release, Circle
   won't let you send more than the wallet holds.
6. Set all four variables in `.env.local` (or your hosting provider's
   environment settings) and restart the app.
7. Verify: fund a test order through to `proof_submitted`, approve it,
   and check the server logs for `Circle release ... ended in state
   ...` or a confirmed txHash rather than the stub's fabricated one.
   Also sanity-check the amount actually sent against the order's NGN
   total and today's real NGN/USD rate, see "NGN → USDC exchange
   rate" below, this is no longer a fixed, easy-to-eyeball constant.

### NGN → USDC exchange rate

The amount actually sent on-chain is computed from a **live** NGN/USD
rate (`lib/fxRate.ts`), fetched from `open.er-api.com` (free, no API
key, updates daily). It used to be a hardcoded constant
(`PLACEHOLDER_NGN_PER_USDC = 1600`); that's gone, every release now
converts against whatever the real rate is at that moment.

Two things worth understanding before you rely on this:

- **Fails loudly, never guesses.** If the live source is unreachable
  and there's no cached rate less than 6 hours old, `getNgnPerUsd()`
  throws `FxRateUnavailableError` rather than falling back to a stale
  or fabricated number. A release attempt during an outage fails
  cleanly instead of sending a wrong amount.
- **The split is locked in at release time, not recomputed later.**
  The rate can move between when a release is sent and when its
  confirmation arrives (`handleReleaseConfirmed` /
  `handleSettlementConfirmed`, which book the ledger entry). The exact
  split used is persisted onto the order row
  (`release_usdc_total_minor` / `release_usdc_platform_fee_minor`,
  migration 0014) the moment Circle accepts the transaction, and every
  later step reads that back instead of recomputing, so the ledger
  entry always matches what was actually sent on-chain. See
  `computeUsdcSplit`'s doc comment in `lib/orderService.ts` if you're
  touching this logic.

### Idempotency (production-hardening pass)

`initiateEscrowRelease` passes a **deterministic** `idempotencyKey` to
Circle's `createTransaction` (`lib/uuidv5.ts`, derived from
`` `release:${orderId}` `` alone) on every call, original attempt or
retry. Circle's own dedup on that key is the primary protection against
a retried release becoming a second on-chain transfer. Two more
independent layers, defense in depth:

- `lib/ledger.ts`'s `recordEscrowRelease` refuses to book a second
  `SUPPLIER_PAYABLE` debit for an order that already has one
  (`DuplicateReleaseBookingError`).
- `handleReleaseConfirmed`'s own compare-and-swap
  (`release_processing -> escrow_released`) ensures only one
  confirmation event per order ever reaches that ledger write in the
  normal flow.

An admin can retry a release stuck at `release_submitted` (a prior
attempt threw, e.g. no supplier wallet on file) via
`POST /api/admin/orders/[id]/retry-release`. Safe to click more than
once, for the same reason a resend is safe: same deterministic key.

### Webhook + reconciliation (production-hardening pass)

Release confirmation now has three independent paths, not just one:

1. **Poll** (`pollUntilConfirmed` in `lib/circleEscrowProvider.ts`) — a
   fast, best-effort first path, unchanged in spirit, just no longer the
   only path.
2. **Webhook** (`app/api/webhooks/circle/route.ts`) — Circle's real
   notification, signature-verified
   (`CircleEscrowProvider.verifyWebhookSignature`, `X-Circle-Signature`/
   `X-Circle-Key-Id` headers, verified against the installed SDK's own
   documented mechanism). Payload shape confirmed against Circle's own
   published docs (`developers.circle.com/api-reference/wallets/common/
   transactions-outbound` and `.../transactions-inbound`, plus the
   notifications-quickstart envelope doc): the envelope is
   `{ subscriptionId, notificationId, notificationType, notification,
   timestamp, version }`, and `notification` for a transaction event
   matches the REST `Transaction` object exactly (`id`, `state`,
   `txHash`, `errorReason`, ...), the same shape `client.getTransaction()`
   returns. Circle also sends a one-time `notificationType:
   "webhooks.test"` ping when a subscription is first created, handled
   as an expected no-op. The route reports directly from
   `notification`'s own `state`/`txHash`/`errorReason`
   (`CircleEscrowProvider.reportWebhookNotification`) rather than making
   a second `client.getTransaction()` call — safe now that the shape is
   confirmed: the signature already proves the message came from Circle,
   and `handleReleaseConfirmed`'s `order.status` guard is already
   idempotent against a stale/out-of-order delivery regardless of where
   the state came from, so re-fetching bought no extra safety, only
   latency. Falls back to a real re-fetch
   (`checkAndReportReleaseStatus`) only if the body doesn't carry a
   usable `state`. Register it once,
   per deployment, via `POST /api/admin/circle-webhook/register` (idempotent — safe to call
   again after a redeploy).
3. **Reconciliation cron** (`app/api/cron/reconcile-releases/route.ts`,
   `lib/releaseReconciliation.ts`) — the actual fix for "a process
   restart mid-poll loses that release's confirmation forever": a
   DB-driven sweep, independent of any one process's memory, for orders
   stuck at `release_submitted`/`release_processing` longer than 2
   minutes. Same `CRON_SECRET` pattern as `order-timeouts`. **Frequency
   caveat:** Vercel's Hobby tier limits a cron to once/day, `vercel.json`
   schedules this daily to stay valid on every tier, which is too coarse
   to matter for a genuinely stuck release. If you're not on a tier that
   allows more frequent Vercel crons, trigger this endpoint externally
   on a tighter interval instead (e.g. a scheduled GitHub Action hitting
   it with the `CRON_SECRET` bearer token) — the route itself doesn't
   care who calls it, only that the secret matches.

A release that never reaches a terminal state after ALL of the above
(poll exhausted, no webhook received, reconciliation still finds it
pending) needs actual manual investigation directly with Circle, none of
this invents an outcome.

### Other known gaps, even with real credentials wired in

- The platform fee is never moved on-chain per order, it stays in the
  escrow wallet by design (see `lib/ledger.ts`'s
  `recordEscrowRelease`). Don't "fix" this without updating the ledger
  logic to match, they're written to agree with each other.
- Rate limiting on every route that touches this (retry-release,
  webhook registration, the auth/admin lockouts elsewhere) is now
  Supabase-backed (`migration 0016_rate_limiting.sql`,
  `lib/rateLimit.ts`), not in-memory, so it survives serverless cold
  starts. See `docs/security.md`'s Rate limiting section.

## Yellow Card (NGN funding and refund)

**Real, bank-transfer only, sandbox-first.** `lib/yellowCardProvider.ts`
calls Yellow Card's actual Business API (`docs.yellowcard.engineering`,
confirmed directly against their published docs, not guessed), the
moment `YELLOW_CARD_API_KEY` and `YELLOW_CARD_SECRET_KEY` are both set.
Restricted to bank-transfer (`channelType: "bank"`) funding only, a
deliberate product decision: refunds/cancellations are only documented
to work for Nigeria bank-transfer receives, and every order this app
creates must stay refundable. `YELLOW_CARD_ENVIRONMENT` gates
sandbox vs. production, defaults to `sandbox` — never defaults to
production, set it explicitly only once you're ready to move real
money. The settlement leg (the second half of `escrow_released ->
settled`) is still 100% simulated, there's no `initiateSettlement`
boundary call at all by design (see `lib/paymentBoundary.ts`'s comment
on why) — this section is about funding/refund only.

### Setup steps

1. Sign up / accept an invitation at the Treasury Portal
   (`portal.yellowcard.io`). 2FA is mandatory on first login.
2. API Keys → Create New. Grant both **API read** and **API write**
   (collection request, payment request, settlement). The secret is
   shown once, save it immediately. A sandbox key is enough to test
   with — production credentials can wait.
3. Set `YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` in `.env.local`
   (or your hosting provider's environment settings) and restart the
   app.
4. Every buyer must have a `buyer_kyc_profiles` row on file before
   funding works (migration `0018_buyer_kyc.sql`,
   `POST /api/buyer-kyc`) — Yellow Card's `recipient` object requires
   full name, phone, DOB, government ID, and address. The buyer UI
   (`components/BuyerKycModal.tsx`) prompts for this reactively, the
   first time a fund attempt fails with `kycRequired: true`.
5. Register the webhook once deployed:
   `POST /api/admin/yellowcard-webhook/register` (idempotent, same
   pattern as Circle's).
6. **Production only, not sandbox**: Yellow Card requires a static
   outbound IP to whitelist. Vercel serverless functions have none by
   default — you'll need a NAT/static-IP add-on before this goes live
   for real money.

### Known gaps and unconfirmed pieces, stated honestly

- **Refund is full-amount only.** Yellow Card's refund endpoint
  (`POST /receive/{id}/refund`) takes no amount parameter, only the
  original receive's id — no partial-refund support is documented.
  `initiateRefund` refuses (`YellowCardPartialRefundUnsupportedError`)
  rather than guess when a fee-retention cancellation
  (`recordPartialRefundWithFee`) asks for a partial amount. Confirm
  with Yellow Card support whether this is possible via an
  undocumented parameter before this path is exercised in production.
- **No reconciliation cron for this leg yet**, unlike Circle's
  `lib/releaseReconciliation.ts`. A stuck funding/refund event today is
  only caught by Yellow Card's own webhook retry, not an independent
  DB-driven sweep. Worth building the same pattern here if stuck events
  turn out to be a real problem.
- **Genuinely unconfirmed against Yellow Card's live schema**: the
  exact nested `recipient` field names beyond what their docs' prose
  states, the exact `bankInfo` response shape, and the refund webhook's
  exact `event` name (inferred as containing "REFUND", not confirmed —
  see `app/api/webhooks/yellowcard/route.ts`'s header). Confirm all
  three against a real sandbox call before the first live funding
  attempt.

## Testing without real credentials

Leave every payment env var empty. `StubPaymentProvider` handles every
leg with a short simulated delay so the full
`pending_payment -> ... -> settled` lifecycle, every termination flow,
and the full test suite all run with zero external calls and zero
cost. This is also what CI should run against, never point automated
tests at real Circle or Yellow Card credentials.

## Rules that don't change no matter which provider is live

- Never trust a client-supplied amount, currency, or status. Every
  number that reaches a payment call is re-derived server-side from
  the order row.
- Every transition still goes through `assertTransition()` and a
  compare-and-swap DB update, a real provider doesn't get to skip
  that just because it's "the real one now."
- Every fund movement writes a balanced entry to `lib/ledger.ts`.
  `assertBalanced` refuses to write anything that doesn't net to zero
  per currency, that check runs identically whether the provider
  behind it is real or simulated.
