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

## Current test coverage

130 tests across 9 files (`npm test`): authorization boundaries, the
order state machine, the ledger, the full order service lifecycle,
every termination flow, and the adversarial suite above.
