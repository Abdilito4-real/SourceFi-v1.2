# Security posture

The honest list, not the reassuring one. What's protected with
evidence, what's real but has a caveat, and what's still open.

**122/122 tests pass**, including 17 attack-focused tests (IDOR,
tampering, race conditions, replay, XSS/SQLi payloads). None of them
got through.

## Protected

Verified this session, not assumed.

### SQL injection

Zero raw or dynamic SQL anywhere. One `.rpc()` call, to a fixed,
parameterized function. Everything else goes through Supabase's query
builder.

### XSS

One `dangerouslySetInnerHTML` in the whole app (`ThemeScript.tsx`), a
static string, zero user input. Script tags and SQL payloads fired
into dispute descriptions, cancellation reasons, and delivery notes
all stored as inert text, confirmed by test.

### IDOR

7 attack tests, each firing a real mutation (approve, reject, dispute,
rate, report call time, submit proof, cancel) with an unrelated
account's id, including a supplier's own real, verified account
against an order it isn't assigned to. Every one rejected.

### Role trust

Role is re-fetched from the database on every request, never read
from the JWT, a header, or the client. The session token doesn't carry
a role claim, there's nothing to forge.

### Amount tampering

`fundOrder` and `approveOrder` take no amount parameter at all,
asserted directly in a test. Every amount is re-read from the order
row server-side.

### Command injection, SSRF

Zero `exec`/`spawn` usage. Zero server-side fetches to a user-supplied
URL, the only external call is a hardcoded request to Resend's API.

### Cookies and secrets

`httpOnly`, `secure` in production, `sameSite=lax`. Nothing sensitive
in localStorage. No secret ever committed. The built client bundle was
grepped for every server secret's name and value: clean.

### The old handshake code

Not patched, gone. The 4-digit code and the sourcer/handshake flow it
belonged to were removed by the marketplace pivot, replaced by the
live-verification-call mechanism.

### Security headers

Live-verified against a production build: CSP (nonce-based, no
`unsafe-inline` for scripts), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`,
`Permissions-Policy`, HSTS in production.

## Partially protected

Real and shipped, each with a caveat worth knowing.

### Rate limiting

Dispute filing and every termination route capped per IP and per
account (8 per 10 min). **Updated, production-hardening pass:**
Supabase-backed (`migration 0016_rate_limiting.sql`,
`lib/rateLimit.ts`), not in-memory, survives a serverless cold start and
is shared across instances. Atomic `rl_*` Postgres functions do the
read-modify-write in one statement; old buckets are swept daily,
piggybacked on the existing `order-timeouts` cron. Honest limit: the
test suite (`tests/rateLimit.test.ts`) proves the call-shape and the
exponential-backoff/fixed-window math, not true multi-connection
Postgres concurrency, that guarantee comes from `select ... for update`
row locking itself, same distinction this file's own race-condition
section draws elsewhere.

### CSRF

`sameSite=lax` plus an Origin/Referer check in middleware.
**Updated, production-hardening pass:** the real Circle webhook
(`/api/webhooks/circle`) is the exclusion this section used to say a
future one would need — `middleware.ts`'s `CSRF_EXEMPT_PATHS`, gated
instead by that route's own signature verification
(`X-Circle-Signature`/`X-Circle-Key-Id`), a server-to-server POST has no
browser Origin/Referer to check in the first place.

### Session revocation

Logout revokes the token on all devices via a `session_valid_after`
stamp, not just a cleared cookie. Suspending a supplier does the same
immediately. This covers this app's own cookie, not Privy's session
state on Privy's own side.

### Internal error leaks

48 raw Postgres/Supabase error messages across 14 route files
sanitized, plus a specific wallet/USDC leak found and fixed. Custom
error classes thrown deep inside `orderService.ts` that reach a
generic catch-all weren't individually re-audited beyond the ones
already checked, same category of risk, smaller and not exhaustively
swept.

### Dependency vulnerabilities

35 down to 33. The one non-breaking fix (axios, high severity) is
applied via `package.json` `overrides`. Two remaining high-severity
issues (`ws` via Privy's SDK, `serialize-javascript` via next-pwa)
need a major-version bump each, deliberately not forced blind.

### Buyer KYC PII (`buyer_kyc_profiles`)

New, real Yellow Card integration requires storing government ID
type/number, DOB, phone, and address per buyer (migration
`0018_buyer_kyc.sql`) — genuinely sensitive PII this app didn't hold
before. Protected by the same RLS pilot as `orders` (self-only select
policy) and never returned to anyone but the owning buyer via the API
layer. **Not done**: no column-level encryption, relies entirely on
Supabase's own at-rest encryption plus RLS/API access control, same
posture as every other table — worth a deliberate call on whether
government ID numbers need field-level encryption on top of that
before this holds real production data at volume.

### The race-condition test

Approve vs. dispute fired concurrently on the same order, exactly one
wins, the other fails clean, funds never double-processed, confirmed
by test. This proves the application's compare-and-swap logic is
correct under interleaving. It does not prove true multi-connection
Postgres concurrency, that guarantee comes from Postgres's own atomic
`UPDATE ... WHERE` semantics, not from the test fixture.

### Row Level Security: a real pilot exists now, not yet everywhere

**Updated.** A genuine identity bridge now exists
(`lib/supabaseUserClient.ts`): a per-request JWT minted for the
specific calling user, carrying a custom `user_row_id` claim (not
`auth.uid()` — that casts to `uuid` and would error on this app's
`bigint` identity), switching the Postgres role to `authenticated` so
RLS policies actually run instead of being bypassed by `service_role`.
Piloted on the highest-stakes table: `GET /api/orders`,
`GET /api/orders/[id]`, `GET /api/orders/[id]/timeline`, and
`GET /api/orders/incoming-calls` (buyer/supplier branches only, admin
unchanged) now run their ownership-determining `orders` query through
this real `authenticated`-role client, backed by migration
`0017_orders_rls_pilot.sql`'s `orders_select_own` policy (plus a
required companion `supplier_profiles_select_own` policy the orders
policy's own subquery depends on). The existing app-layer ownership
checks stay, deliberately redundant — this is a genuine second,
independent layer now, not a decorative one.

**Still true for the other ~25 tables**: no identity bridge is wired
into them, RLS-enabled-zero-policies remains a default-deny backstop
against key misuse there, not an active layer. Extending the pattern
table-by-table (payment_events, disputes, notifications, ...) is real,
bounded follow-up work now that the hard part (the JWT bridge itself)
exists and is proven on the highest-value table.

**Honest limitation**: this can't be verified by the automated test
suite (`FakeSupabase` doesn't run real Postgres) — verifying the second
layer is genuinely load-bearing, not just coincidentally redundant with
the app-layer check, needs a manual test against the real database
(temporarily disable the app-layer check, confirm cross-tenant access
is still blocked by RLS alone).

## Unmitigated

Open, not fixed, left alone on purpose, each for a stated reason.

### 2FA, CAPTCHA, login brute-force protection

Not this app's code. Login runs through Privy, OTP, magic-link, and
2FA all live on Privy's side. This app's own session-establishment
surface is already rate-limited.

### File-upload hardening

Content sniffing, malware scanning, EXIF handling: genuinely not
applicable. There is no file-upload endpoint anywhere in this app;
every "photo" and "receipt" is a plain URL a user pastes.

## Bottom line

The application layer is genuinely strong: ownership checks,
server-derived amounts and roles, parameterized queries, and a
17-test attack suite all held. That was the layer doing ALL the work
for a while; a real, independent database-level backstop now exists
for the highest-stakes table (`orders`, via the RLS pilot above), not
yet for the other ~25. A bug in a future route handler touching those
other tables still has nothing else standing between it and the data.

Everything else on the unmitigated list is either out of this
codebase's control (Privy) or doesn't exist yet to secure (file
uploads). Extending the RLS pilot to the rest of the schema is the one
gap that's real, in scope, bounded, and still open — the hard part (a
working identity bridge) is done.
