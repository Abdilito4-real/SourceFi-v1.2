// lib/paymentProvider.ts
//
// The one place a route handler gets a PaymentBoundary instance from,
// never `new StubPaymentProvider(...)`/`new CircleEscrowProvider(...)`/
// `new YellowCardProvider(...)` inline in a route. Swapping providers
// means changing this file only.
//
// Part 4 of the production-hardening pass: this now composes up to TWO
// independently-real providers instead of a flat stub-vs-Circle
// ternary. Release (escrow -> supplier) upgrades to CircleEscrowProvider
// the moment CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET/ESCROW_WALLET_ID are
// ALL set; funding/refund (the NGN legs) upgrade to YellowCardProvider
// the moment its own env vars are set — independently of each other, so
// "Circle is real but Yellow Card isn't yet" (today's actual state) and
// "both are real" (once Yellow Card integration is actually built, see
// lib/yellowCardProvider.ts) both work without this file changing again.
// On-chain rating has no decided contract yet, always the stub.
//
// IMPORTANT: StubPaymentProvider's "confirmation" is simulated via an
// in-process setTimeout callback (see lib/paymentBoundary.ts), that
// only works because this is a long-running `next dev`/`next start`
// Node process holding a module-level singleton in memory. A real
// provider integration does NOT get to assume that, see
// lib/circleEscrowProvider.ts's own webhook+reconciliation notes for how
// Circle's release leg now handles this for real.
//
// Also composes the buyer wallet's top-up leg (WalletTopupProvider,
// lib/walletService.ts) off the SAME Yellow Card credentials as the
// funding/refund PaymentBoundary legs — a different interface (a top-up
// isn't order-scoped), same env vars, same "upgrades the moment
// credentials are set" pattern, so it lives here too rather than a
// second, parallel composition file.
import "server-only";
import { getSupabaseServerClient } from "./supabaseServer";
import { handlePaymentStatusEvent } from "./orderService";
import {
  StubPaymentProvider,
  type PaymentBoundary,
  type PaymentStatusEvent,
  type FundingResult,
  type ReleaseResult,
  type RefundResult,
  type RatingSubmissionResult,
} from "./paymentBoundary";
import { CircleEscrowProvider } from "./circleEscrowProvider";
import { YellowCardProvider, type YellowCardEnvironment, type YellowCardConfig } from "./yellowCardProvider";
import { YellowCardWalletTopupProvider } from "./yellowCardWalletTopupProvider";
import { StubWalletTopupProvider, confirmWalletTopup, type WalletTopupProvider } from "./walletService";

/** Routes each of the 4 PaymentBoundary methods independently to
 * whichever real provider is configured for THAT leg, falling back to
 * the shared stub otherwise. Needed the moment both Circle and Yellow
 * Card credentials exist at once: a flat "return one full
 * PaymentBoundary" switch (what this file used to be) has no way to be
 * "Circle for release AND Yellow Card for funding" simultaneously. */
class CompositePaymentProvider implements PaymentBoundary {
  constructor(
    private readonly releaseProvider: PaymentBoundary,
    private readonly fundingRefundProvider: PaymentBoundary,
    private readonly ratingProvider: PaymentBoundary
  ) {}

  initiateOrderFunding(orderId: number): Promise<FundingResult> {
    return this.fundingRefundProvider.initiateOrderFunding(orderId);
  }
  initiateRefund(orderId: number, amountMinor: number): Promise<RefundResult> {
    return this.fundingRefundProvider.initiateRefund(orderId, amountMinor);
  }
  initiateEscrowRelease(orderId: number): Promise<ReleaseResult> {
    return this.releaseProvider.initiateEscrowRelease(orderId);
  }
  submitRatingOnChain(orderId: number, supplierId: number, score: number, comment: string | null): Promise<RatingSubmissionResult> {
    return this.ratingProvider.submitRatingOnChain(orderId, supplierId, score, comment);
  }
}

let boundarySingleton: PaymentBoundary | null = null;
// Kept separately (not just reached for via `instanceof` through the
// composite above) so app/api/webhooks/circle/route.ts,
// app/api/admin/circle-webhook/register/route.ts, and
// lib/releaseReconciliation.ts can get the CONCRETE Circle instance
// directly, they need methods (checkAndReportReleaseStatus,
// verifyWebhookSignature, registerWebhook) that aren't part of the
// generic PaymentBoundary interface.
let circleSingleton: CircleEscrowProvider | null = null;
// Same reasoning as circleSingleton above: app/api/webhooks/yellowcard/route.ts
// and app/api/admin/yellowcard-webhook/register/route.ts need the
// CONCRETE Yellow Card instance for methods (checkAndReportReceiveStatus,
// verifyWebhookSignature, registerWebhook) that aren't part of the
// generic PaymentBoundary interface.
let yellowCardSingleton: YellowCardProvider | null = null;
// The wallet top-up leg (WalletTopupProvider), resolved (real or stub)
// the same way boundarySingleton is for PaymentBoundary.
let walletTopupBoundary: WalletTopupProvider | null = null;
// Concrete instance, same reasoning as yellowCardSingleton above:
// app/api/webhooks/yellowcard/route.ts needs checkAndReportTopupStatus,
// which isn't part of the generic WalletTopupProvider interface.
let yellowCardWalletTopupSingleton: YellowCardWalletTopupProvider | null = null;

function buildOnStatusUpdate() {
  return async (event: PaymentStatusEvent) => {
    try {
      const supabase = getSupabaseServerClient();
      await handlePaymentStatusEvent(supabase, event);
    } catch (err) {
      // A failure here means an order can get stuck mid-processing with
      // no automatic recovery, exactly the "what if our DB write fails
      // after the provider succeeded" failure scenario the design doc
      // flags (Section H) as needing a real reconciliation job. Logged
      // loudly rather than swallowed so it's visible instead of silently
      // stuck. (lib/releaseReconciliation.ts's cron sweep independently
      // re-checks Circle's own state regardless of whether THIS write
      // succeeded, which is the actual mitigation for the release leg.)
      console.error("Payment status event handling failed:", event, err);
    }
  };
}

// StubWalletTopupProvider's own confirmation path (a real one goes
// through app/api/webhooks/yellowcard/route.ts instead, never this).
// Mirrors buildOnStatusUpdate's exact shape: a fresh
// getSupabaseServerClient() per call, log-and-swallow rather than
// throw, same "don't let a background confirmation crash the process"
// posture.
function buildOnTopupConfirmed() {
  return async (userId: number, amountMinor: number, reference: string) => {
    try {
      const supabase = getSupabaseServerClient();
      await confirmWalletTopup(supabase, userId, amountMinor, reference);
    } catch (err) {
      console.error("Wallet top-up confirmation handling failed:", { userId, amountMinor, reference }, err);
    }
  };
}

function initSingletons(): void {
  if (boundarySingleton) return;

  const onStatusUpdate = buildOnStatusUpdate();
  const supabase = getSupabaseServerClient();
  const stub = new StubPaymentProvider(onStatusUpdate);

  // Built BEFORE Circle now: real escrow release needs this too (see
  // below) — the settlement leg's deposit address, which decides WHERE
  // the release's USDC actually goes, comes from Yellow Card's Send
  // API, not from the supplier's own wallet anymore.
  const yellowCardApiKey = process.env.YELLOW_CARD_API_KEY;
  const yellowCardSecretKey = process.env.YELLOW_CARD_SECRET_KEY;
  // Validated, not just cast: an unrecognized value (a typo like "Prod"
  // or "production ") used to silently become `undefined` when indexed
  // into yellowCardProvider.ts's API_HOSTS map, producing a confusing
  // broken-fetch-URL failure deep in a request instead of a clear error
  // right here at startup — the same "no silent guess" posture
  // YELLOW_CARD_ESCROW_CRYPTO_NETWORK already has below.
  const rawYellowCardEnvironment = process.env.YELLOW_CARD_ENVIRONMENT?.trim() || "sandbox";
  if (rawYellowCardEnvironment !== "sandbox" && rawYellowCardEnvironment !== "production") {
    throw new Error(
      `YELLOW_CARD_ENVIRONMENT must be "sandbox" or "production", got "${rawYellowCardEnvironment}". ` +
        `Never defaults to production — fix .env.local, see .env.local.example.`
    );
  }
  const yellowCardEnvironment: YellowCardEnvironment = rawYellowCardEnvironment;
  const yellowCardConfigured = Boolean(yellowCardApiKey && yellowCardSecretKey);
  let yellowCardConfig: YellowCardConfig | null = null;
  if (yellowCardConfigured) {
    yellowCardConfig = {
      apiKey: yellowCardApiKey!,
      secretKey: yellowCardSecretKey!,
      environment: yellowCardEnvironment,
    };
    yellowCardSingleton = new YellowCardProvider(supabase, onStatusUpdate, yellowCardConfig);
    yellowCardWalletTopupSingleton = new YellowCardWalletTopupProvider(supabase, yellowCardConfig);
  }
  const fundingRefundProvider: PaymentBoundary = yellowCardSingleton ?? stub;
  walletTopupBoundary = yellowCardWalletTopupSingleton ?? new StubWalletTopupProvider(buildOnTopupConfirmed());

  const circleApiKey = process.env.CIRCLE_API_KEY;
  const circleEntitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const escrowWalletId = process.env.ESCROW_WALLET_ID;
  const circleConfigured = Boolean(circleApiKey && circleEntitySecret && escrowWalletId);
  if (circleConfigured) {
    // yellowCardConfig passed through even when null: a real release
    // now genuinely needs it (the settlement send), CircleEscrowProvider
    // itself refuses loudly at release time rather than this file
    // silently deciding Circle "isn't real" just because Yellow Card
    // isn't configured yet — see that file's own comment.
    circleSingleton = new CircleEscrowProvider(
      supabase,
      onStatusUpdate,
      {
        apiKey: circleApiKey!,
        entitySecret: circleEntitySecret!,
        escrowWalletId: escrowWalletId!,
      },
      yellowCardConfig
    );
  }
  const releaseProvider: PaymentBoundary = circleSingleton ?? stub;

  // On-chain rating has no decided chain/contract yet (see
  // lib/paymentBoundary.ts's AUTO_REFUND_ELIGIBLE_DISPUTE_TYPES doc
  // comment for the same "not scoped yet" posture), always the stub.
  const ratingProvider: PaymentBoundary = stub;

  boundarySingleton =
    circleConfigured || yellowCardConfigured ? new CompositePaymentProvider(releaseProvider, fundingRefundProvider, ratingProvider) : stub;
}

export function getPaymentProvider(): PaymentBoundary {
  initSingletons();
  return boundarySingleton!;
}

/** The concrete Circle instance, or null if Circle isn't configured.
 * Use this (not getPaymentProvider()) whenever Circle-specific methods
 * are needed, getPaymentProvider() may return a CompositePaymentProvider
 * wrapping it rather than the instance itself. */
export function getCircleEscrowProvider(): CircleEscrowProvider | null {
  initSingletons();
  return circleSingleton;
}

/** The concrete Yellow Card instance, or null if it isn't configured.
 * Same reasoning as getCircleEscrowProvider above. */
export function getYellowCardProvider(): YellowCardProvider | null {
  initSingletons();
  return yellowCardSingleton;
}

/** The wallet top-up leg (real YellowCardWalletTopupProvider once
 * YELLOW_CARD_API_KEY/YELLOW_CARD_SECRET_KEY are set, StubWalletTopupProvider
 * otherwise) — app/api/wallet/topup/route.ts's one source for this,
 * never `new StubWalletTopupProvider(...)` inline in a route. */
export function getWalletTopupProvider(): WalletTopupProvider {
  initSingletons();
  return walletTopupBoundary!;
}

/** The concrete Yellow Card wallet top-up instance, or null if it isn't
 * configured. Use this (not getWalletTopupProvider()) for
 * checkAndReportTopupStatus, which isn't part of the generic
 * WalletTopupProvider interface — app/api/webhooks/yellowcard/route.ts's
 * one use for it. */
export function getYellowCardWalletTopupProvider(): YellowCardWalletTopupProvider | null {
  initSingletons();
  return yellowCardWalletTopupSingleton;
}
