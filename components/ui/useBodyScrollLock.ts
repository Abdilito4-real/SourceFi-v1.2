"use client";

import { useEffect } from "react";

// components/ui/useBodyScrollLock.ts
//
// Shared by Modal.tsx and DashboardShell.tsx's mobile nav drawer: while
// either is open, touch-dragging the fixed backdrop/drawer on mobile
// would otherwise scroll the page sitting behind it (nothing was ever
// marking body as non-scrollable — confirmed absent everywhere in this
// codebase before this file). A single module-level, reference-counted
// lock, not a per-component boolean: ConfirmDialog is itself a Modal and
// is routinely opened from WITHIN another already-open Modal (e.g. a
// cancel-order confirmation inside OrderDetailsModal) — if each consumer
// tracked its own "is anything locked" state independently, the inner
// dialog closing would remove the lock while the outer modal is still
// open. Counting how many active callers want the lock, and only
// releasing it when that count reaches zero, is what makes stacking safe.
let lockCount = 0;

function lock() {
  lockCount++;
  if (lockCount === 1) document.body.classList.add("scroll-locked");
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) document.body.classList.remove("scroll-locked");
}

/** Locks body scroll for as long as `active` is true. Safe to call from
 * multiple components simultaneously (see module comment above) and
 * always releases its own share of the lock on unmount, even if `active`
 * was never flipped back to false first (e.g. the component unmounts
 * while still "open"). */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lock();
    return unlock;
  }, [active]);
}
