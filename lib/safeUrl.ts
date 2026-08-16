// lib/safeUrl.ts
//
// Prompt 4, M6, every "evidence"/"photo"/"receipt" field in this app
// (delivery proof photos, receipts, dispute evidence, listing images) is
// a plain user-supplied URL string, stored as text and later rendered as
// an <a href> or <img src>. Nothing here fetches these server-side (no
// SSRF surface, see the audit), but an unvalidated href is still a
// stored-XSS-adjacent risk: a `javascript:` or `data:` URI clicked from
// this app's own UI executes in this app's own origin. Restricting to
// http(s) closes that off at the point of storage, not just display.
const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

export function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return SAFE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/** Filters a list down to only safe http(s) URLs, silently drops the
 * rest rather than rejecting the whole request over one bad entry, same
 * posture as this app's existing `.filter((u) => typeof u === "string")`
 * calls it replaces. */
export function filterSafeHttpUrls(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && isSafeHttpUrl(v));
}
