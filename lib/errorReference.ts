// lib/errorReference.ts
//
// Feedback-layer rule (see docs/feedback-notifications-prompts.md Prompt 1):
// never surface stack traces, SQL, internal IDs, or provider error codes to
// the user. This is the one place that turns an internal error into (a) a
// full detail logged server-side, and (b) a short code the user can quote
// to support instead. Follows the existing console.error convention used
// elsewhere in lib/ (circleEscrowProvider.ts, orderService.ts) rather than
// introducing a new logging dependency.
export function logInternalError(scope: string, err: unknown): string {
  const ref = `ERR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  console.error(`[${ref}] ${scope}:`, err instanceof Error ? err.message : err);
  return ref;
}
