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
| `initiateOrderFunding` | Simulated (`StubPaymentProvider`) | Yellow Card is integrated, see below |
| `initiateEscrowRelease` | **Real** if Circle credentials are set, simulated otherwise | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `ESCROW_WALLET_ID` are all set |
| `initiateRefund` | Simulated | Yellow Card is integrated |
| `submitRatingOnChain` | Always simulated, returns `"submitted"`, never `"confirmed"` | The rating contract/chain is decided (not scoped yet) |

There's no partial-credit state for Circle: either all three env vars
are present and `CircleEscrowProvider` handles every release, or none
are and the stub handles all of them. Check `getPaymentProvider()` in
`lib/paymentProvider.ts` if you want to see the exact switch.

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

### Known gaps, even with real credentials wired in

Before this goes anywhere near production money:

- No webhook endpoint exists yet. Release confirmation is polled
  (`pollUntilConfirmed` in `lib/circleEscrowProvider.ts`), not pushed.
  This works but is not how a mature integration should run.
- A release that never reaches a terminal state after the poll limit
  logs an error and stops, it does **not** retry or alert anyone
  automatically. That's a manual reconciliation gap, not solved by
  this codebase today.
- The platform fee is never moved on-chain per order, it stays in the
  escrow wallet by design (see `lib/ledger.ts`'s
  `recordEscrowRelease`). Don't "fix" this without updating the ledger
  logic to match, they're written to agree with each other.

## Yellow Card (NGN funding and settlement)

**Not built at all.** There are no Yellow Card environment variables,
no Yellow Card SDK dependency, and no partial implementation anywhere
in this codebase. `initiateOrderFunding`, `initiateRefund`, and the
settlement leg are 100% simulated regardless of any other credentials
you set.

### To integrate it

1. Add a `YellowCardProvider` implementing the same `PaymentBoundary`
   methods, following the shape of `CircleEscrowProvider` as a
   reference (constructor takes config + an `onStatusUpdate`
   callback, each method returns a `"processing"` result immediately
   and reports the real outcome later through that callback).
2. Wire it into `getPaymentProvider()` in `lib/paymentProvider.ts` the
   same way Circle is wired in, gated on Yellow Card's own env vars
   being present.
3. Decide, and document, whether Yellow Card's API is webhook-based or
   needs polling like Circle's does today, this determines whether
   you need a new API route or can reuse the poll pattern.
4. `initiateOrderFunding` and `initiateRefund` both need a real NGN
   amount, in minor units (kobo), read from the order row, never from
   client input, same rule as everywhere else in this codebase.

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
