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

## Current test coverage

194 tests across 16 files (`npm test`): authorization boundaries, the
order state machine, the ledger, the full order service lifecycle,
every termination flow, the adversarial suite, Supabase-backed rate
limiting, the real Circle and Yellow Card integrations (webhook/
idempotency logic for both), and the RLS pilot's JWT minting.
