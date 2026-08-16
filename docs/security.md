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
account (8 per 10 min). In-memory, resets on a serverless cold start.
Fine for one long-running process, needs a shared store (Redis, or
Supabase-backed) before this is a real production guarantee.

### CSRF

`sameSite=lax` plus an Origin/Referer check in middleware. A future
real payment-provider webhook will need an explicit exclusion here,
authenticated by its own signature instead.

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

### The race-condition test

Approve vs. dispute fired concurrently on the same order, exactly one
wins, the other fails clean, funds never double-processed, confirmed
by test. This proves the application's compare-and-swap logic is
correct under interleaving. It does not prove true multi-connection
Postgres concurrency, that guarantee comes from Postgres's own atomic
`UPDATE ... WHERE` semantics, not from the test fixture.

## Unmitigated

Open, not fixed, left alone on purpose, each for a stated reason.

### Row Level Security provides no actual defense in depth

Zero RLS policies exist across any migration, and the app always
connects with the Supabase **service role key**, which bypasses RLS
regardless of policy. The API route layer is the only thing enforcing
access control today, well-built (see IDOR above), but with nothing
independent behind it. Fixing this for real means moving off a single
service-role client, an architecture change, not a patch.

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
17-test attack suite all held. That's the layer doing all the work,
though, **there is no database-level backstop behind it.** A bug in a
future route handler has nothing else standing between it and the
data.

Everything else on the unmitigated list is either out of this
codebase's control (Privy) or doesn't exist yet to secure (file
uploads). RLS is the one gap that's real, in scope, and still open.
