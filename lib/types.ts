// lib/types.ts
//
// Stage 5: these types now describe the real schema in
// supabase/migrations/0000_fresh_project_full_schema.sql (or
// 0001_stage4_auth.sql + 0002_stage5_data_layer.sql for the original
// project), not a reverse-engineered guess from a JSONB blob anymore.
// Money is integer minor units everywhere — see lib/money.ts for the one
// place that converts to/from a display number.

// "admin" added in Stage 4 — granted only via direct DB write (bootstrap)
// or PATCH /api/admin/users/[id]/role by an existing admin. There is no
// self-service path to it anywhere in the client.
export type Role = "buyer" | "sourcer" | "admin";

export type RequestStatus =
  | "open"
  | "claimed"
  | "escrow"
  | "verified"
  | "escrow_released"
  | "disputed"
  | "cancelled"
  | "expired";

export type Currency = "USD" | "NGN";

export type ToastType = "success" | "error" | "info";

/** Row shape as it comes back from Supabase (`sourcing_requests`), plus
 * buyer_email/sourcer_email — NOT real columns, joined in server-side (see
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

/** Client-side shape after App.tsx's `.map()` over the API response.
 * `dbId` (the numeric id) is kept alongside `id` (the human-readable
 * request_code) because every write endpoint addresses a request by
 * numeric id, never by its display code. */
export interface SourcingRequest {
  id: string; // request_code, e.g. "REQ-482913"
  dbId: number;
  title: string;
  buyer: string; // buyer_email — display and ownership-comparison only
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
   * first successful session establishment for that DID — see
   * app/api/auth/session/route.ts. Null for pre-Stage-4 rows until their
   * next login. */
  privy_user_id: string | null;
}

/** Client-side authenticated-user shape held in App.tsx state — distinct
 * from UserRow (the DB row) and from Privy's own user object. `role` here
 * is a display hint synced from GET /api/auth/me, not a trust boundary —
 * every server-side action re-derives role from the DB via the session
 * cookie regardless of what this says. */
export interface AppUser {
  method: "email" | "web3";
  identity: string;
  username: string | null;
  walletAddress: string | null;
  role: Role;
}

/** Payload of our own first-party session cookie (see lib/session.ts) —
 * distinct from Privy's access token, which we only ever see once, at
 * session-establishment time, to prove identity. */
export interface SessionClaims {
  privyUserId: string;
  userRowId: number;
  email: string;
}

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** A request to become a sourcer — never a role grant by itself. Only
 * PATCH /api/admin/sourcer-applications/[id]'s approve action (admin-only)
 * ever changes users.role; see lib/authz.ts and CLAUDE.md's rule that a
 * user cannot self-assign the sourcer role. applicant_email/username are
 * joined in server-side for the admin dashboard, same pattern as
 * SourcingRequestRow's buyer_email. */
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

/** Row shape for the admin dashboard's Users section. */
export interface AdminUserRow {
  id: number;
  email: string;
  username: string | null;
  role: Role;
  created_at: string;
}

export interface Material {
  id: string;
  name: string;
  tag: string;
  savings: string;
  hook: string;
  explainer: string;
  whyRare: string;
  metrics: string;
  videoUrl: string;
}
