// tests/supplierDocumentTypes.test.ts
//
// isValidSupportingDocumentType is the actual enforcement behind
// app/api/supplier-verification/route.ts's "choose a document type"
// requirement — without it, a client could send any string.
import { describe, it, expect } from "vitest";
import { isValidSupportingDocumentType, SUPPORTING_DOCUMENT_TYPES } from "../lib/supplierDocumentTypes";

describe("isValidSupportingDocumentType", () => {
  it("accepts every value in the real list", () => {
    for (const t of SUPPORTING_DOCUMENT_TYPES) {
      expect(isValidSupportingDocumentType(t.value)).toBe(true);
    }
  });

  it("rejects an arbitrary string", () => {
    expect(isValidSupportingDocumentType("birth_certificate")).toBe(false);
  });

  it("rejects a display label sent instead of its value", () => {
    expect(isValidSupportingDocumentType("CAC certificate")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidSupportingDocumentType(null)).toBe(false);
    expect(isValidSupportingDocumentType(undefined)).toBe(false);
    expect(isValidSupportingDocumentType(42)).toBe(false);
  });
});
