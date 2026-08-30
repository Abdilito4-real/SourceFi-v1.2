// lib/yellowCardProvider.ts
//
// A REAL PaymentBoundary implementation for the NGN legs (funding,
// refund) — Yellow Card's Business API, confirmed directly against
// their published docs (docs.yellowcard.engineering), not guessed,
// same rigor as lib/circleEscrowProvider.ts's Circle integration.
// Restricted to bank-transfer (P2P) funding only, a deliberate product
// decision: refunds/cancellations are only documented to work for
// Nigeria bank-transfer receives, and every order this app creates
// must stay refundable (cancellation, dispute rulings). No channelId
// lookup needed — `channelType: "bank"` + country + currency is Yellow
// Card's own documented alternative.
//
// IMPORTANT, KYC dependency: initiateOrderFunding needs a
// buyer_kyc_profiles row (migration 0018_buyer_kyc.sql) — the primary
// gate is lib/orderService.ts's fundOrder (a clean domain error before
// the order even reaches payment_processing), this class re-checks
// (MissingBuyerKycError) as a second, independent layer, same
// "deliberately redundant" posture as the rest of this hardening pass.
//
// IMPORTANT, refund is full-amount only: Yellow Card's refund endpoint
// takes no amount parameter, only the original receive's id — no
// partial-refund support is documented. A fee-retention cancellation
// (recordPartialRefundWithFee) does NOT map onto this endpoint;
// initiateRefund refuses (YellowCardPartialRefundUnsupportedError)
// rather than silently sending a full refund when a partial one was
// asked for. Confirm with Yellow Card support before this path is ever
// exercised for a fee-retention case in production.
//
// IMPORTANT, genuinely unconfirmed pieces (flagged, not guessed): the
// exact nested `recipient` object field names beyond what the docs'
// prose states, and the exact `bankInfo`/List Webhooks response shapes
// — their interactive schema panels didn't fully expand during
// research. Confirm the literal request/response against Yellow Card's
// sandbox once real credentials exist, before the first real funding
// attempt.
//
// IMPORTANT, real settlement (createSettlementSend below): confirmed
// directly against docs.yellowcard.engineering/docs/buy-sell-digital-assets
// that Yellow Card's real crypto-to-bank mechanism is a Send request
// with `directSettlement: true` — you send USDC to a deposit address
// THEY return, they convert and pay the destination bank account, NOT a
// plain wallet-to-wallet transfer. `lib/circleEscrowProvider.ts`'s
// escrow release now sends there instead of the supplier's own wallet,
// see that file. Two things genuinely unconfirmed from docs alone, not
// guessed: (1) the exact base Send request field names beyond the
// USD/EUR-institution special case the docs spell out in full (the
// plain-NGN destination shape here is inferred from the "Making a Send"
// guide's own field table plus this project's own
// supplier_payout_profiles columns, migration 0019); (2) the real
// webhook event name for a completed settlement — Yellow Card's own
// docs (/docs/webhooks-api) say they're mid-migration from legacy
// (PAYMENT.*) to v2 (SEND.*/CRYPTO_SEND.*/CONVERT.*) event names, NEW
// webhooks default to v2 already, but the buy-sell-digital-assets guide
// page itself still shows legacy names — meaning that page is stale
// relative to their own current terminology. Confirm the real event
// name against a live sandbox notification before relying on this in
// production, see checkAndReportSettlementStatus's own comment below.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  StubPaymentProvider,
  type PaymentBoundary,
  type PaymentStatusEvent,
  type FundingResult,
  type ReleaseResult,
  type RefundResult,
  type RatingSubmissionResult,
} from "./paymentBoundary";
import { signYellowCardRequest, verifyYellowCardWebhookSignature } from "./yellowCardAuth";
import { uuidv5, SOURCEFI_UUID_NAMESPACE } from "./uuidv5";

export type YellowCardEnvironment = "sandbox" | "production";

export interface YellowCardConfig {
  apiKey: string;
  secretKey: string;
  environment: YellowCardEnvironment;
}

const API_HOSTS: Record<YellowCardEnvironment, string> = {
  sandbox: "https://sandbox.api.yellowcard.io",
  production: "https://api.yellowcard.io",
};

export class YellowCardApiError extends Error {
  readonly statusCode: number;
  readonly body: unknown;
  constructor(statusCode: number, body: unknown) {
    super(`Yellow Card API returned ${statusCode}: ${typeof body === "object" ? JSON.stringify(body) : String(body)}`);
    this.name = "YellowCardApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class MissingBuyerKycError extends Error {
  constructor(buyerId: number) {
    super(`Buyer ${buyerId} has no KYC profile on file. Cannot submit a Yellow Card receive request.`);
    this.name = "MissingBuyerKycError";
  }
}

export class YellowCardPartialRefundUnsupportedError extends Error {
  constructor(orderId: number, requestedMinor: number, originalMinor: number) {
    super(
      `Yellow Card's refund endpoint only supports refunding the FULL original receive amount. Order ${orderId} requested a refund of ${requestedMinor} minor units but the original funded amount was ${originalMinor}. Confirm with Yellow Card support whether a partial refund is possible before building around this.`
    );
    this.name = "YellowCardPartialRefundUnsupportedError";
  }
}

export class NoFundingReferenceOnFileError extends Error {
  constructor(orderId: number) {
    super(`Order ${orderId} has no Yellow Card receive reference on file. Cannot refund.`);
    this.name = "NoFundingReferenceOnFileError";
  }
}

/** migration 0019_supplier_payout.sql's own header comment anticipated
 * exactly this class, under exactly this name: "a
 * MissingSupplierPayoutProfileError-style re-check inside the actual
 * payout call itself... is NOT built yet — there is no real Send call
 * at all yet." Same "clean domain error before the call reaches the
 * payment provider" posture MissingBuyerKycError already established. */
export class MissingSupplierPayoutProfileError extends Error {
  constructor(supplierUserId: number) {
    super(`Supplier (user ${supplierUserId}) has no payout bank details on file. Cannot submit a Yellow Card settlement send.`);
    this.name = "MissingSupplierPayoutProfileError";
  }
}

interface SubmitReceiveResponse {
  id: string;
  status?: string;
  bankInfo?: { bankName?: string; accountNumber?: string; accountName?: string };
}

interface LookupReceiveResponse {
  status?: string;
}

/** The crypto deposit address genuinely isn't confirmed at the exact
 * field-path level (see this file's header) — the guide's prose says
 * only "the customer receives a crypto currency wallet address" without
 * showing the literal response JSON. Checked defensively across every
 * plausible location rather than assuming one, see
 * extractCryptoDepositAddress below. */
interface SubmitSendResponse {
  id: string;
  status?: string;
  cryptoDepositAddress?: string;
  depositAddress?: string;
  walletAddress?: string;
  settlementInfo?: { walletAddress?: string; depositAddress?: string };
  cryptoDetails?: { walletAddress?: string; depositAddress?: string };
}

function extractCryptoDepositAddress(response: SubmitSendResponse): string | undefined {
  return (
    response.cryptoDepositAddress ??
    response.depositAddress ??
    response.walletAddress ??
    response.settlementInfo?.walletAddress ??
    response.settlementInfo?.depositAddress ??
    response.cryptoDetails?.walletAddress ??
    response.cryptoDetails?.depositAddress
  );
}

interface LookupSendResponse {
  status?: string;
}

/** `path` MUST start with /business/... — the exact same string is both
 * the fetch URL suffix and what gets signed (Yellow Card's docs example
 * explicitly includes /business in the signed path), so there's no way
 * for the two to drift apart. Exported (not just YellowCardProvider's
 * own private method) so lib/yellowCardWalletTopupProvider.ts can reuse
 * the exact same signing/fetch plumbing for a leg that isn't order-scoped
 * at all, without depending on this class's order-shaped public API. */
export async function yellowCardRequest<T>(config: YellowCardConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
  const authHeaders = signYellowCardRequest(config.apiKey, config.secretKey, method, path, bodyStr);
  const apiHost = API_HOSTS[config.environment];
  const response = await fetch(`${apiHost}${path}`, {
    method,
    headers: {
      ...authHeaders,
      accept: "application/json",
      ...(bodyStr ? { "content-type": "application/json" } : {}),
    },
    body: bodyStr,
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) throw new YellowCardApiError(response.status, responseBody);
  return responseBody as T;
}

/** The GET + status-normalize half of checkAndReportReceiveStatus below,
 * extracted so lib/yellowCardWalletTopupProvider.ts can reuse it — a
 * top-up receive is the exact same Yellow Card resource type as a
 * funding receive, just not tied to an order, so the raw status lookup
 * is identical, only the interpretation differs (see this class's own
 * checkAndReportReceiveStatus vs. YellowCardWalletTopupProvider's
 * checkAndReportTopupStatus). */
export async function fetchReceiveStatus(config: YellowCardConfig, receiveId: string): Promise<string | null> {
  const receive = await yellowCardRequest<LookupReceiveResponse>(config, "GET", `/business/receive/${receiveId}`);
  return receive?.status?.toLowerCase() ?? null;
}

/** Same shape as fetchReceiveStatus, for a Send instead of a Receive —
 * used by checkAndReportSettlementStatus below and by the webhook
 * route's fallback re-fetch. */
export async function fetchSendStatus(config: YellowCardConfig, sendReference: string): Promise<string | null> {
  const send = await yellowCardRequest<LookupSendResponse>(config, "GET", `/business/send/${sendReference}`);
  return send?.status?.toLowerCase() ?? null;
}

export interface SettlementSendResult {
  sendReference: string;
  /** Send the escrow's USDC here, NOT to the supplier's own wallet —
   * this is what actually makes this a real bank payout instead of a
   * crypto one, see this file's header. */
  cryptoDepositAddress: string;
}

/** Called by lib/circleEscrowProvider.ts's initiateEscrowRelease BEFORE
 * the real Circle transfer — this decides WHERE that USDC actually
 * goes. Confirmed real mechanism (a Send request with
 * directSettlement, not a wallet-to-wallet transfer), confirmed real
 * `reason` values (docs.yellowcard.engineering/docs/payment-reasons-api,
 * "other" is the correct fit here, none of the other 8 fixed options
 * describe paying a supplier) — but the base (non-USD/EUR) destination
 * object's exact field names, and the exact shape the returned crypto
 * deposit address lives at, are NOT spelled out field-by-field in the
 * docs (see this file's header and extractCryptoDepositAddress above).
 * Inferred from the "Making a Send" guide's own field table
 * (bank name/account holder name/account number/network) plus this
 * project's own supplier_payout_profiles columns (migration 0019),
 * which were deliberately shaped to match. Confirm against a real
 * sandbox call before the first real settlement attempt. */
export async function createSettlementSend(
  supabase: SupabaseClient,
  config: YellowCardConfig,
  params: { orderId: number; supplierProfileId: number; ngnAmountMinor: number }
): Promise<SettlementSendResult> {
  const { data: supplierProfile, error: supplierError } = await supabase
    .from("supplier_profiles")
    .select("user_id")
    .eq("id", params.supplierProfileId)
    .maybeSingle();
  if (supplierError) throw supplierError;
  if (!supplierProfile) throw new Error(`Supplier profile ${params.supplierProfileId} not found.`);

  const { data: payout, error: payoutError } = await supabase
    .from("supplier_payout_profiles")
    .select("*")
    .eq("user_id", supplierProfile.user_id)
    .maybeSingle();
  if (payoutError) throw payoutError;
  // migration 0019's own header comment anticipated exactly this check,
  // under exactly this name — see MissingSupplierPayoutProfileError.
  if (!payout) throw new MissingSupplierPayoutProfileError(supplierProfile.user_id as number);

  // MUST match whatever chain ESCROW_WALLET_ID actually holds USDC on
  // in Circle's own console (invisible to this codebase) — refusing to
  // default or guess, sending real USDC on the wrong network is
  // unrecoverable. See docs/payment-integration.md.
  const cryptoNetwork = process.env.YELLOW_CARD_ESCROW_CRYPTO_NETWORK;
  if (!cryptoNetwork) {
    throw new Error(
      "YELLOW_CARD_ESCROW_CRYPTO_NETWORK is not set. This must match the blockchain your Circle escrow wallet actually holds USDC on — refusing to guess, sending real USDC to the wrong network is unrecoverable."
    );
  }

  // NGN, whole naira: ngnAmountMinor is kobo (lib/money.ts's x100
  // convention), same localAmount convention initiateOrderFunding's
  // Receive request already uses.
  const localAmount = Math.round(params.ngnAmountMinor / 100);

  const requestBody = {
    channelType: "bank",
    country: "NG",
    currency: "NGN",
    localAmount,
    // Deterministic idempotency key, same pattern as every other leg —
    // a retried settlement for the same order sends the same
    // sequenceId every time.
    sequenceId: uuidv5(`settlement:${params.orderId}`, SOURCEFI_UUID_NAMESPACE),
    directSettlement: true,
    settlementInfo: {
      cryptoCurrency: "USDC",
      cryptoNetwork,
    },
    reason: "other", // confirmed valid value, see this function's doc comment
    destination: {
      accountType: "bank",
      accountBank: payout.bank_name,
      accountName: payout.account_name,
      accountNumber: payout.account_number,
      networkId: payout.bank_network_id ?? undefined,
    },
  };

  const response = await yellowCardRequest<SubmitSendResponse>(config, "POST", "/business/send", requestBody);
  if (!response?.id) throw new Error(`Yellow Card submit send for order ${params.orderId} returned no id.`);

  const cryptoDepositAddress = extractCryptoDepositAddress(response);
  if (!cryptoDepositAddress) {
    throw new Error(
      `Yellow Card submit send for order ${params.orderId} (send ${response.id}) returned no crypto deposit address in any expected response field — the response shape needs confirming against a real sandbox call, see this file's header and extractCryptoDepositAddress.`
    );
  }

  return { sendReference: response.id, cryptoDepositAddress };
}

export class YellowCardProvider implements PaymentBoundary {
  private readonly supabase: SupabaseClient;
  private readonly config: YellowCardConfig;
  private readonly onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void;
  // Release (Circle's job) and on-chain rating (contract undecided) are
  // not this class's legs, delegated exactly the way
  // CircleEscrowProvider delegates the legs IT doesn't own.
  private readonly delegate: StubPaymentProvider;

  constructor(supabase: SupabaseClient, onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void, config: YellowCardConfig) {
    this.supabase = supabase;
    this.config = config;
    this.onStatusUpdate = onStatusUpdate;
    this.delegate = new StubPaymentProvider(onStatusUpdate);
  }

  /** Delegates to the module-level yellowCardRequest above (extracted so
   * lib/yellowCardWalletTopupProvider.ts can reuse it too) — kept as a
   * method purely so every call site inside this class stays unchanged. */
  private request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return yellowCardRequest<T>(this.config, method, path, body);
  }

  /** Called when the buyer clicks "Fund Order". Bank-transfer only
   * (channelType: "bank"), see this file's header for why. */
  async initiateOrderFunding(orderId: number): Promise<FundingResult> {
    const { data: order, error: orderError } = await this.supabase.from("orders").select("amount_minor, buyer_id").eq("id", orderId).maybeSingle();
    if (orderError) throw orderError;
    if (!order) throw new Error(`Order ${orderId} not found.`);

    const [{ data: kyc, error: kycError }, { data: buyerUser, error: buyerError }] = await Promise.all([
      this.supabase.from("buyer_kyc_profiles").select("*").eq("user_id", order.buyer_id).maybeSingle(),
      this.supabase.from("users").select("email").eq("id", order.buyer_id).maybeSingle(),
    ]);
    if (kycError) throw kycError;
    if (buyerError) throw buyerError;
    if (!kyc) throw new MissingBuyerKycError(order.buyer_id);

    // NGN, whole naira: amount_minor is kobo (lib/money.ts's x100
    // convention), Yellow Card's localAmount is documented int32.
    const localAmount = Math.round(order.amount_minor / 100);

    const requestBody = {
      channelType: "bank",
      country: "NG",
      currency: "NGN",
      localAmount,
      // Deterministic idempotency key, same lib/uuidv5.ts pattern
      // lib/circleEscrowProvider.ts uses for Circle's idempotencyKey —
      // a retried funding attempt for the same order sends the same
      // sequenceId every time.
      sequenceId: uuidv5(`funding:${orderId}`, SOURCEFI_UUID_NAMESPACE),
      customerType: "retail" as const,
      customerUID: String(order.buyer_id),
      forceAccept: true,
      recipient: {
        name: `${kyc.first_name} ${kyc.last_name}`,
        phone: kyc.phone,
        email: buyerUser?.email ?? undefined,
        country: kyc.country,
        address: kyc.address,
        dob: kyc.date_of_birth,
        idNumber: kyc.id_number,
        idType: kyc.id_type,
      },
    };

    const response = await this.request<SubmitReceiveResponse>("POST", "/business/receive", requestBody);
    if (!response?.id) throw new Error(`Yellow Card submit receive for order ${orderId} returned no id.`);

    return {
      paymentReference: response.id,
      status: "processing",
      paymentInstructions: response.bankInfo
        ? {
            bankName: response.bankInfo.bankName ?? "",
            accountNumber: response.bankInfo.accountNumber ?? "",
            accountName: response.bankInfo.accountName ?? "",
          }
        : undefined,
    };
  }

  /** Called after an admin rules a dispute for the buyer (full refund),
   * or a termination flow's full (non-fee-retaining) refund. Refuses
   * rather than guesses if amountMinor is a PARTIAL amount, see this
   * file's header. */
  async initiateRefund(orderId: number, amountMinor: number): Promise<RefundResult> {
    const { data: order, error: orderError } = await this.supabase.from("orders").select("amount_minor").eq("id", orderId).maybeSingle();
    if (orderError) throw orderError;
    if (!order) throw new Error(`Order ${orderId} not found.`);

    if (amountMinor !== order.amount_minor) {
      throw new YellowCardPartialRefundUnsupportedError(orderId, amountMinor, order.amount_minor);
    }

    const { data: fundingEvent, error: eventError } = await this.supabase
      .from("payment_events")
      .select("provider_reference")
      .eq("order_id", orderId)
      .eq("leg", "funding")
      .not("provider_reference", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eventError) throw eventError;
    const receiveId = fundingEvent?.provider_reference as string | undefined;
    if (!receiveId) throw new NoFundingReferenceOnFileError(orderId);

    await this.request("POST", `/business/receive/${receiveId}/refund`);
    return { refundReference: receiveId, status: "processing" };
  }

  initiateEscrowRelease(orderId: number): Promise<ReleaseResult> {
    return this.delegate.initiateEscrowRelease(orderId);
  }

  submitRatingOnChain(orderId: number, supplierId: number, score: number, comment: string | null): Promise<RatingSubmissionResult> {
    return this.delegate.submitRatingOnChain(orderId, supplierId, score, comment);
  }

  /** `signatureBase64` is the X-YC-Signature header value, `rawBody`
   * the exact request body text (not re-serialized JSON). */
  verifyWebhookSignature(rawBody: string, signatureBase64: string): boolean {
    return verifyYellowCardWebhookSignature(rawBody, signatureBase64, this.config.secretKey);
  }

  /** Re-fetches the CURRENT, authoritative state of one receive from
   * Yellow Card (client.getTransaction()'s equivalent) and reports it
   * if terminal. `leg` distinguishes a funding-confirmation check from
   * a refund-confirmation check against the SAME underlying receive id
   * (the resource's `status` field means different things depending on
   * which leg is being watched, see this file's header). Returns true
   * once reported (confirmed or failed), false if still pending. */
  async checkAndReportReceiveStatus(orderId: number, receiveId: string, leg: "funding" | "refund"): Promise<boolean> {
    const status = await fetchReceiveStatus(this.config, receiveId);
    if (!status) return false;

    const confirmedStatuses = leg === "funding" ? ["complete", "completed"] : ["refunded"];
    const failedStatuses = leg === "funding" ? ["failed", "expired", "denied", "cancelled"] : ["refund_failed"];

    if (confirmedStatuses.includes(status)) {
      await this.onStatusUpdate({ orderId, leg, provider: "yellow_card", providerReference: receiveId, providerState: status });
      return true;
    }
    if (failedStatuses.includes(status)) {
      console.error(`Yellow Card receive ${receiveId} for order ${orderId} (${leg} leg) ended in state ${status}. Needs manual reconciliation.`);
      return true;
    }
    return false; // still pending/processing
  }

  /** Same shape as checkAndReportReceiveStatus, for the settlement leg
   * (a Send, not a Receive) — re-fetches the CURRENT, authoritative
   * state of one settlement send and reports it to
   * handleSettlementConfirmed (lib/orderService.ts) if terminal. Called
   * from app/api/webhooks/yellowcard/route.ts once it's resolved a
   * notification's reference against a leg='settlement' payment_events
   * row. Confirmed statuses reuse the generic Send/Receive lifecycle
   * vocabulary Yellow Card documents at /docs/events-api (COMPLETE/
   * FAILED/EXPIRED are the same regardless of leg); "paid_out" is
   * included defensively in case the direct-settlement flow reports a
   * more specific terminal state than the generic one — narrow this
   * once a real sandbox notification is observed, see this file's
   * header. */
  async checkAndReportSettlementStatus(orderId: number, sendReference: string): Promise<boolean> {
    const status = await fetchSendStatus(this.config, sendReference);
    if (!status) return false;

    const confirmedStatuses = ["complete", "completed", "paid_out"];
    const failedStatuses = ["failed", "expired", "denied", "cancelled"];

    if (confirmedStatuses.includes(status)) {
      await this.onStatusUpdate({ orderId, leg: "settlement", provider: "yellow_card", providerReference: sendReference, providerState: status });
      return true;
    }
    if (failedStatuses.includes(status)) {
      console.error(
        `Yellow Card settlement send ${sendReference} for order ${orderId} ended in state ${status}. The supplier's USDC already left escrow — needs manual reconciliation directly with Yellow Card and the supplier, not an automatic retry.`
      );
      return true;
    }
    return false; // still pending/processing
  }

  /** Idempotent webhook registration, same posture as
   * CircleEscrowProvider.registerWebhook: checks List Webhooks first,
   * skips creation if our endpoint's already there. Subscribes to ALL
   * events (omits `state`) rather than a narrow filter, unhandled event
   * types are simply ignored by the webhook route, same pattern Circle
   * uses. List Webhooks' exact response shape isn't confirmed (bare
   * array vs. {data: [...]}), handled defensively either way. */
  async registerWebhook(endpointUrl: string): Promise<{ created: boolean; endpoint: string }> {
    const existing = await this.request<{ data?: Array<{ url: string }> } | Array<{ url: string }>>("GET", "/business/webhooks");
    const list = Array.isArray(existing) ? existing : existing?.data ?? [];
    const match = list.find((w) => w.url === endpointUrl);
    if (match) return { created: false, endpoint: endpointUrl };

    await this.request("POST", "/business/webhooks", { url: endpointUrl, active: true });
    return { created: true, endpoint: endpointUrl };
  }
}
