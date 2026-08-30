// lib/types.ts
//
// Stage 5: these types now describe the real schema in
// supabase/migrations/0000_fresh_project_full_schema.sql (or
// 0001_stage4_auth.sql + 0002_stage5_data_layer.sql for the original
// project), not a reverse-engineered guess from a JSONB blob anymore.
// Money is integer minor units everywhere, see lib/money.ts for the one
// place that converts to/from a display number.

// "admin" added in Stage 4, granted only via direct DB write (bootstrap)
// or PATCH /api/admin/users/[id]/role by an existing admin. There is no
// self-service path to it anywhere in the client.
//
// "sourcer" -> "supplier" as of the marketplace pivot (see
// docs/marketplace-payments-design.md Section 0 and migration
// 0004_marketplace_pivot.sql, which renames existing rows). This is a
// breaking change on purpose: every file still referencing "sourcer" as
// a Role value is exactly the set of files Stage 3 of the pivot (payment/
// application integration + route rewrite) needs to touch. Left broken
// rather than shimmed so `tsc`/`npm run build` is the checklist.
export type Role = "buyer" | "supplier" | "admin";

/** @deprecated Superseded by OrderStatus (see below) as of the marketplace
 * pivot, sourcing_requests is renamed deprecated_sourcing_requests in
 * migration 0004. Kept here, unused, rather than deleted outright, so any
 * code that still imports it fails loudly instead of silently. */
export type RequestStatus =
  | "open"
  | "claimed"
  | "escrow"
  | "verified"
  | "escrow_released"
  | "disputed"
  | "cancelled"
  | "expired";

/** The order lifecycle, see docs/marketplace-payments-design.md Section D
 * for the full state diagram and lib/orderStateMachine.ts for the legal
 * transitions between these. Matches the `order_status` Postgres enum in
 * migration 0004_marketplace_pivot.sql exactly; keep these in sync by hand
 * (Supabase doesn't generate these types for us in this project).
 *
 * Note `settled` has no transition to `disputed` in the state machine even
 * though a post-settlement issue can still be reported, that report is a
 * `disputes` row with dispute_type = 'post_settlement_report', not a
 * status change on the order itself. Conflating "what happened to the
 * money" with "is there an open question about it" is the exact mistake
 * this whole redesign exists to avoid (see Section D.0's Circle finding
 * for the same principle applied to the release leg specifically). */
export type OrderStatus =
  | "pending_payment"
  | "payment_processing"
  | "payment_failed"
  | "converting"
  | "escrow_depositing"
  | "funded"
  | "fulfilling"
  | "proof_submitted"
  | "buyer_approved"
  | "release_submitted"
  | "release_processing"
  | "escrow_released"
  | "settlement_processing"
  | "settled"
  | "rejected"
  | "disputed"
  | "refund_processing"
  | "refunded"
  | "cancelled"
  | "expired";

export type Currency = "USD" | "NGN";

export type ToastType = "success" | "error" | "warning" | "info" | "loading";

/** @deprecated Superseded by OrderRow, sourcing_requests is renamed
 * deprecated_sourcing_requests in migration 0004. Row shape as it comes
 * back from Supabase (`sourcing_requests`), plus
 * buyer_email/sourcer_email, NOT real columns, joined in server-side (see
 * app/api/requests/route.ts) so the client can display/compare identity
 * without its own copy of numeric user ids. audit_notes/audit_image/
 * audit_business_id are similarly joined in from the audit_reports table
 * for requests that have one, display-only. */
export interface SourcingRequestRow {
  id: number;
  request_code: string;
  title: string;
  location: string | null;
  category: string | null;
  status: RequestStatus;
  buyer_id: number;
  sourcer_id: number | null;
  material_id: number | null;
  budget_minor: number | null;
  budget_currency: Currency;
  sourcing_fee_minor: number | null;
  platform_fee_minor: number | null;
  invite_sent_at: string | null;
  cleared_by_sourcer: boolean;
  cleared_at: string | null;
  flagged: boolean | null;
  created_at: string;
  buyer_email?: string | null;
  sourcer_email?: string | null;
  audit_notes?: string | null;
  audit_image?: string | null;
  audit_business_id?: string | null;
  deposit_tx_hash?: string | null;
  release_tx_hash?: string | null;
  released_at?: string | null;
}

/** @deprecated Superseded by Order (client shape TBD in Stage 5/UI of the
 * pivot). Client-side shape after App.tsx's `.map()` over the API
 * response. `dbId` (the numeric id) is kept alongside `id` (the
 * human-readable request_code) because every write endpoint addresses a
 * request by numeric id, never by its display code. */
export interface SourcingRequest {
  id: string; // request_code, e.g. "REQ-482913"
  dbId: number;
  title: string;
  buyer: string; // buyer_email, display and ownership-comparison only
  budgetMinor: number | null;
  budgetCurrency: Currency;
  location: string;
  posted: string;
  status: RequestStatus;
  category: string;
  sourcer?: string | null; // sourcer_email
  sourcingFeeMinor: number;
  platformFeeMinor: number;
  inviteSent: boolean;
  clearedBySourcer: boolean;
  clearedAt: string | null;
  flagged?: boolean | null;
  auditNotes?: string | null;
  auditImage?: string | null;
  auditBusinessId?: string | null;
  depositTxHash?: string | null;
  releaseTxHash?: string | null;
  releasedAt?: string | null;
}

export interface UserRow {
  id: number;
  email: string;
  username: string | null;
  wallet_address?: string | null;
  wallet_id?: string | null;
  wallet_set_id?: string | null;
  /** Stage 4: server-assigned, DB-authoritative. Never trust a client-
   * supplied copy of this for an authorization decision. */
  role: Role;
  /** Stage 4: the verified Privy DID this row is bound to. Set once, on
   * first successful session establishment for that DID, see
   * app/api/auth/session/route.ts. Null for pre-Stage-4 rows until their
   * next login. */
  privy_user_id: string | null;
  /** Prompt 3 (termination flows): orthogonal to role, a suspended
   * supplier keeps their role and can still see/manage in-flight orders,
   * just can't receive new ones (see createOrder's check). Never used as
   * an authorization gate on its own; requireRole still authenticates a
   * suspended user normally. */
  suspended_at?: string | null;
  suspension_reason?: string | null;
  suspended_by?: number | null;
  /** Prompt 4, M5, any session token issued before this timestamp is
   * rejected by requireSession(), regardless of its own signature/expiry.
   * Stamped on logout (all devices) and on suspendSupplier. */
  session_valid_after?: string | null;
  /** Migration 0022. Nullable — existing accounts have none, only
   * required going forward at onboarding. See
   * components/ui/ImageUploadField.tsx / lib/uploadValidation.ts. */
  profile_picture_url?: string | null;
}

/** Client-side authenticated-user shape held in App.tsx state, distinct
 * from UserRow (the DB row) and from Privy's own user object. `role` here
 * is a display hint synced from GET /api/auth/me, not a trust boundary
 * every server-side action re-derives role from the DB via the session
 * cookie regardless of what this says. */
export interface AppUser {
  method: "email" | "web3";
  identity: string;
  username: string | null;
  walletAddress: string | null;
  role: Role;
  profilePictureUrl: string | null;
}

/** Payload of our own first-party session cookie (see lib/session.ts)
 * distinct from Privy's access token, which we only ever see once, at
 * session-establishment time, to prove identity. */
export interface SessionClaims {
  privyUserId: string;
  userRowId: number;
  email: string;
  /** Set only when reading a token back (verifySessionToken), never when
   * signing a new one, unix seconds, from the JWT's own `iat` claim.
   * Prompt 4, M5: requireSession() compares this against
   * users.session_valid_after to make logout (and admin suspension)
   * actually revoke the token, not just clear one device's cookie. */
  issuedAt?: number;
}

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** @deprecated Superseded by SupplierVerificationApplicationRow
 * sourcer_applications is renamed deprecated_sourcer_applications in
 * migration 0004. A request to become a sourcer, never a role grant by
 * itself. Only PATCH /api/admin/sourcer-applications/[id]'s approve
 * action (admin-only) ever changes users.role; see lib/authz.ts and
 * CLAUDE.md's rule that a user cannot self-assign the sourcer role.
 * applicant_email/username are joined in server-side for the admin
 * dashboard, same pattern as SourcingRequestRow's buyer_email. */
export interface SourcerApplicationRow {
  id: number;
  user_id: number;
  status: ApplicationStatus;
  location: string | null;
  experience: string | null;
  reason: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  applicant_email?: string | null;
  applicant_username?: string | null;
}

// ============================================================================
// Marketplace pivot, see docs/marketplace-payments-design.md and
// migration 0004_marketplace_pivot.sql. These describe the new schema;
// nothing in app/ or components/ constructs them yet (that's Stage 3+ of
// the pivot) but the routes/UI being written next need a shared shape to
// agree on, same as every type above did for Stage 5's data layer.
// ============================================================================

export type SupplierVerificationStatus = "unverified" | "pending" | "verified" | "expired";

/** A supplier IS a `users` row (role = 'supplier') with this profile
 * attached, not a passive record someone else fills in, which is what
 * the old (now deprecated_suppliers_no_account) table was. verified_at/
 * verification_expires_at/orders_since_verification are the 90-day-OR-
 * 20-order expiry inputs; NEVER trust verification_status alone for an
 * authorization decision (whether this supplier can receive a newly
 * funded order), that check is always the live
 * is_supplier_currently_verified() Postgres function (see
 * lib/supplierVerification.ts), same principle as lib/authz.ts never
 * trusting a client-supplied role. */
/** One row per buyer, self-service, no admin review step (this isn't a
 * role grant, just the KYC data Yellow Card's real "Submit Receive
 * Request" requires in its `recipient` object). See migration
 * 0018_buyer_kyc.sql and lib/orderService.ts's fundOrder gate. */
export interface BuyerKycProfileRow {
  id: number;
  user_id: number;
  first_name: string;
  last_name: string;
  phone: string;
  date_of_birth: string;
  id_type: string;
  id_number: string;
  address: string;
  country: string;
  created_at: string;
  updated_at: string;
}

export interface SupplierProfileRow {
  id: number;
  user_id: number;
  business_name: string;
  cac_registration_number: string | null;
  tax_id_number: string | null;
  business_location: string;
  what_they_sell: string;
  phone: string | null;
  address: string | null;
  verification_status: SupplierVerificationStatus;
  verified_at: string | null;
  verified_by: number | null;
  verification_expires_at: string | null;
  orders_since_verification: number;
  wallet_address: string | null;
  wallet_id: string | null;
  created_at: string;
  /** Prompt 3: set by abandonOrder() on a 2nd strike within 90 days
   * blocks new orders until this timestamp, checked in createOrder().
   * Null means not currently blocked. */
  blocked_until?: string | null;
}

/** Repurposed sourcer_applications, same admin-review shape (pending/
 * approved/rejected, one-pending-per-user, reviewed_by/reviewed_at/
 * review_notes), different fields: this is KYB (is the business real,
 * where is it, what does it sell), not a field-agent vetting form. Also
 * used for re-verification after expiry, same table, same flow. */
export interface SupplierVerificationApplicationRow {
  id: number;
  user_id: number;
  status: ApplicationStatus;
  business_name: string;
  phone: string | null;
  cac_registration_number: string | null;
  tax_id_number: string | null;
  business_location: string;
  what_they_sell: string;
  supporting_document_url: string | null;
  supporting_document_type: string | null;
  reviewed_by: number | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  applicant_email?: string | null;
  applicant_username?: string | null;
}

/** Row shape from `orders`, supersedes SourcingRequestRow. amount_minor/
 * currency are always NGN; the buyer never sees or enters a USDC amount
 * (see design doc Section 3). buyer_email/supplier_business_name are NOT
 * real columns, joined in server-side, same pattern as
 * SourcingRequestRow's buyer_email. */
export interface OrderRow {
  id: number;
  order_code: string;
  status: OrderStatus;
  buyer_id: number;
  supplier_id: number;
  /** @deprecated References the old fixed material catalog (migration
   * 0000), superseded by supplier_listing_id (migration 0006), kept as
   * an unused legacy column, never set by current order-creation code. */
  material_id: number | null;
  supplier_listing_id: number | null;
  title: string;
  description: string | null;
  quantity: string | null;
  delivery_location: string;
  amount_minor: number;
  currency: "NGN";
  platform_fee_minor: number;
  supplier_verified_at_order_time: string | null;
  /** Cumulative real seconds spent in a live verification call (join-to-
   * leave, from Jitsi's own lifecycle events, not just "the panel was
   * open"). Approval is blocked, server-side, until this reaches
   * MIN_VERIFICATION_CALL_SECONDS (lib/orderService.ts), see migration
   * 0007. */
  verification_call_seconds: number;
  /** Set once the buyer confirms the supplier showed the order's own
   * code on camera during the call and it matched, migration 0013.
   * Independent of verification_call_seconds: that proves a call of a
   * certain length connected, this proves it was actually THIS order's
   * live call, not a loop/pre-recorded video. Approval is blocked,
   * server-side, until both are set (lib/orderService.ts). */
  call_code_confirmed_at: string | null;
  /** The Jitsi room's real, private name, a crypto.randomUUID(), never
   * derived from order_code (which is a guessable 6-digit, user-visible
   * string). Nullable because migration 0008 doesn't backfill existing
   * rows; lib/orderService.ts's ensureCallRoomId() lazily fills it in on
   * first read. Only ever returned from ownership-checked routes (see
   * app/api/orders/[id]/route.ts), this IS the access control for the
   * call, since meet.jit.si itself enforces none. */
  verification_call_room_id: string | null;
  /** Set the moment that party joins the call, cleared on a clean leave,
   * refreshed by a heartbeat while in-call, see migration 0012. Treat as
   * stale (not actually in the call) once older than ~45s, a crashed
   * tab never reports "left". Used to prompt the other party with an
   * incoming-call notice instead of requiring them to already be here. */
  buyer_call_active_since: string | null;
  supplier_call_active_since: string | null;
  /** The USDC split actually used for a real Circle release, persisted
   * at release-initiation time so a later ledger entry always matches
   * what was actually sent on-chain, migration 0014. Null unless a real
   * (non-stub) release happened. See lib/orderService.ts's
   * resolveUsdcSplitForLedger. */
  release_usdc_total_minor: number | null;
  release_usdc_platform_fee_minor: number | null;
  release_ngn_per_usd: number | null;
  created_at: string;
  buyer_email?: string | null;
  supplier_business_name?: string | null;
  /** Joined in from supplier_listings when supplier_listing_id is set
   * lets the order detail view show the "unit price x quantity = total"
   * breakdown instead of just the total in isolation. Null for a
   * freeform order (no listing picked). */
  listing_unit_price_minor?: number | null;
  listing_unit?: string | null;
}

export type PaymentLeg = "funding" | "release" | "settlement" | "refund";
// "wallet" (migration 0020): a wallet-funded order's funding/refund
// confirmation fires through the exact same handlePaymentStatusEvent
// consumer (lib/orderService.ts) as a real provider event, just
// synchronous instead of async — see lib/walletService.ts's module
// comment.
export type PaymentProvider = "yellow_card" | "circle" | "wallet";

/** The fine-grained async trail for both the funding leg (NGN -> USDC ->
 * escrow) and the release leg (approval -> transfer -> confirmation)
 * distinct from OrderRow.status (coarse, user-facing) and LedgerEntryRow
 * (accounting). tx_hash is ONLY ever set from a real, confirmed provider
 * lookup (e.g. Circle's getTransaction), see design doc Section D.0 for
 * why a fabricated hash is exactly the bug this schema exists to prevent. */
export interface PaymentEventRow {
  id: number;
  order_id: number;
  leg: PaymentLeg;
  provider: PaymentProvider;
  provider_reference: string | null;
  event_type: string;
  provider_state: string | null;
  tx_hash: string | null;
  amount_minor: number | null;
  currency: string | null;
  raw_payload: unknown;
  created_at: string;
}

export interface DeliveryProofRow {
  id: number;
  order_id: number;
  supplier_id: number;
  photo_urls: string[];
  receipt_url: string | null;
  notes: string | null;
  submitted_at: string;
}

export type LedgerAccount =
  | "ESCROW_WALLET_USDC"
  | "PLATFORM_REVENUE"
  | "SUPPLIER_PAYABLE"
  | "EXTERNAL_NGN_BUYER"
  | "EXTERNAL_NGN_SUPPLIER"
  | "FX_CLEARING";

/** One leg of a double-entry ledger transaction. Every write must insert
 * a full, balanced set of these (same ledger_transaction_id, same
 * currency, debits = credits) within a single DB transaction, see
 * migration 0004's deferred constraint trigger, which enforces this at
 * commit time rather than trusting application code alone. */
export interface LedgerEntryRow {
  id: number;
  ledger_transaction_id: string;
  order_id: number;
  account: LedgerAccount;
  account_ref: number | null;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: "NGN" | "USDC";
  created_at: string;
}

/** One buyer's platform balance (migration 0020). Not part of the
 * ledger_entries double-entry system on purpose, see that migration's
 * header comment — money only enters ledger_entries once it actually
 * funds a specific order. */
export interface BuyerWalletRow {
  user_id: number;
  balance_minor: number;
  currency: "NGN";
  updated_at: string;
}

export type WalletTransactionType = "topup" | "order_funding" | "refund_to_wallet";

/** Append-only wallet audit trail, migration 0020. order_id is null for
 * a topup, set for order_funding/refund_to_wallet. */
export interface WalletTransactionRow {
  id: number;
  user_id: number;
  type: WalletTransactionType;
  amount_minor: number;
  order_id: number | null;
  provider_reference: string | null;
  status: "processing" | "confirmed" | "failed";
  created_at: string;
}

export type DisputeType = "pre_approval_rejection" | "post_settlement_report";
export type DisputeCategory =
  | "item_not_as_described"
  | "item_not_delivered"
  | "quality_issue"
  | "wrong_quantity"
  | "damaged_in_transit"
  | "other";
export type DisputeStatus = "open" | "under_review" | "resolved_buyer" | "resolved_supplier" | "resolved_split";
export type DisputeRuling = "buyer" | "supplier";

/** dispute_type is the field that keeps "buyer rejected the proof before
 * any money moved" and "buyer has a problem after settlement" from being
 * treated as the same situation, see design doc Section C.7. */
export interface DisputeRow {
  id: number;
  order_id: number;
  raised_by: number;
  dispute_type: DisputeType;
  category: DisputeCategory;
  description: string | null;
  evidence_urls: string[];
  status: DisputeStatus;
  resolution_notes: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  created_at: string;
}

export interface DisputeEventRow {
  id: number;
  dispute_id: number;
  actor_id: number | null;
  event_type: string;
  details: unknown;
  created_at: string;
}

// ============================================================================
// Termination flows (Prompt 3), see supabase/migrations/0010_termination_flows.sql
// and lib/orderService.ts's cancelBeforeFunding/cancelFundedOrder/
// abandonOrder/withdrawProof.
// ============================================================================

export type BuyerCancellationCategory = "changed_mind" | "found_alternative" | "no_longer_needed" | "price_disagreement" | "other";
export type SupplierExitCategory = "cannot_fulfill" | "schedule_conflict" | "pricing_error" | "other";
export type CancellationCategory = BuyerCancellationCategory | SupplierExitCategory;

export interface OrderStatusHistoryRow {
  id: number;
  order_id: number;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  actor_id: number | null;
  actor_role: "buyer" | "supplier" | "admin" | "system";
  reason_category: string | null;
  reason_text: string | null;
  created_at: string;
}

export interface OrderCancellationRow {
  id: number;
  order_id: number;
  actor_id: number;
  actor_role: "buyer" | "supplier";
  category: CancellationCategory;
  description: string | null;
  fee_charged_minor: number;
  refund_minor: number | null;
  created_at: string;
}

/** A DB CACHE of an on-chain source of truth, not the source of truth
 * itself, on_chain_tx_hash is what makes this independently verifiable.
 * Only rows with on_chain_confirmed_at set should ever count toward a
 * supplier's aggregate rating (see design doc Section C.8), a row
 * submitted but not yet confirmed on-chain can't inflate a supplier's
 * number before it's actually verifiable. */
export interface RatingRow {
  id: number;
  order_id: number;
  buyer_id: number;
  supplier_id: number;
  score: 1 | 2 | 3 | 4 | 5;
  comment: string | null;
  on_chain_tx_hash: string | null;
  on_chain_confirmed_at: string | null;
  created_at: string;
}

/** Row shape for the admin dashboard's Users section. */
export interface AdminUserRow {
  id: number;
  email: string;
  username: string | null;
  role: Role;
  created_at: string;
  suspended_at?: string | null;
}

/** A material/product a supplier has listed, uploaded by that supplier
 * (not admin-curated, see migration 0006). buyer-facing search
 * (GET /api/materials) only ever returns listings belonging to a
 * CURRENTLY verified supplier (design doc's live-verification rule,
 * same as GET /api/suppliers) and joins in the supplier fields below;
 * a supplier managing their own listings (GET /api/supplier-listings)
 * gets the bare row without those joins. */
export interface SupplierListingRow {
  id: number;
  supplier_id: number;
  name: string;
  category: string | null;
  description: string | null;
  unit: string | null;
  price_minor: number | null;
  image_url: string | null;
  active: boolean;
  created_at: string;
  supplier_business_name?: string | null;
  supplier_business_location?: string | null;
}

// ============================================================================
// Push notifications (Prompt 2 of the feedback/notifications/security
// pack), see migration 0009_push_notifications.sql and
// lib/notifications/dispatch.ts.
// ============================================================================

export type NotificationCategory = "job_availability" | "escrow_payment" | "audit_status" | "disputes" | "security";

/** Row shape from `notifications`, the in-app notification centre, the
 * part of the system that stays correct even if push never arrives.
 * title/body are already the safe, lock-screen-safe display strings (see
 * lib/notifications/dispatch.ts's payload-security contract), never a
 * raw amount, wallet address, or full name. */
export interface NotificationRow {
  id: number;
  user_id: number;
  category: NotificationCategory;
  event_type: string;
  resource_type: string | null;
  resource_id: number | null;
  title: string;
  body: string;
  deep_link: string | null;
  tag: string | null;
  read_at: string | null;
  pushed_at: string | null;
  created_at: string;
}

export interface NotificationPreferences {
  user_id?: number;
  job_availability: boolean;
  escrow_payment: boolean;
  audit_status: boolean;
  disputes: boolean;
  timezone: string;
  quiet_hours_start_local: number;
  quiet_hours_end_local: number;
}

/** Returned by GET /api/orders/[id] (see lib/jaasAuth.ts) only once
 * JAAS_APP_ID/JAAS_API_KEY_ID/JAAS_PRIVATE_KEY are all set; null falls
 * back to the free meet.jit.si join components/JitsiMeetRoom.tsx
 * already has. Not a DB row, a fresh signed JWT minted per request,
 * never persisted or cached client-side beyond this one order-detail
 * fetch. */
export interface JaasCallConfig {
  domain: string;
  roomName: string;
  jwt: string;
}
