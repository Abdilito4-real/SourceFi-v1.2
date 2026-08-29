// lib/supplierDocumentTypes.ts
//
// The allowed "what kind of document is this" choices for a supplier's
// verification supporting document (components/OnboardingScreen.tsx,
// components/SupplierVerificationForm.tsx) — a business-proof document
// (CAC certificate, utility bill) OR a personal ID (passport, national
// ID, driver's license), chosen BEFORE the upload so an admin reviewing
// supplier_verification_applications knows what they're looking at
// without having to guess from the photo itself. No "server-only" here
// on purpose: both the client forms and app/api/supplier-verification/
// route.ts (the actual enforcement) import this same list, so they can
// never drift apart.
export interface SupportingDocumentType {
  value: string;
  label: string;
}

export const SUPPORTING_DOCUMENT_TYPES: SupportingDocumentType[] = [
  { value: "cac_certificate", label: "CAC certificate" },
  { value: "utility_bill", label: "Utility bill" },
  { value: "passport", label: "International passport" },
  { value: "national_id", label: "National ID (NIN)" },
  { value: "drivers_license", label: "Driver's license" },
];

const VALID_VALUES = new Set(SUPPORTING_DOCUMENT_TYPES.map((t) => t.value));

export function isValidSupportingDocumentType(value: unknown): value is string {
  return typeof value === "string" && VALID_VALUES.has(value);
}
