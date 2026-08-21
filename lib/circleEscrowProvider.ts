// lib/circleEscrowProvider.ts
//
// A REAL PaymentBoundary implementation for the escrow-release leg only
//, the buyer's "Accept delivery" click actually moves USDC out of the
// Circle developer-controlled escrow wallet to the supplier's on-file
// wallet address, via Circle's real API. This is the one leg that can be
// made genuinely real today: funding and settlement are NGN legs that
// depend on Yellow Card, which has no credentials configured anywhere in
// this project, those stay delegated to StubPaymentProvider (simulated)
// until that integration exists. See lib/paymentProvider.ts for how this
// is selected: only when CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET /
// ESCROW_WALLET_ID are all actually set, never silently.
//
// IMPORTANT, irreversibility: createTransaction() below sends real
// on-chain value (real money on mainnet, worthless-but-real testnet
// tokens on a testnet, this class has no way to tell which, and doesn't
// try to guess). There is no "undo." Every safety check in
// initiateEscrowRelease() that can fail loudly before that call (missing
// wallet address, no USDC token found, insufficient balance) is there on
// purpose, better a clear thrown error than an ambiguous on-chain
// failure.
//
// UPDATED, webhook + reconciliation now exist: the in-process poll
// below (pollUntilConfirmed) is a fast best-effort first path only, not
// the sole source of truth anymore. app/api/webhooks/circle/route.ts
// (Circle's real notification, signature-verified) and
// app/api/cron/reconcile-releases/route.ts (a durable, DB-driven sweep
// for anything stuck at release_submitted/release_processing) both call
// checkAndReportReleaseStatus below independently, so a process restart
// mid-poll now costs a delay until the next webhook/sweep, not a
// silently lost confirmation. See docs/payment-integration.md for the
// full picture, including the Vercel cron-frequency caveat.
import "server-only";
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
import { uuidv5, SOURCEFI_UUID_NAMESPACE } from "./uuidv5";
import { resolveCircleTransactionOutcome, type CircleTransactionOutcome } from "./circleTransactionOutcome";
import { verifyCircleNotificationSignature } from "./circleWebhook";

export interface CircleEscrowConfig {
  apiKey: string;
  entitySecret: string;
  escrowWalletId: string;
}

export class MissingSupplierWalletError extends Error {
  constructor(supplierId: number) {
    super(`Supplier ${supplierId} has no wallet_address on file. Cannot release USDC.`);
    this.name = "MissingSupplierWalletError";
  }
}

export class NoUsdcTokenOnEscrowWalletError extends Error {
  constructor(walletId: string) {
    super(`Escrow wallet ${walletId} has no USDC balance entry. Check the wallet and blockchain.`);
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
// How long a fetched webhook-signing public key is trusted before
// re-fetching. Public keys are not secret and rotate rarely; this is an
// efficiency cache (fewer Circle API calls per webhook), not a
// correctness boundary, worst case is one extra fetch after a restart.
const NOTIFICATION_KEY_TTL_MS = 60 * 60 * 1000;

interface CachedNotificationKey {
  publicKey: string;
  algorithm: string;
  fetchedAt: number;
}

export class CircleEscrowProvider implements PaymentBoundary {
  private readonly client: ReturnType<typeof initiateDeveloperControlledWalletsClient>;
  private readonly config: CircleEscrowConfig;
  private readonly supabase: SupabaseClient;
  private readonly onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void;
  // Funding/refund are Yellow Card's job, not Circle's. Delegate those
  // (and on-chain rating, still stubbed) to the same simulated provider.
  private readonly delegate: StubPaymentProvider;
  private readonly notificationKeyCache = new Map<string, CachedNotificationKey>();

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

  /** Sends the supplier's USDC cut from the escrow wallet to their
   * on-file wallet address. The platform fee stays in escrow, it's
   * never moved on-chain (see lib/ledger.ts's recordEscrowRelease). */
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

    // Live NGN/USD rate (lib/fxRate.ts), resolved ONCE here and
    // persisted below immediately after Circle actually accepts the
    // transaction, every later step that books this release to the
    // ledger reads that persisted value back rather than recomputing
    // against a rate that's since moved, see computeUsdcSplit's doc
    // comment in lib/orderService.ts.
    const { totalUsdcMinor, supplierUsdcMinor, platformFeeUsdcMinor, ngnPerUsd } = await computeUsdcSplit(order);
    // Minor units here are cents-scale (see lib/money.ts), not native
    // 6-decimal micro-USDC. Circle wants a major-unit decimal string.
    const amountMajor = (supplierUsdcMinor / 100).toFixed(2);

    const balanceResponse = await this.client.getWalletTokenBalance({ id: this.config.escrowWalletId });
    const usdcBalance = balanceResponse.data?.tokenBalances?.find((b) => b.token.symbol === "USDC");
    if (!usdcBalance) throw new NoUsdcTokenOnEscrowWalletError(this.config.escrowWalletId);
    if (Number(usdcBalance.amount) < Number(amountMajor)) {
      throw new InsufficientEscrowBalanceError(amountMajor, usdcBalance.amount);
    }

    // idempotencyKey: deterministic (lib/uuidv5.ts), derived from the
    // order id alone, so the ORIGINAL attempt and any later retry
    // (app/api/admin/orders/[id]/retry-release) send the exact same key.
    // Circle's own docs describe idempotencyKey as making "multiple
    // identical requests have the same effect as a single request" — a
    // resend with this key returns the original transaction rather than
    // creating a second on-chain transfer. This is the fix for the gap
    // this comment used to describe: a naive retry risking paying the
    // supplier twice. tryTransition()'s compare-and-swap remains a
    // second, independent guard at the state-machine level; this is the
    // provider-level one docs/payment-integration.md said was missing.
    const response = await this.client.createTransaction({
      walletId: this.config.escrowWalletId,
      destinationAddress: supplier.wallet_address,
      tokenId: usdcBalance.token.id,
      amount: [amountMajor],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      refId: `order-${orderId}-release`,
      idempotencyKey: uuidv5(`release:${orderId}`, SOURCEFI_UUID_NAMESPACE),
    });

    const releaseReference = response.data?.id;
    if (!releaseReference) throw new Error(`Circle createTransaction for order ${orderId} returned no transaction id.`);

    // Persisted immediately after Circle accepted the transaction, i.e.
    // this IS what was actually sent, not what was merely computed.
    // handleReleaseConfirmed/handleSettlementConfirmed (lib/orderService.ts)
    // read this back rather than recomputing against a rate that may
    // have since moved, see computeUsdcSplit's doc comment there.
    const { error: persistError } = await this.supabase
      .from("orders")
      .update({
        release_usdc_total_minor: totalUsdcMinor,
        release_usdc_platform_fee_minor: platformFeeUsdcMinor,
        release_ngn_per_usd: ngnPerUsd,
      })
      .eq("id", orderId);
    if (persistError) {
      // The on-chain transfer already happened, that's real regardless.
      // Losing this write only means the LATER ledger entry falls back
      // to recomputing at a possibly-different rate (resolveUsdcSplitForLedger's
      // fallback), a reconciliation nuisance, not a lost transfer, so
      // this is logged loudly rather than thrown.
      console.error(`Failed to persist the USDC split for order ${orderId} after a successful release:`, persistError);
    }

    void this.pollUntilConfirmed(orderId, releaseReference);
    return { releaseReference, status: "processing" };
  }

  /** A fast, best-effort first path, NOT the only path anymore: the
   * webhook (app/api/webhooks/circle/route.ts) and the reconciliation
   * cron (app/api/cron/reconcile-releases/route.ts, via
   * checkAndReportReleaseStatus below) both independently re-check the
   * same transaction and feed it through the same
   * resolveCircleTransactionOutcome + onStatusUpdate path, so a process
   * restart mid-poll now costs a delay until the next webhook/sweep, not
   * a silently lost confirmation. */
  private async pollUntilConfirmed(orderId: number, transactionId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      try {
        const reported = await this.checkAndReportReleaseStatus(orderId, transactionId);
        if (reported) return;
      } catch (err) {
        console.error(`Polling Circle transaction ${transactionId} for order ${orderId} failed:`, err);
      }
    }
    console.error(`Circle release ${transactionId} for order ${orderId} never settled after ${MAX_POLL_ATTEMPTS} polls in-process. The reconciliation cron will keep checking.`);
  }

  /** Fetches the CURRENT, authoritative state of one release transaction
   * from Circle (a real API call) and reports it if terminal. Used by
   * pollUntilConfirmed, the reconciliation cron, and by the webhook
   * handler ONLY as a fallback when a notification body doesn't carry
   * a usable state (see reportWebhookNotification below, the normal
   * webhook path, which doesn't need this extra round trip). Returns
   * true once reported (confirmed or failed), false if still pending. */
  async checkAndReportReleaseStatus(orderId: number, transactionId: string): Promise<boolean> {
    const { data } = await this.client.getTransaction({ id: transactionId });
    const txn = data?.transaction;
    if (!txn) return false;
    return this.reportOutcome(orderId, transactionId, resolveCircleTransactionOutcome(txn));
  }

  /** The webhook's normal path (app/api/webhooks/circle/route.ts):
   * reports directly from the notification body Circle already sent,
   * no extra client.getTransaction() call. Safe to trust the body's
   * state/txHash/errorReason here, now that the payload shape is
   * confirmed against Circle's own docs (matches the REST Transaction
   * object exactly) — the signature already proves it's genuinely from
   * Circle, and downstream processing (handleReleaseConfirmed's
   * order.status guard) is already idempotent against a stale/
   * out-of-order delivery regardless of whether the state came from
   * the body or from a fresh re-fetch, so re-fetching bought no extra
   * safety, just an extra round trip. Falls back to
   * checkAndReportReleaseStatus (a real re-fetch) only if the body is
   * missing a usable `state`, e.g. an unrecognized notification shape. */
  async reportWebhookNotification(orderId: number, transactionId: string, notification: unknown): Promise<boolean> {
    const state = typeof notification === "object" && notification !== null ? (notification as Record<string, unknown>).state : undefined;
    if (typeof state !== "string") {
      return this.checkAndReportReleaseStatus(orderId, transactionId);
    }
    const obj = notification as Record<string, unknown>;
    const outcome = resolveCircleTransactionOutcome({
      state,
      txHash: typeof obj.txHash === "string" ? obj.txHash : undefined,
      errorReason: typeof obj.errorReason === "string" ? obj.errorReason : undefined,
    });
    return this.reportOutcome(orderId, transactionId, outcome);
  }

  private async reportOutcome(orderId: number, transactionId: string, outcome: CircleTransactionOutcome): Promise<boolean> {
    if (outcome.kind === "confirmed") {
      await this.onStatusUpdate({
        orderId,
        leg: "release",
        provider: "circle",
        providerReference: transactionId,
        providerState: outcome.state,
        txHash: outcome.txHash,
      });
      return true;
    }
    if (outcome.kind === "failed") {
      console.error(
        `Circle release ${transactionId} for order ${orderId} ended in state ${outcome.state}` +
          (outcome.errorReason ? ` (${outcome.errorReason})` : "") +
          `. Needs manual reconciliation (see app/api/admin/orders/[id]/retry-release).`
      );
      return true;
    }
    return false; // still pending (QUEUED, SENT, ...), check again later
  }

  /** Verifies a real Circle webhook notification. `keyId` is the
   * `X-Circle-Key-Id` header value, `signatureBase64` the
   * `X-Circle-Signature` header value, `rawBody` the exact request body
   * text (not re-serialized JSON). See lib/circleWebhook.ts for the
   * actual crypto; this method only owns fetching/caching the signing
   * public key via client.getNotificationSignature(), which needs
   * this.client (constructed with real Circle credentials). */
  async verifyWebhookSignature(rawBody: string, keyId: string, signatureBase64: string): Promise<boolean> {
    const cached = this.notificationKeyCache.get(keyId);
    const keyInfo = cached && Date.now() - cached.fetchedAt < NOTIFICATION_KEY_TTL_MS ? cached : await this.fetchNotificationKey(keyId);
    return verifyCircleNotificationSignature(rawBody, signatureBase64, keyInfo.publicKey, keyInfo.algorithm);
  }

  private async fetchNotificationKey(keyId: string): Promise<CachedNotificationKey> {
    // The SDK's parameter is misleadingly named `subscriptionId`, Circle's
    // own JSDoc for this method (verified against the installed package)
    // says to pass the `X-Circle-Key-Id` header value here, not this
    // app's subscription id.
    const response = await this.client.getNotificationSignature(keyId);
    const publicKey = response.data?.publicKey;
    const algorithm = response.data?.algorithm;
    if (!publicKey || !algorithm) throw new Error(`Circle returned no signing key for notification key id ${keyId}.`);
    const keyInfo: CachedNotificationKey = { publicKey, algorithm, fetchedAt: Date.now() };
    this.notificationKeyCache.set(keyId, keyInfo);
    return keyInfo;
  }

  /** Idempotent webhook registration: an admin action
   * (app/api/admin/circle-webhook/register/route.ts), not something run
   * automatically on server boot, a real deployed HTTPS URL has to exist
   * first. Safe to call more than once: checks listSubscriptions() for
   * an existing subscription pointed at the same endpoint before
   * creating a new one, so re-running this after a redeploy doesn't
   * accumulate duplicate subscriptions. */
  async registerWebhook(endpointUrl: string): Promise<{ created: boolean; subscriptionId: string; endpoint: string }> {
    const existing = await this.client.listSubscriptions();
    const match = existing.data?.find((sub) => sub.endpoint === endpointUrl);
    if (match) return { created: false, subscriptionId: match.id, endpoint: match.endpoint };

    const response = await this.client.createSubscription({ endpoint: endpointUrl });
    const created = response.data;
    if (!created) throw new Error("Circle createSubscription returned no subscription data.");
    return { created: true, subscriptionId: created.id, endpoint: created.endpoint };
  }
}
