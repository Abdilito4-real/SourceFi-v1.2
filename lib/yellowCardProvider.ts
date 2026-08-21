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

interface SubmitReceiveResponse {
  id: string;
  status?: string;
  bankInfo?: { bankName?: string; accountNumber?: string; accountName?: string };
}

interface LookupReceiveResponse {
  status?: string;
}

export class YellowCardProvider implements PaymentBoundary {
  private readonly supabase: SupabaseClient;
  private readonly config: YellowCardConfig;
  private readonly apiHost: string;
  private readonly onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void;
  // Release (Circle's job) and on-chain rating (contract undecided) are
  // not this class's legs, delegated exactly the way
  // CircleEscrowProvider delegates the legs IT doesn't own.
  private readonly delegate: StubPaymentProvider;

  constructor(supabase: SupabaseClient, onStatusUpdate: (event: PaymentStatusEvent) => Promise<void> | void, config: YellowCardConfig) {
    this.supabase = supabase;
    this.config = config;
    this.apiHost = API_HOSTS[config.environment];
    this.onStatusUpdate = onStatusUpdate;
    this.delegate = new StubPaymentProvider(onStatusUpdate);
  }

  /** `path` MUST start with /business/... — the exact same string is
   * both the fetch URL suffix and what gets signed (Yellow Card's docs
   * example explicitly includes /business in the signed path), so
   * there's no way for the two to drift apart. */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const authHeaders = signYellowCardRequest(this.config.apiKey, this.config.secretKey, method, path, bodyStr);
    const response = await fetch(`${this.apiHost}${path}`, {
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
    const receive = await this.request<LookupReceiveResponse>("GET", `/business/receive/${receiveId}`);
    const status = receive?.status?.toLowerCase();
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
