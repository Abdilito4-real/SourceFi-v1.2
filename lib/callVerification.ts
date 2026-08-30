// lib/callVerification.ts
//
// Pure interval math backing the verification call's duration gate (see
// migration 0025_call_segments.sql and lib/orderService.ts's
// recordVerificationCallProgress). No I/O, no Supabase — same "one file,
// one concern" shape as lib/yellowCardAuth.ts/lib/supplierTrust.ts, kept
// separate so the two-pointer interval-intersection logic can be unit
// tested directly without a database.
//
// The core idea: verification_call_seconds should only ever credit time
// BOTH parties independently reported being on the call at the same
// moment, not either party's report taken alone. computeOverlapSeconds
// is what turns two independent, possibly-overlapping-with-themselves
// segment lists into that single corroborated number.

export interface CallInterval {
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number;
}

/** Merges same-party intervals that overlap or touch into the minimal
 * disjoint set, sorted by start. Needed before the cross-party overlap
 * step below: without this, a party's own retried/duplicated/overlapping
 * segment reports (a flaky-network resend is a real scenario here, see
 * CLAUDE.md's "network drops mid-task" constraint) would let that SAME
 * party's own double-reported time inflate the overlap computation,
 * defeating the whole point of requiring the other party's independent
 * corroboration. */
export function mergeIntervals(intervals: CallInterval[]): CallInterval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.startedAt - b.startedAt);
  // noUncheckedIndexedAccess: sorted[0] is provably defined (length
  // checked above), but TS can't see that through an array index alone.
  const merged: CallInterval[] = [{ ...(sorted[0] as CallInterval) }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1] as CallInterval;
    const cur = sorted[i] as CallInterval;
    if (cur.startedAt <= last.endedAt) {
      last.endedAt = Math.max(last.endedAt, cur.endedAt);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Total seconds where a buyer interval and a supplier interval were
 * BOTH simultaneously "in the call" — the corroborated call time this
 * app actually gates approveOrder on, computed from each party's own
 * independently reported segments rather than trusting either report
 * alone. Standard sorted two-pointer interval-intersection: each side is
 * merged into disjoint intervals first (see mergeIntervals), then walked
 * once each, O(n + m), no re-sorting needed since merge already sorted
 * both. */
export function computeOverlapSeconds(buyerIntervals: CallInterval[], supplierIntervals: CallInterval[]): number {
  const buyer = mergeIntervals(buyerIntervals);
  const supplier = mergeIntervals(supplierIntervals);

  let totalMs = 0;
  let i = 0;
  let j = 0;
  while (i < buyer.length && j < supplier.length) {
    // noUncheckedIndexedAccess: both indices are bounded by the while
    // condition above, provably in range.
    const b = buyer[i] as CallInterval;
    const s = supplier[j] as CallInterval;
    const overlapStart = Math.max(b.startedAt, s.startedAt);
    const overlapEnd = Math.min(b.endedAt, s.endedAt);
    if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    // Advance whichever interval ends first, the classic merge-two-
    // sorted-lists step: it can't overlap anything further on the other
    // side once it's been passed.
    if (b.endedAt < s.endedAt) i++;
    else j++;
  }
  return Math.floor(totalMs / 1000);
}
