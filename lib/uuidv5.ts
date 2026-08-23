// lib/uuidv5.ts
//
// A deterministic UUID (RFC 4122 version 5: SHA-1 of namespace + name)
// with no new dependency, Node's own `crypto` is enough. Built for one
// purpose: lib/circleEscrowProvider.ts needs a Circle `idempotencyKey`
// that's IDENTICAL across every call for the same order (the original
// attempt and any later retry), so Circle's own dedup treats a resend as
// the same request instead of a second on-chain transfer, see
// docs/payment-integration.md's "Known gaps" section and the plan this
// implements. A random UUID (v4) can't do that, it's different every
// call by definition, that's the entire bug being fixed here.
import { createHash } from "crypto";

function parseUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`Not a valid UUID: ${uuid}`);
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** Deterministic: same (name, namespace) always produces the same UUID.
 * `namespace` must itself be a valid UUID string (any fixed one works,
 * RFC 4122 doesn't require it to mean anything beyond "ours"). */
export function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1")
    .update(Buffer.concat([parseUuid(namespace), Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}

/** Fixed, arbitrary namespace for every idempotency key this app mints.
 * Never changes, changing it would silently break idempotency for any
 * release attempt already in flight against the old key. */
export const SOURCEFI_UUID_NAMESPACE = "b6f9a6b1-3f0a-4c9e-8f34-2e1a2d7c9a10";
