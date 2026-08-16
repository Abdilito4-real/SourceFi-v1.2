import "server-only";
import { createHash, timingSafeEqual } from "crypto";

// lib/safeCompare.ts
//
// Prompt 4, M7, "Constant-time comparison for all secrets, tokens, codes
// and signatures. Never ===." Node's crypto.timingSafeEqual does the
// actual constant-time comparison, but it throws on a length mismatch
// which is itself a length-based timing/behavioral signal if two
// differently-sized secrets are compared directly. Hashing both sides to
// a fixed-length digest first sidesteps that: every comparison is now the
// same length regardless of the inputs, so there's nothing to throw on
// and nothing about input length leaks either.
export function safeCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
