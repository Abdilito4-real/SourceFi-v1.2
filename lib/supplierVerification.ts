// lib/supplierVerification.ts
//
// docs/marketplace-payments-design.md Section D.2: whether a supplier can
// receive a newly funded order is a LIVE computation (90 days OR 20
// orders, whichever comes first), never just trusting the cached
// supplier_profiles.verification_status column — that column can be
// stale between the actual expiry moment and whenever a scheduled job
// next sweeps it. Same principle as lib/authz.ts never trusting a
// client-supplied role: a value that CAN go stale must be re-checked at
// the moment it's actually used for an authorization decision, not
// assumed current because it was true recently.
import type { SupabaseClient } from "@supabase/supabase-js";

const VERIFICATION_PERIOD_DAYS = 90;
const VERIFICATION_ORDER_LIMIT = 20;

/** The single source of truth for "is this supplier allowed to receive a
 * funded order right now" — delegates to the Postgres function of the
 * same name (migration 0004_marketplace_pivot.sql), so the DB and the
 * app can never disagree about what "currently verified" means. Call
 * this at order-creation AND again at order-funding time (design doc
 * Section D.2) — state can change in the gap between the two. */
export async function isSupplierCurrentlyVerified(supabase: SupabaseClient, supplierId: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_supplier_currently_verified", { p_supplier_id: supplierId });
  if (error) throw error;
  return data === true;
}

/** verification_expires_at to set at approval time — 90 days from now
 * (or from an explicitly-passed approval timestamp, for tests/backdating
 * scenarios). Exported as a pure function specifically so it's testable
 * without a database. */
export function computeVerificationExpiry(approvedAt: Date = new Date()): Date {
  const expiry = new Date(approvedAt);
  expiry.setDate(expiry.getDate() + VERIFICATION_PERIOD_DAYS);
  return expiry;
}

export const SUPPLIER_VERIFICATION_ORDER_LIMIT = VERIFICATION_ORDER_LIMIT;
