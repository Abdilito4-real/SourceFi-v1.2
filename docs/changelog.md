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

## Current test coverage

122 tests across 8 files (`npm test`): authorization boundaries, the
order state machine, the ledger, the full order service lifecycle,
every termination flow, and the adversarial suite above.
