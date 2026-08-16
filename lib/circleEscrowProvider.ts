// lib/circleEscrowProvider.ts
//
// A REAL PaymentBoundary implementation for the escrow-release leg only
// — the buyer's "Accept delivery" click actually moves USDC out of the
// Circle developer-controlled escrow wallet to the supplier's on-file
// wallet address, via Circle's real API. This is the one leg that can be
// made genuinely real today: funding and settlement are NGN legs that
// depend on Yellow Card, which has no credentials configured anywhere in
// this project — those stay delegated to StubPaymentProvider (simulated)
// until that integration exists. See lib/paymentProvider.ts for how this
// is selected: only when CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET /
// ESCROW_WALLET_ID are all actually set, never silently.
//
// IMPORTANT — irreversibility: createTransaction() below sends real
// on-chain value (real money on mainnet, worthless-but-real testnet
// tokens on a testnet — this class has no way to tell which, and doesn't
// try to guess). There is no "undo." Every safety check in
// initiateEscrowRelease() that can fail loudly before that call (missing
// wallet address, no USDC token found, insufficient balance) is there on
// purpose — better a clear thrown error than an ambiguous on-chain
// failure.
//
// IMPORTANT — confirmation is polled in-process (setInterval), same
// documented limitation lib/paymentBoundary.ts's StubPaymentProvider and
// lib/paymentProvider.ts already carry: this only works because this is
// a long-running `next start` Node process holding state in memory. If
// the process restarts mid-poll, that specific release's confirmation
// event is lost (the on-chain transfer itself is NOT lost — Circle still
// completes it — only this app's follow-up ledger write is delayed until
// someone/something calls handlePaymentStatusEvent for it another way).
// A production version needs a Circle webhook subscription
// (client.createSubscription) or a durable poll job, not this. Flagged,
// not solved, same posture the rest of this codebase's payment layer
// takes toward what's genuinely out of scope for this stage.
import type { SupabaseClient } from "@supabase/supabase-js";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import {
  StubPaymentProvider,
  type PaymentBoundary,
  type PaymentStatusEvent,
  type FundingResult,
  type ReleaseResult,
  type RefundResult,
  type RatingSubmissionResult,
} from "./paymentBoundary";
import { computeUsdcSplit } from "./orderService";

export interface CircleEscrowConfig {
  apiKey: string;
  entitySecret: string;
  escrowWalletId: string;
}

export class MissingSupplierWalletError extends Error {
  constructor(supplierId: number) {
    super(`Supplier ${supplierId} has no wallet_address on file — cannot send a real USDC release to nowhere.`);
    this.name = "MissingSupplierWalletError";
  }
}

export class NoUsdcTokenOnEscrowWalletError extends Error {
  constructor(walletId: string) {
    super(`Escrow wallet ${walletId} has no USDC token balance entry — verify it's the right wallet/blockchain.`);
    this.name = "NoUsdcTokenOnEscrowWalletError";
  }
}

export class InsufficientEscrowBalanceError extends Error {
  constructor(required: string, available: string) {
    super(`Escrow wallet holds ${available} USDC, less than the ${required} USDC this release requires.`);
    this.name = "InsufficientEscrowBalanceError";
  }
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 60; // ~5 minutes

export class CircleEscrowProvider implements PaymentBoundary {
  private readonly client: ReturnType<typeof initiateDeveloperControlledWalletsClient>;
  private readonly config: CircleEscrowConfig;
  private readonly supabase: SupabaseClient;
  private readonly onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void;
  // Funding, refund, and on-chain rating submission are NOT Circle's
  // responsibility (funding/refund are NGN legs — Yellow Card's job;
  // rating mechanics are an open design question per
  // lib/paymentBoundary.ts) — delegate those three untouched to the same
  // simulated stub the rest of the app already runs on, rather than
  // reimplementing "fake but realistic" event scheduling twice.
  private readonly delegate: StubPaymentProvider;

  constructor(
    supabase: SupabaseClient,
    onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void,
    config: CircleEscrowConfig
  ) {
    this.supabase = supabase;
    this.onStatusUpdate = onStatusUpdate;
    this.config = config;
    this.client = initiateDeveloperControlledWalletsClient({ apiKey: config.apiKey, entitySecret: config.entitySecret });
    this.delegate = new StubPaymentProvider(onStatusUpdate);
  }

  initiateOrderFunding(orderId: number): Promise<FundingResult> {
    return this.delegate.initiateOrderFunding(orderId);
  }

  initiateRefund(orderId: number, amountMinor: number): Promise<RefundResult> {
    return this.delegate.initiateRefund(orderId, amountMinor);
  }

  submitRatingOnChain(
    orderId: number,
    supplierId: number,
    score: number,
    comment: string | null
  ): Promise<RatingSubmissionResult> {
    return this.delegate.submitRatingOnChain(orderId, supplierId, score, comment);
  }

  /** The real leg. Sends supplierUsdcMinor (computeUsdcSplit's supplier
   * cut — the SAME number handleReleaseConfirmed will independently
   * derive and book to the ledger once this confirms) from the escrow
   * wallet to the assigned supplier's on-file wallet address. The
   * platform's fee cut is deliberately NOT moved anywhere on-chain here
   * — it stays sitting in the escrow wallet, which is what
   * PLATFORM_REVENUE's ledger entry already assumes (see lib/ledger.ts's
   * recordEscrowRelease comment: the fee's USDC is never converted or
   * moved per-order in this design). */
  async initiateEscrowRelease(orderId: number): Promise<ReleaseResult> {
    const { data: order, error: orderError } = await this.supabase
      .from("orders")
      .select("amount_minor, platform_fee_minor, supplier_id")
      .eq("id", orderId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) throw new Error(`Order ${orderId} not found.`);

    const { data: supplier, error: supplierError } = await this.supabase
      .from("supplier_profiles")
      .select("wallet_address")
      .eq("id", order.supplier_id)
      .maybeSingle();
    if (supplierError) throw supplierError;
    if (!supplier?.wallet_address) throw new MissingSupplierWalletError(order.supplier_id);

    const { supplierUsdcMinor } = computeUsdcSplit(order);
    // This codebase's USDC "minor units" convention is cents-scale (x100
    // — see lib/money.ts), not native 6-decimal micro-USDC. Circle's
    // `amount` field wants major-unit decimal strings ("312.50").
    const amountMajor = (supplierUsdcMinor / 100).toFixed(2);

    const balanceResponse = await this.client.getWalletTokenBalance({ id: this.config.escrowWalletId });
    const usdcBalance = balanceResponse.data?.tokenBalances?.find((b) => b.token.symbol === "USDC");
    if (!usdcBalance) throw new NoUsdcTokenOnEscrowWalletError(this.config.escrowWalletId);
    if (Number(usdcBalance.amount) < Number(amountMajor)) {
      throw new InsufficientEscrowBalanceError(amountMajor, usdcBalance.amount);
    }

    // idempotencyKey deliberately omitted (Circle auto-generates one) —
    // the real guard against calling this twice for one order is the
    // order-status compare-and-swap in lib/orderService.ts's
    // tryTransition(), already in place before this function is ever
    // reached, not a client-provided key here.
    const response = await this.client.createTransaction({
      walletId: this.config.escrowWalletId,
      destinationAddress: supplier.wallet_address,
      tokenId: usdcBalance.token.id,
      amount: [amountMajor],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      refId: `order-${orderId}-release`,
    });

    const releaseReference = response.data?.id;
    if (!releaseReference) throw new Error(`Circle createTransaction for order ${orderId} returned no transaction id.`);

    void this.pollUntilConfirmed(orderId, releaseReference);
    return { releaseReference, status: "processing" };
  }

  /** Circle transactions don't confirm synchronously — this app has no
   * webhook endpoint yet, so poll instead (see module comment for why
   * that's a real limitation, not a real production design). Stops
   * polling (and never confirms) if the transaction reaches a terminal
   * non-success state or MAX_POLL_ATTEMPTS is exceeded, logging loudly
   * either way rather than failing silently. */
  private async pollUntilConfirmed(orderId: number, transactionId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const { data } = await this.client.getTransaction({ id: transactionId });
        const txn = data?.transaction;
        if (!txn) continue;

        if (txn.state === "COMPLETE" || txn.state === "CONFIRMED") {
          await this.onStatusUpdate({
            orderId,
            leg: "release",
            provider: "circle",
            providerReference: transactionId,
            providerState: txn.state,
            txHash: txn.txHash ?? undefined,
          });
          return;
        }
        if (txn.state === "FAILED" || txn.state === "CANCELLED" || txn.state === "DENIED") {
          console.error(`Circle release transaction ${transactionId} for order ${orderId} ended in state ${txn.state} — order is stuck, needs manual reconciliation.`);
          return;
        }
        // Any other state (QUEUED, SENT, PENDING_RISK_SCREENING, ...) —
        // keep polling.
      } catch (err) {
        console.error(`Polling Circle transaction ${transactionId} for order ${orderId} failed:`, err);
      }
    }
    console.error(`Circle release transaction ${transactionId} for order ${orderId} never reached a terminal state after ${MAX_POLL_ATTEMPTS} polls — needs manual reconciliation.`);
  }
}
