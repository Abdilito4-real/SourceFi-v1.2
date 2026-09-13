// lib/supplierTrust.ts
//
// Tiered trust badges. verification_status alone (verified/not) puts a
// brand-new supplier and one with 200 completed orders and a 4.9 rating
// behind the exact same badge, that's not a meaningful trust signal for
// a buyer choosing who to send money to. This computes a richer tier
// from data this app already reliably tracks: live verification,
// completed (settled) order count, and on-chain-confirmed ratings (a
// rating submitted but not yet independently verifiable can't count,
// same rule app/api/suppliers/route.ts already applies).
//
// Server-only: every caller is an API route, computes the tier once,
// and returns it as a plain string in the JSON response, client
// components never need to import the logic itself, only render the
// label they're given.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SupplierTier = "verified" | "verified_pro" | "elite";

export interface SupplierTrustSignals {
  /** is_supplier_currently_verified()'s live result (lib/supplierVerification.ts),
   * not the cached verification_status column, same source of truth the
   * rest of the app uses to decide whether this supplier can transact
   * at all. */
  currentlyVerified: boolean;
  completedOrderCount: number;
  ratingAverage: number | null;
  ratingCount: number;
}

const VERIFIED_PRO_THRESHOLDS = { minOrders: 10, minRatingCount: 5, minRatingAverage: 4.0 };
const ELITE_THRESHOLDS = { minOrders: 30, minRatingCount: 15, minRatingAverage: 4.7 };

/** null = no badge at all (not currently verified). Checks the highest
 * tier first so a supplier who clears Elite is never reported as only
 * Verified Pro. */
export function computeSupplierTier(signals: SupplierTrustSignals): SupplierTier | null {
  if (!signals.currentlyVerified) return null;

  const { completedOrderCount, ratingAverage, ratingCount } = signals;

  if (
    completedOrderCount >= ELITE_THRESHOLDS.minOrders &&
    ratingCount >= ELITE_THRESHOLDS.minRatingCount &&
    (ratingAverage ?? 0) >= ELITE_THRESHOLDS.minRatingAverage
  ) {
    return "elite";
  }

  if (
    completedOrderCount >= VERIFIED_PRO_THRESHOLDS.minOrders &&
    ratingCount >= VERIFIED_PRO_THRESHOLDS.minRatingCount &&
    (ratingAverage ?? 0) >= VERIFIED_PRO_THRESHOLDS.minRatingAverage
  ) {
    return "verified_pro";
  }

  return "verified";
}

export const SUPPLIER_TIER_LABELS: Record<SupplierTier, string> = {
  verified: "Verified",
  verified_pro: "Verified Pro",
  elite: "Elite",
};

/** Bulk count of settled (successfully completed) orders per supplier,
 * one query for however many ids the caller has, not N+1.
 *
 * Counts settlement_processing alongside settled, not settled alone: by
 * the time an order reaches settlement_processing the release that pays
 * the supplier has already confirmed on-chain (system-transition target
 * right after escrow_released, lib/orderStateMachine.ts), and there's no
 * real settlement integration yet to ever advance it to settled
 * (docs/payment-integration.md). Counting settled only meant every real
 * Circle-paid order was invisible to trust-tier scoring — every supplier
 * permanently stuck at zero completed orders, discovered while
 * live-testing the first real release. Same "already done in every way
 * that matters" call already made for the UI (components/ui/Badge.tsx,
 * components/OrderDetailsModal.tsx). */
export async function getCompletedOrderCounts(supabase: SupabaseClient, supplierIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (supplierIds.length === 0) return counts;

  const { data } = await supabase
    .from("orders")
    .select("supplier_id")
    .in("status", ["settled", "settlement_processing"])
    .in("supplier_id", supplierIds);
  for (const row of data ?? []) {
    const id = row.supplier_id as number;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export interface SupplierRatingAggregate {
  average: number | null;
  count: number;
}

/** Bulk rating aggregate per supplier, on-chain-confirmed ratings only
 * (design doc Section C.8), the same rule app/api/suppliers/route.ts
 * already enforced inline, centralized here so every caller agrees. */
export async function getSupplierRatingAggregates(
  supabase: SupabaseClient,
  supplierIds: number[]
): Promise<Map<number, SupplierRatingAggregate>> {
  const aggregates = new Map<number, SupplierRatingAggregate>();
  if (supplierIds.length === 0) return aggregates;

  const { data } = await supabase
    .from("ratings")
    .select("supplier_id, score")
    .in("supplier_id", supplierIds)
    .not("on_chain_confirmed_at", "is", null);

  const scoresBySupplier = new Map<number, number[]>();
  for (const row of data ?? []) {
    const id = row.supplier_id as number;
    const list = scoresBySupplier.get(id) ?? [];
    list.push(row.score as number);
    scoresBySupplier.set(id, list);
  }
  for (const [id, scores] of scoresBySupplier) {
    aggregates.set(id, { average: scores.reduce((a, b) => a + b, 0) / scores.length, count: scores.length });
  }
  return aggregates;
}

/** Bulk profile-picture lookup, keyed by supplier_profiles.id (not
 * users.id) so callers can map straight off the profile rows they
 * already have, same "one bulk query, not N+1" shape as the two
 * aggregates above. A supplier IS a users row (migration 0004's own
 * header comment) with this profile attached, so "the supplier's
 * photo" is genuinely users.profile_picture_url, not a column of its
 * own on supplier_profiles. */
export async function getSupplierProfilePictures(
  supabase: SupabaseClient,
  suppliers: { id: number; user_id: number }[]
): Promise<Map<number, string | null>> {
  const pictures = new Map<number, string | null>();
  if (suppliers.length === 0) return pictures;

  const userIds = Array.from(new Set(suppliers.map((s) => s.user_id)));
  const { data } = await supabase.from("users").select("id, profile_picture_url").in("id", userIds);
  const byUserId = new Map<number, string | null>((data ?? []).map((u) => [u.id as number, (u.profile_picture_url as string | null) ?? null]));

  for (const s of suppliers) {
    pictures.set(s.id, byUserId.get(s.user_id) ?? null);
  }
  return pictures;
}
