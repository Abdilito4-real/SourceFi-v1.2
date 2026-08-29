# What's been built

A chronological record of the major stages, for anyone (including a
future session) picking this project back up.

## Foundation

### Design system and PWA

Theme-aware tokens (light = navy/gold, dark = green), installable PWA
with offline fallback and update prompts.

### Stage 4, real auth

Privy for identity, this app's own signed session cookie on top of it.
Three roles (`buyer`, `supplier`, `admin`), checked server-side on
every protected action.

### Stage 5, real data layer

Normalized schema, money stored as integer minor units everywhere, a
server-side state machine, a real double-entry ledger.

### Marketplace pivot

Replaced the original "sourcer visits supplier in person" model with a
direct buyer-supplier marketplace. Suppliers list materials, buyers
order directly, a live verification call (Jitsi) replaced the old
handshake-code check.

### Supplier verification

A one-time business check (CAC number, location, what they sell),
admin-reviewed, valid for 90 days or 20 orders before re-verification
is required.

## Feedback, Notifications & Security pack

Four prompts, each covering one concern for a marketplace that moves
real money.

### 1. Feedback layer

UX primitives for financial actions: toasts (`components/ui/Toast.tsx`),
confirmation dialogs with typed-confirmation above a threshold
(`ConfirmDialog.tsx`), persistent error states with a fund-position
statement and reference code (`ErrorPanel.tsx`), staged transaction
progress (`TransactionProgress.tsx`), and a global offline banner.
Applied throughout the buyer/supplier/admin dashboards, not just built
and left unused.

### 2. Push notifications

Full web-push infrastructure: VAPID keys, a service worker push
handler, per-category preferences with quiet hours, and an email
fallback (Resend) for critical events when push isn't available.
Security/account alerts are never opt-out. Push payloads never carry
amounts or counterparty names, only enough to route the user to the
right screen, see [security.md](security.md).

### 3. Termination and declination flows

Every way an order can end outside a clean settle, for every actor, at
every order state: buyer cancellation (before and after funding,
different consequences), supplier abandonment, proof withdrawal within
a short window, admin dispute resolution, and an automatic cron job
for stale orders. Built from an explicit state x actor matrix reviewed
before any code, since every decision here is a real fund-movement
policy call. Full history recorded per order
(`GET /api/orders/[id]/timeline`).

### 4. Adversarial security pass

A full security review, reported by severity, then fixed, then tested
by actively trying to break it. See [security.md](security.md) for the
complete, blunt writeup: what's protected, what's partially protected,
and what's still open.

Highlights:

- Security headers and a nonce-based CSP on every response.
- CSRF defense (SameSite cookie + Origin/Referer check).
- Rate limiting on every dispute/termination route.
- Session revocation, logout invalidates the token everywhere, not
  just clears the cookie.
- Every internal error message sanitized before it reaches a client.
- A 17-test adversarial suite: IDOR, amount tampering, race
  conditions, replay attacks, XSS/SQLi payloads, all attacking the
  real service functions, not mocks of them.

## Live call hardening

The verification call moved from a free meet.jit.si room to a real,
authenticated call, and got a second fraud gate independent of call
length.

- **8x8 JaaS upgrade**: `lib/jaasAuth.ts` signs a per-request JWT once
  `JAAS_APP_ID`/`JAAS_API_KEY_ID`/`JAAS_PRIVATE_KEY` are set, removing
  meet.jit.si's "log in to become a moderator" gate on new rooms.
  Falls back to plain meet.jit.si, unchanged, if those aren't set.
- **Feels like a real call**: push notifications for an incoming
  verification call use `requireInteraction`, vibration, and a "Join
  call" action button, not a plain silent notification. Answering from
  a notification still requires one explicit in-app "Answer" tap, the
  camera/mic and the verification timer never start just because the
  notification was tapped.
- **Front/back camera swap** on the in-call toolbar (mobile).
- **Order-code liveness confirmation**: `MIN_VERIFICATION_CALL_SECONDS`
  of connected time only proves a call of some length happened, not
  that it was genuinely about this order rather than a loop or
  pre-recorded video. The buyer now separately confirms the supplier
  showed the order's own code on camera before `approveOrder` will
  release funds, see [architecture.md](architecture.md#live-verification-call).

## Trust and payments hardening

- **Tiered supplier badges**: Verified → Verified Pro → Elite, computed
  from live verification plus completed-order count and on-chain-
  confirmed ratings (`lib/supplierTrust.ts`), not just a binary
  verified/unverified flag. A click-through trust profile
  (`GET /api/suppliers/[id]`) shows a supplier's tier, rating, and
  completed-order count before a buyer orders from them.
- **Live NGN → USDC exchange rate**: `lib/fxRate.ts` replaces the old
  hardcoded `PLACEHOLDER_NGN_PER_USDC = 1600` constant with a real,
  live rate, fetched at release time and persisted onto the order row
  so a later ledger entry always matches what was actually sent
  on-chain, even if the rate moves in between. See
  [payment-integration.md](payment-integration.md#ngn--usdc-exchange-rate).

## Production hardening: idempotency, webhook, rate limiting, Yellow Card scaffold

Closed the three gaps flagged in payment-integration.md's "Known gaps"
section, then scaffolded (not faked) the funding/refund leg.

- **Idempotency-safe retry**: `lib/uuidv5.ts` gives every escrow release
  a deterministic Circle `idempotencyKey`, same key on the original
  attempt and any retry, so a resend can't become a second on-chain
  transfer. New admin action, `POST /api/admin/orders/[id]/retry-release`
  (rate-limited, audit-logged, a "Retry" button in the admin Orders
  view for anything stuck at `release_submitted`). `lib/ledger.ts`'s
  `recordEscrowRelease` now refuses to book a second `SUPPLIER_PAYABLE`
  debit for the same order, defense in depth alongside the existing
  state-machine CAS. Found and fixed a real bug in the process: migration
  0014's "idempotency backstop" index guarded an `event_type` no code
  path ever wrote, it had never once fired (migration 0015).
- **Real webhook + durable reconciliation**: `app/api/webhooks/circle/route.ts`
  verifies Circle's actual signed notifications
  (`X-Circle-Signature`/`X-Circle-Key-Id`, verified against the SDK's
  own documented mechanism), registered via the idempotent
  `POST /api/admin/circle-webhook/register`. `middleware.ts`'s CSRF
  check now exempts this one server-to-server path, gated by its own
  signature instead. The actual fix for "a process restart loses an
  in-flight confirmation": `app/api/cron/reconcile-releases/route.ts`
  (`lib/releaseReconciliation.ts`), a DB-driven sweep for anything stuck
  at `release_submitted`/`release_processing`, independent of any one
  process's memory. `pollUntilConfirmed` stays as a fast first path, no
  longer the only one.
- **Rate limiting, Supabase-backed**: migration 0016 replaces the
  in-memory `Map` (reset on every serverless cold start) with atomic
  Postgres functions (`rl_check_rate_limit`/`rl_record_failure`/
  `rl_record_success`/`rl_check_quota`), same exported function names in
  `lib/rateLimit.ts` so no call site's logic changed, just `await`
  added at all 9 of them. Old buckets swept daily via the existing
  `order-timeouts` cron.
- **Yellow Card, honestly scaffolded**: `lib/yellowCardProvider.ts` is a
  real class, really wired into `lib/paymentProvider.ts` (now a
  composite that resolves each of the 4 payment legs independently,
  needed the moment two real providers can coexist), but
  `initiateOrderFunding`/`initiateRefund` throw
  `YellowCardNotConfiguredError` rather than fabricate a real API call
  — no Yellow Card docs or credentials exist in this project, and
  guessing at a real payment API's request shapes is exactly what
  CLAUDE.md's escrow/payouts rule says to stop and flag instead of
  doing.

162 tests pass (13 files), `tsc --noEmit` clean, full production build
clean.

## Real RLS pilot: orders + supplier_profiles

Closed the gap `docs/security.md` used to flag as fully open: "there is
no database-level backstop behind [the API route layer]." Turned out
that gap was bigger than "add some policies" — this app has never
authenticated to Supabase as anything but `service_role`, which always
bypasses RLS regardless of what policies exist, and no identity bridge
(Supabase's `auth.uid()`, `auth.users`) existed anywhere in the schema.

- **`lib/supabaseUserClient.ts`**: mints a short-lived, Supabase-
  compatible JWT per request (same `jose`/HS256 technique as
  `lib/session.ts`'s own session signing, different secret) carrying a
  custom `user_row_id` claim — deliberately not `auth.uid()`/`sub`,
  which casts to `uuid` and would error on this app's `bigint`
  identity. Returns a request-scoped client running as the
  `authenticated` Postgres role, not `service_role`, so RLS policies
  actually apply. Falls back to the existing service-role client (with
  a console warning) if `SUPABASE_JWT_SECRET`/`SUPABASE_ANON_KEY` aren't
  set, so this degrades gracefully rather than taking order reads down.
- **Migration `0017_orders_rls_pilot.sql`**: the first real RLS
  policies in the project. `orders_select_own` mirrors the existing
  app-layer buyer/supplier filter exactly (admin stays on service-role,
  unchanged — its "no filter, full oversight" was already intentional).
  A required companion `supplier_profiles_select_own` (self-only) —
  the orders policy's own subquery resolving a supplier's
  `supplier_profiles.id` would otherwise run under the same
  `authenticated` role and hit that table's own until-now-unreachable
  RLS-enabled-zero-policies, silently returning nothing. Also enabled
  RLS on `rate_limit_buckets`/`quota_buckets` (migration 0016 shipped
  them without it, unlike every other table).
- Piloted on 4 GET routes under `app/api/orders/**` — only the specific
  ownership-determining `orders` query switches clients; every other
  query in those same routes (users, payment_events, disputes, ...)
  deliberately keeps using service-role, since only `orders` and
  `supplier_profiles` have policies so far. Existing app-layer ownership
  checks stay, deliberately redundant, same "two independent layers"
  posture as the ledger's `assertBalanced` + its DB trigger.
- One real, intentional behavior change: a cross-tenant order id used
  to return an explicit 403 ("You are not the buyer for this order");
  once RLS filters the row at the query level, it's a plain 404 instead
  — the row is genuinely invisible, not just rejected.
- **Honest scope**: piloted on the highest-stakes table only, not all
  ~30. The other tables' RLS-enabled-zero-policies remains a default-
  deny backstop against key misuse, not an active layer, until the same
  pattern is extended to them — now a bounded, proven-pattern follow-up,
  not an open architecture question.
- Can't be verified by the automated suite (`FakeSupabase` doesn't run
  real Postgres); added `tests/supabaseUserClient.test.ts` covering the
  one part that IS unit-testable and security-critical — the JWT claim
  shape itself (`role`, `user_row_id`, a deterministic `sub`, short
  TTL) — but proving the second layer is genuinely load-bearing needs a
  manual test against the real database.

## Real Yellow Card integration: buyer KYC, funding, refund

Closed the last simulated leg. `lib/yellowCardProvider.ts` now calls
Yellow Card's actual Business API (`docs.yellowcard.engineering`,
fetched and confirmed directly, not guessed — same rigor as Circle's
webhook payload confirmation), restricted to bank-transfer funding only
(a deliberate decision: refunds are only documented to work for
Nigeria bank-transfer receives, and every order must stay refundable).

- **Buyer KYC, the new prerequisite**: migration `0018_buyer_kyc.sql`
  (`buyer_kyc_profiles`, self-only RLS policy extending the pilot from
  before), `POST/GET /api/buyer-kyc[/me]`, and `components/BuyerKycModal.tsx`
  — shown reactively the first time `fundOrder` fails with the new
  `BuyerKycRequiredError`, not on load. Yellow Card's `recipient` object
  needs full name/phone/DOB/government ID/address, none of which
  `users` stored before this.
- **Real request signing**: `lib/yellowCardAuth.ts`, HMAC-SHA256 per
  their documented scheme (`X-YC-Timestamp` + `Authorization: YcHmacV1
  {apiKey}:{signature}`, message = datetime+path+METHOD+body-hash) —
  confirmed against their docs' own worked example, no new dependency
  (Node's `crypto`).
- **Funding** (`POST /business/receive`) returns a `bankInfo` object
  the buyer has to actually pay into — `FundingResult` gained an
  optional `paymentInstructions` field for this, surfaced in
  `OrderDetailsModal.tsx`'s in-flight panel.
- **Refund is full-amount only**, no partial-refund parameter is
  documented on Yellow Card's side. `initiateRefund` refuses
  (`YellowCardPartialRefundUnsupportedError`) rather than guess when a
  fee-retention cancellation asks for a partial amount — flagged for
  follow-up with Yellow Card support, not silently worked around.
- **Webhook**: `app/api/webhooks/yellowcard/route.ts`, same shape as
  Circle's — verifies `X-YC-Signature`, re-fetches the authoritative
  state (`Lookup Receive`) rather than trusting the lightweight status
  ping the body carries. `POST /api/admin/yellowcard-webhook/register`
  mirrors Circle's idempotent registration route.
- **Idempotency**: same `lib/uuidv5.ts` deterministic-key pattern as
  Circle, via Yellow Card's own `sequenceId` field.
- Same production-readiness caveats stated plainly as everywhere else
  in this project: static-IP whitelisting is a real infra requirement
  for production Yellow Card credentials (not sandbox), and several
  nested field names (`recipient`'s exact shape, `bankInfo`, the
  refund webhook's exact event name) are inferred from documented
  prose rather than a fully expanded schema — flagged in
  `docs/payment-integration.md` for confirmation against a real sandbox
  call before the first live funding attempt.

16 new tests (`lib/yellowCardAuth.ts`'s signing scheme, the KYC/partial-
refund/idempotency guards), 194 total, `tsc --noEmit` clean, full
production build clean.

## Buyer pre-funded wallet balance

Real behavior change to order funding, not an addition alongside it: a
buyer now tops up a platform wallet balance ahead of time (visible on
`/buyer`'s overview) and `fundOrder()` requires that balance to already
cover an order before it'll fund it — instantly, no fresh bank-transfer
request per order the way the old direct-to-Yellow-Card path worked.

- **New**: `lib/walletService.ts` (balance reads, top-up, the atomic
  debit that gates funding, credit-on-refund), migration
  `0020_buyer_wallet.sql` (`buyer_wallets`/`wallet_transactions`, an
  atomic `wallet_debit`/`wallet_credit` Postgres function pair following
  `lib/rateLimit.ts`'s `select ... for update` row-locking precedent —
  concurrent double-spend is impossible by construction, not by
  discipline), `GET /api/wallet`, `POST /api/wallet/topup`,
  `components/WalletTopupModal.tsx`.
- **Reused, unchanged**: the entire ledger module and the order state
  machine. Funding-from-wallet and refunding-a-wallet-funded-order both
  reuse `lib/orderService.ts`'s existing `handleFundingConfirmed`/
  `handleRefundConfirmed` event consumers unmodified — `provider:
  "wallet"` is just a third, synchronous `PaymentStatusEvent` source
  alongside the stub and Yellow Card's real webhook, not a parallel code
  path.
- **Deliberately still simulated**: the actual external top-up call
  (`StubWalletTopupProvider`). Yellow Card's refund API refunds one
  whole original receive, no amount parameter — there's no documented
  way to give a buyer back an unspent *portion* of a top-up once some of
  it's been spent across orders. Wiring real money in before that's
  resolved risks it getting stuck with no legitimate way out. Same
  "honestly scaffolded, wired later" posture this project already used
  for Yellow Card itself. See
  [payment-integration.md](payment-integration.md#buyer-wallet-migration-0020_buyer_walletsql).
- KYC moved from gating `fundOrder` directly to gating
  `initiateWalletTopup` instead — the step that will eventually make a
  real external call needing it; funding an order from an already
  KYC'd wallet never re-checks.

12 new tests (`tests/walletService.test.ts`), plus the existing
`fundOrder`/termination/adversarial suites rewritten (not just extended)
to the new wallet-first model, 211 total, `tsc --noEmit` clean.

## Real Yellow Card wallet top-up

Closed the one deliberately-simulated piece the wallet feature above
left open: `lib/yellowCardWalletTopupProvider.ts`'s
`YellowCardWalletTopupProvider` calls Yellow Card's actual `POST
/business/receive` (same resource `lib/yellowCardProvider.ts`'s
order-funding leg already uses, just not tied to an order) the moment
`YELLOW_CARD_API_KEY`/`YELLOW_CARD_SECRET_KEY` are set. User-confirmed
design: **one-way**, real money in, no standalone withdrawal — Yellow
Card's refund API still can't give back an unspent portion of a top-up,
so that stays an accepted, explicit product limitation rather than a
guessed-at workaround. Order-level refunds of a wallet-funded order are
unaffected, they already credited the wallet back correctly.

- `app/api/webhooks/yellowcard/route.ts` now resolves a notification
  against `wallet_transactions` (a top-up) when it doesn't match any
  order — one registered endpoint, same as before, covers both.
- Idempotency uses a client-generated key
  (`components/WalletTopupModal.tsx`, one per submit press) rather than
  a DB-derived one — a top-up has no pre-existing identity the way an
  order's `orderId` already does.
- **Real bug found and fixed while wiring this in**: `confirmWalletTopup`
  used to credit the wallet unconditionally on every call, which would
  have double-credited on a redelivered webhook (this codebase's own
  webhook handling already assumes at-least-once delivery). Fixed with
  the same compare-and-swap discipline `handleFundingConfirmed` uses for
  order status — only credit if the row's `processing -> confirmed`
  update actually matched.
- `WalletTopupModal.tsx` now shows real bank-transfer instructions and
  polls the balance every few seconds while waiting, instead of assuming
  a stub's instant confirmation.

8 new tests (`tests/yellowCardWalletTopupProvider.test.ts`) plus one
regression test locking in the double-credit fix, 220 total,
`tsc --noEmit` clean. See
[payment-integration.md](payment-integration.md#buyer-wallet-migration-0020_buyer_walletsql)
for the full design and what's still explicitly out of scope
(withdrawal).

## Real settlement/payout leg (Yellow Card Send, direct settlement)

Closed the last simulated leg: `escrow_released -> settlement_processing
-> settled` already existed as real states with a real ledger function
(`recordSettlement`) and a real confirmation handler
(`handleSettlementConfirmed`), just never fed a real event — the stub
auto-fired a fake confirmation the instant release confirmed, purely so
orders didn't hang forever. Neither of those needed to change; the only
real gap was WHERE the release's USDC went and who told the platform it
was actually settled.

**Confirmed against Yellow Card's actual docs, not guessed**: real
crypto-to-bank settlement is their "Sell Digital Assets" direct-
settlement flow — a Send request with `directSettlement: true` returns
a one-time crypto deposit address instead of taking one, you send USDC
there, they convert and pay the destination bank account. This meant
`lib/circleEscrowProvider.ts`'s escrow release had to change WHERE it
sends USDC, not just gain a step after it: `supplier_profiles.wallet_address`
(the supplier's own crypto wallet) stops being read by the real payout
path entirely, replaced by `lib/yellowCardProvider.ts`'s new
`createSettlementSend`, which resolves the deposit address from the
supplier's on-file bank details (`supplier_payout_profiles`, migration
`0019_supplier_payout.sql` — collected months ago specifically for
this, never wired until now). User-confirmed direction: one-way, the
supplier never touches crypto, matches CLAUDE.md's "crypto rails stay
invisible" rule.

- **A real, new coupling**: escrow release now requires Yellow Card to
  ALSO be configured, not just Circle (`MissingYellowCardConfigError`)
  — the settlement leg's deposit address comes from Yellow Card's Send
  API now, so Circle alone isn't enough for a real release anymore.
- **New required env var**: `YELLOW_CARD_ESCROW_CRYPTO_NETWORK`, must
  match whatever blockchain the Circle escrow wallet actually holds
  USDC on — invisible from this codebase, no default, refuses to guess.
- `app/api/webhooks/yellowcard/route.ts` gained a third resolution
  branch (alongside funding/refund and wallet top-up): a
  `leg='settlement'` `payment_events` lookup, then a real re-fetch —
  doesn't gate on the notification's `event` field at all for this leg,
  because Yellow Card's own docs admit they're mid-migration from
  legacy webhook event names to v2 ones and the one guide page
  describing this flow is stale relative to their current terminology.
  See [payment-integration.md](payment-integration.md#real-settlement-supplier-payout-to-their-bank-account)
  for the full, honestly-stated list of what's still unconfirmed.

12 new tests (`tests/yellowCardProvider.test.ts`'s `createSettlementSend`/
`checkAndReportSettlementStatus` coverage, `tests/circleEscrowProvider.test.ts`'s
new proof that release sends to Yellow Card's deposit address and never
the supplier's own wallet), 232 total, `tsc --noEmit` clean.

## Two remaining dependency vulnerabilities, fixed

`ws` and `serialize-javascript` were both high-severity, both nested
3-6 `npm ls` levels deep inside Privy's own wallet-connector tree and
next-pwa's `workbox-build` respectively — neither top-level package
had a published version whose own dependency tree resolved to a
patched copy, so bumping `@privy-io/react-auth`/`@ducanh2912/next-pwa`
themselves wouldn't have helped. Fixed with a `package.json`
`overrides` pin instead (`ws` >=8.21.0, `serialize-javascript`
>=7.0.5), the same mechanism already used for the earlier `axios` fix.
Verified with a full `npm run build`, not just a clean `npm audit`
line — `serialize-javascript` is only reachable via the service-worker
generation step (`workbox-build` → `@rollup/plugin-terser`), so
`public/sw.js` actually regenerating is the real proof it works. 15
moderate-severity advisories remain, all in the same Privy
wallet-connector tree, no fix available short of a major Privy version
bump — not attempted blind, see [security.md](security.md#dependency-vulnerabilities).

## RLS pilot expanded to 9 more tables

`0017_orders_rls_pilot.sql` proved the hard part (a per-request JWT
switching the Postgres role to `authenticated` so RLS policies
actually run, `lib/supabaseUserClient.ts`) on exactly 2 tables. This
is the "bounded follow-up work" that same doc named:
`payment_events`, `delivery_proofs`, `disputes`, `ratings` (order-
scoped, mirroring `orders_select_own`'s own check),
`notifications`, `notification_preferences`,
`supplier_verification_applications` (self-scoped, new policies,
migration `0021_rls_expand_pilot.sql`) — plus wiring
`GET /api/wallet` and `GET /api/buyer-kyc/me` to actually use the
authenticated-role client and exercise the self-only policies
`buyer_kyc_profiles`/`buyer_wallets` already had since their own
migrations (0018/0020) but never had a route reaching them. 11 tables
now have an actively-exercised RLS policy; `wallet_transactions` and
`supplier_payout_profiles` have the identical policy shape sitting
ready but unwired (no route reads either back yet); everything else
stays the same RLS-enabled-zero-policies default-deny backstop it
always was. `SELECT`-only throughout, no write path touched — same
posture as the original pilot, for the same reason. `tsc --noEmit` and
the full test suite both clean (232 tests, unaffected — no test
currently exercises these route handlers directly).

## Payment section closed out — real credentials are genuinely the last thing

Three independent audits (integration completeness, security, feedback/
UX), each with file:line evidence, to answer honestly whether Yellow
Card credentials are really the only remaining blocker. Answer: yes,
with one caveat that can't be closed by writing more code. 14 concrete
gaps found and closed:

- **Security**: `wallet/topup` and `orders/[id]/fund` — the two routes
  that actually move money — had zero rate limiting, unlike every
  termination route. Added the same dual per-IP/per-account quota
  pattern. Five money-moving routes (`fund`, `topup`, `cancel`,
  `abandon`, `reject`) fell through to a raw `err.message` on an
  unexpected failure instead of `dbErrorResponse()`; fixed.
- **Feedback**: `resolveDispute` and `retry-release` — the two admin
  actions moving real, unbounded amounts — were toast-only on failure
  and never required typed confirmation regardless of size;
  `retry-release`'s dialog didn't even show the amount. Supplier
  "abandon" and buyer "reject delivery" had the same missing typed-
  confirmation gap; reject's failures were also toast-only.
  `WalletTopupModal`'s error state was a bare inline message, the one
  wallet-adjacent surface not using `ErrorPanel`. All brought up to the
  same standard `OrderDetailsModal`'s fund/cancel already met — no new
  components, this was closing an inconsistency.
- **Integration cleanup**: `YELLOW_CARD_ENVIRONMENT` is now validated
  strictly (a typo used to silently break at the `API_HOSTS` lookup
  instead of failing clearly at startup). Two stale "top-up stays
  simulated" comments (predating `lib/yellowCardWalletTopupProvider.ts`)
  fixed.
- **New: `lib/yellowCardReconciliation.ts`** +
  `app/api/cron/reconcile-yellowcard/route.ts`, mirroring
  `lib/releaseReconciliation.ts`'s exact shape — a DB-driven sweep for
  any order stuck at `refund_processing`/`settlement_processing`, or
  any wallet top-up stuck `processing`, independent of Yellow Card's own
  webhook retry. Funding itself is excluded on purpose: wallet-first
  funding (migration 0020) always resolves synchronously, there's no
  code path left that waits on a real Yellow Card funding receive.
- **Re-checked against live docs** (docs.yellowcard.engineering): the
  webhook signature scheme's source text was reconfirmed (same phrase
  the existing implementation was already built from, still no worked
  byte-example — the one thing that needs a live sandbox call, not more
  reading, to fully confirm). Found something genuinely new, though:
  the refund flow's documented status vocabulary
  (`pending_refund`/`refunded`/`refund_failed`) exactly matches what
  `lib/yellowCardProvider.ts`'s `checkAndReportReceiveStatus` already
  checked for — upgraded from an inferred guess to a confirmed reading.

11 new tests, all `lib/yellowCardReconciliation.ts`'s own direct
coverage — the rate-limit/error-sanitization wiring needed none, no
route handler in this app has ever been unit-tested directly (matching
existing precedent: none of `reject`/`cancel`/`abandon`/`retry-release`
have route-level rate-limit tests either, only `lib/rateLimit.ts`
itself does). 261 total, `tsc --noEmit` clean, full production build
clean.

## Current test coverage

232 tests across 19 files (`npm test`): authorization boundaries, the
order state machine, the ledger, the full order service lifecycle
(wallet-first funding included), every termination flow, the buyer
wallet balance/debit/credit primitives (including the real Yellow Card
top-up provider), the adversarial suite, Supabase-backed rate limiting,
the real Circle and Yellow Card integrations (webhook/idempotency logic
for all four legs now — funding, release, settlement, and wallet
top-up), and the RLS pilot's JWT minting.
