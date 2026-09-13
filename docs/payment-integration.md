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

**`initiateOrderFunding` is no longer called by the live order-funding
flow at all**, as of migration `0020_buyer_wallet.sql` — see "Buyer
wallet" below. `lib/orderService.ts`'s `fundOrder()` debits the buyer's
platform wallet balance directly instead. The method still exists on
`PaymentBoundary` and `YellowCardProvider` still implements it for real
(covered by its own tests), it's just unreachable from any route today —
a known, deliberate bit of dead code, not an oversight, flagged here
rather than silently left undocumented. Wiring a real wallet top-up
provider later is the natural place this becomes reachable again.

| Function | Today | Turns real when |
|---|---|---|
| `initiateOrderFunding` | Unreachable from any live route (see above); `YellowCardProvider`'s real implementation still exists and is still tested | N/A until a real wallet top-up provider calls it, or a future feature reintroduces a direct-funding path |
| `initiateEscrowRelease` | **Real** if Circle credentials are set, simulated otherwise. Production-hardened: idempotency-safe retry, a real webhook, and a reconciliation cron (see below) | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `ESCROW_WALLET_ID` are all set |
| `initiateRefund` | **Real** (full-amount only) if Yellow Card credentials are set, simulated otherwise — but only reached for an order NOT funded from the wallet (increasingly rare now that funding is wallet-first); a wallet-funded order's refund routes internally instead, see "Buyer wallet" below | `YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` set, see below |
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

## Buyer wallet (migration 0020_buyer_wallet.sql)

**A buyer now funds a platform wallet balance ahead of time, and orders
fund instantly from it.** This is a real, deliberate behavior change to
the funding flow described above, not an addition alongside it —
`fundOrder()` requires the wallet balance to already cover the order and
refuses (`InsufficientWalletBalanceError`, carrying the exact shortfall)
otherwise. `lib/walletService.ts` owns this; `GET /api/wallet` reads the
balance, `POST /api/wallet/topup` starts a top-up,
`components/WalletTopupModal.tsx` is the buyer-facing UI (opened either
from the dashboard directly or reactively when a fund attempt comes back
short, mirroring how `BuyerKycModal` used to open off a failed fund
attempt).

**The balance and the debit that gates order funding are real** —
`buyer_wallets`/`wallet_transactions` (migration 0020), and an atomic
`wallet_debit` Postgres function (`select ... for update`, same
row-locking shape as `lib/rateLimit.ts`'s functions) that makes
concurrent double-spend impossible; the app layer never reads the
balance then writes it back. Once money leaves the wallet to fund a
specific order, it flows into the **existing, unchanged** ledger via the
same `handleFundingConfirmed` path a real Yellow Card confirmation
always used — `provider: "wallet"` is just a third, synchronous event
source alongside the stub and Yellow Card's real webhook, see
`lib/orderService.ts`'s `fundOrder`. Refunding a wallet-funded order
(dispute ruling, cancellation, abandonment) credits the wallet back
through the same reuse of `handleRefundConfirmed`, instead of calling
Yellow Card's refund endpoint.

**The external top-up call is now real too** —
`lib/yellowCardWalletTopupProvider.ts`'s `YellowCardWalletTopupProvider`,
the same `POST /business/receive` / `GET /business/receive/{id}`
resource `lib/yellowCardProvider.ts`'s order-funding leg already uses,
just not tied to an order — the moment `YELLOW_CARD_API_KEY`/
`YELLOW_CARD_SECRET_KEY` are set (`lib/paymentProvider.ts`'s
`getWalletTopupProvider()`), simulated (`StubWalletTopupProvider`)
otherwise. Yellow Card's own webhook resolves a wallet-top-up
notification the same way it resolves an order's
(`app/api/webhooks/yellowcard/route.ts`, one registered endpoint covers
both), crediting the balance via the SAME atomic `wallet_credit` RPC an
order's funding-from-wallet debit already relies on for its own
opposite-direction guarantee.

**This is deliberately ONE-WAY, confirmed with the user, and will stay
that way until it's resolved.** Reason, unchanged from before this went
real: Yellow Card's refund API refunds exactly one original receive, in
full, no amount parameter. There is still no documented way to give a
buyer back an unspent PORTION of a top-up once some of it has been spent
across multiple orders — so there is no `initiateWithdrawal`, and real
buyer money that isn't fully spent on orders has no way back out today.
That's an accepted product/support reality, not an oversight; revisit
once a real withdrawal or partial-refund mechanism exists on Yellow
Card's side.

**Idempotency**: same `lib/uuidv5.ts` deterministic-key pattern as order
funding, but keyed off a CALLER-supplied `idempotencyKey`
(`components/WalletTopupModal.tsx` generates one per submit press) —
a top-up has no pre-existing DB identity the way an order does
(`funding:${orderId}` already exists before that call happens), so a
genuine client retry has to bring its own stable key for Yellow Card's
own dedup to actually prevent a second real bank-transfer request.

**A real bug fixed while wiring this in**: `confirmWalletTopup`
(`lib/walletService.ts`) used to credit the wallet unconditionally on
every call — harmless with the stub (calls its confirmation exactly
once, ever) but a real webhook can and does redeliver the same
notification, which would have double-credited the wallet. Fixed with
the same compare-and-swap discipline `lib/orderService.ts`'s
`handleFundingConfirmed` already uses: only credit if updating the
`wallet_transactions` row's status from `processing` to `confirmed`
actually matched a row.

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
money. **The settlement leg (the second half of `escrow_released ->
settled`) is real too now**, see its own section below — this one is
about funding/refund only.

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

### Real settlement (supplier payout to their bank account)

**A supplier no longer receives raw USDC in their own crypto wallet —
they get NGN in their bank account, real, once
`YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` AND
`YELLOW_CARD_ESCROW_CRYPTO_NETWORK` are all set.** Confirmed against
Yellow Card's actual docs
(`docs.yellowcard.engineering/docs/buy-sell-digital-assets`), not
guessed: this is a Send request with `directSettlement: true` and
`settlementInfo: { cryptoCurrency: "USDC", cryptoNetwork }`, which
returns a one-time crypto deposit address instead of taking one — the
escrow release (`lib/circleEscrowProvider.ts`) sends the USDC there
(`lib/yellowCardProvider.ts`'s `createSettlementSend`), not to
`supplier_profiles.wallet_address` (that column stops being read by the
real payout path; not deleted, that's a separate decision). Yellow Card
converts and pays the supplier's bank account on file
(`supplier_payout_profiles`, migration `0019_supplier_payout.sql`),
reporting completion via the same registered webhook every other leg
uses (`app/api/webhooks/yellowcard/route.ts`, resolved against a new
`leg='settlement'` `payment_events` row).

**A real, new coupling worth knowing about**: real escrow release now
requires Yellow Card to ALSO be configured, not just Circle —
previously these two were independent (`CircleEscrowProvider` only
needed the supplier's own wallet address). `MissingYellowCardConfigError`
throws loudly if Circle is configured but Yellow Card isn't, rather
than silently falling back to the old direct-to-wallet behavior.

**`YELLOW_CARD_ESCROW_CRYPTO_NETWORK` (new, required for this leg)**:
must exactly match the blockchain your `ESCROW_WALLET_ID` actually
holds USDC on in Circle's own console — invisible from this codebase,
you have to know it. No default; getting it wrong sends real USDC to a
network Yellow Card isn't watching, which is unrecoverable.

**Genuinely unconfirmed pieces from this leg specifically, stated
honestly, same posture as the funding leg's own unconfirmed pieces
below:**
- The base (non-USD/EUR) Send request's exact destination field names
  — Yellow Card's docs spell out the USD/EUR-institution flow's fields
  in full, but not this one; inferred from the "Making a Send" guide's
  own field table (bank name/account holder name/account number/
  network) plus this project's own `supplier_payout_profiles` columns,
  which were deliberately shaped to match.
- Where exactly the crypto deposit address lives in the Send response —
  the guide's prose says only "the customer receives a crypto currency
  wallet address," no literal JSON shown.
  `lib/yellowCardProvider.ts`'s `extractCryptoDepositAddress` checks
  several plausible locations rather than assuming one.
- **The real webhook event name for a completed settlement.** Yellow
  Card's own docs (`/docs/webhooks-api`) say they're mid-migration from
  legacy names (`PAYMENT.*`/`SETTLEMENT.*`) to v2
  (`SEND.*`/`CRYPTO_SEND.*`/`CONVERT.*`), new webhooks default to v2
  already, but the one guide page describing this exact flow still
  shows legacy names — that page is stale relative to Yellow Card's own
  current terminology. The webhook route doesn't gate on `event` at all
  for this leg because of this (it resolves by whether the notification
  `id` matches a pending `leg='settlement'` row instead, then re-fetches
  authoritative status directly) — but the first real sandbox test
  should still watch server logs to see what event name actually
  arrives, worth knowing even though the route doesn't depend on it.

Confirm all three against a real sandbox call before the first live
settlement attempt.

### Known gaps and unconfirmed pieces, stated honestly

- **Refund is full-amount only.** Yellow Card's refund endpoint
  (`POST /receive/{id}/refund`) takes no amount parameter, only the
  original receive's id — no partial-refund support is documented.
  `initiateRefund` refuses (`YellowCardPartialRefundUnsupportedError`)
  rather than guess when a fee-retention cancellation
  (`recordPartialRefundWithFee`) asks for a partial amount. Confirm
  with Yellow Card support whether this is possible via an
  undocumented parameter before this path is exercised in production.
- **Closed.** `lib/yellowCardReconciliation.ts` +
  `app/api/cron/reconcile-yellowcard/route.ts` now mirror Circle's
  `lib/releaseReconciliation.ts` pattern: a DB-driven sweep for any
  order stuck at `refund_processing`/`settlement_processing`, or any
  wallet top-up stuck `processing`, re-checking each directly with
  Yellow Card rather than relying solely on their webhook retry.
  Funding itself doesn't need this — it's wallet-first as of migration
  0020 and always resolves synchronously, there's no code path left
  that waits on a real Yellow Card funding receive.
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
