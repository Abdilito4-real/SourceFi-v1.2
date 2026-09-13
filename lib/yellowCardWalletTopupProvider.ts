// lib/yellowCardWalletTopupProvider.ts
//
// A REAL WalletTopupProvider implementation — the buyer wallet's own
// top-up leg (migration 0020_buyer_wallet.sql), previously always
// StubWalletTopupProvider (lib/walletService.ts). Same Yellow Card
// resource (`POST /business/receive` / `GET /business/receive/{id}`)
// lib/yellowCardProvider.ts's real order-funding leg already uses, just
// not tied to an order — a top-up funds the buyer's platform balance
// directly, before any specific order exists.
//
// IMPORTANT, the reason this stayed simulated until now: Yellow Card's
// refund endpoint refunds exactly one whole original receive, no amount
// parameter, no partial-refund support. There is still no way to give a
// buyer back an unspent PORTION of a top-up once some of it's been
// spent across orders — this integration is deliberately ONE-WAY,
// confirmed with the user. Real money goes in; there is no
// initiateWithdrawal here, and none is planned until that's resolved
// with Yellow Card. See docs/payment-integration.md's "Buyer wallet"
// section for the full reasoning.
//
// IMPORTANT, idempotency: sequenceId is derived from a CALLER-supplied
// idempotencyKey (see WalletTopupProvider's own doc comment,
// lib/walletService.ts), not from anything generated inside this class.
// A top-up has no pre-existing DB identity the way an order does
// (initiateOrderFunding's sequenceId keys off orderId, which already
// exists before that call happens); a genuine client retry has to bring
// its own stable key for Yellow Card's own dedup to actually prevent a
// second real bank-transfer request — same trust model
// docs/payment-integration.md's idempotency section already accepts for
// the release leg (the provider's own dedup on a deterministic key is
// the primary protection).
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { yellowCardRequest, fetchReceiveStatus, MissingBuyerKycError, type YellowCardConfig } from "./yellowCardProvider";
import { uuidv5, SOURCEFI_UUID_NAMESPACE } from "./uuidv5";
import { confirmWalletTopup, type WalletTopupProvider, type WalletTopupResult } from "./walletService";

interface SubmitReceiveResponse {
  id: string;
  status?: string;
  bankInfo?: { bankName?: string; accountNumber?: string; accountName?: string };
}

// Same vocabulary lib/yellowCardProvider.ts's checkAndReportReceiveStatus
// uses for the funding leg — a top-up receive is that exact same
// resource type, just not tied to an order.
const CONFIRMED_STATUSES = ["complete", "completed"];
const FAILED_STATUSES = ["failed", "expired", "denied", "cancelled"];

export class YellowCardWalletTopupProvider implements WalletTopupProvider {
  private readonly supabase: SupabaseClient;
  private readonly config: YellowCardConfig;

  constructor(supabase: SupabaseClient, config: YellowCardConfig) {
    this.supabase = supabase;
    this.config = config;
  }

  /** Called when the buyer submits a top-up. Bank-transfer only
   * (channelType: "bank"), same reasoning lib/yellowCardProvider.ts's
   * initiateOrderFunding already documents. */
  async initiateTopup(userId: number, amountMinor: number, idempotencyKey: string): Promise<WalletTopupResult> {
    const [{ data: kyc, error: kycError }, { data: buyerUser, error: buyerError }] = await Promise.all([
      this.supabase.from("buyer_kyc_profiles").select("*").eq("user_id", userId).maybeSingle(),
      this.supabase.from("users").select("email").eq("id", userId).maybeSingle(),
    ]);
    if (kycError) throw kycError;
    if (buyerError) throw buyerError;
    // Redundant re-check: lib/walletService.ts's initiateWalletTopup
    // already gates on this before ever reaching a provider, same
    // "guard redundantly, never trust a single check" posture
    // initiateOrderFunding's own MissingBuyerKycError re-check uses.
    if (!kyc) throw new MissingBuyerKycError(userId);

    // NGN, whole naira: amount_minor is kobo (lib/money.ts's x100
    // convention), Yellow Card's localAmount is documented int32.
    const localAmount = Math.round(amountMinor / 100);

    const requestBody = {
      channelType: "bank",
      country: "NG",
      currency: "NGN",
      localAmount,
      sequenceId: uuidv5(`wallet-topup:${idempotencyKey}`, SOURCEFI_UUID_NAMESPACE),
      customerType: "retail" as const,
      customerUID: String(userId),
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

    const response = await yellowCardRequest<SubmitReceiveResponse>(this.config, "POST", "/business/receive", requestBody);
    if (!response?.id) throw new Error(`Yellow Card submit receive for a wallet top-up (user ${userId}) returned no id.`);

    return {
      reference: response.id,
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

  /** Called from the Yellow Card webhook route once it's established a
   * notification's receiveId matches a wallet_transactions row rather
   * than an order (app/api/webhooks/yellowcard/route.ts). Re-fetches
   * the CURRENT, authoritative state (never trusts the webhook body's
   * own lightweight status ping for anything money-relevant, same
   * posture the funding/release legs already have) and reports it if
   * terminal. Returns true once resolved (confirmed or failed), false
   * if still pending. */
  async checkAndReportTopupStatus(receiveId: string): Promise<boolean> {
    const { data: txn, error } = await this.supabase
      .from("wallet_transactions")
      .select("user_id, amount_minor")
      .eq("provider_reference", receiveId)
      .eq("type", "topup")
      .maybeSingle();
    if (error) throw error;
    if (!txn) return false; // not a top-up this class knows about

    const status = await fetchReceiveStatus(this.config, receiveId);
    if (!status) return false;

    if (CONFIRMED_STATUSES.includes(status)) {
      await confirmWalletTopup(this.supabase, txn.user_id as number, txn.amount_minor as number, receiveId);
      return true;
    }
    if (FAILED_STATUSES.includes(status)) {
      // Same "needs manual reconciliation" posture
      // checkAndReportReceiveStatus already has for a failed funding
      // leg — no reconciliation cron exists yet for this leg either
      // (docs/payment-integration.md), only caught by a webhook retry
      // or a direct GET /business/receive/{id} check today.
      await this.supabase
        .from("wallet_transactions")
        .update({ status: "failed" })
        .eq("provider_reference", receiveId)
        .eq("status", "processing");
      console.error(`Yellow Card wallet top-up receive ${receiveId} (user ${txn.user_id}) ended in state ${status}. Needs manual reconciliation.`);
      return true;
    }
    return false; // still pending/processing
  }
}
