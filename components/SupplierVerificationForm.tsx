"use client";

// components/SupplierVerificationForm.tsx
//
// Extracted from SupplierDashboard.tsx so it can be reused from
// BuyerDashboard.tsx too, a REJECTED first-time applicant is still
// role='buyer' (only approval flips the role) and, until this component
// was shared, had no way to reapply at all: the re-apply form only ever
// lived inside /supplier, which a plain buyer can't reach. Same POST
// /api/supplier-verification either way, first application, expired-
// supplier re-verification, and a rejected applicant trying again all go
// through this one form.
import React, { useState } from "react";
import Button from "./ui/Button";
import { Label, Input, Textarea, HelperText } from "./ui/Field";
import ImageUploadField from "./ui/ImageUploadField";
import Select from "./ui/Select";
import { SUPPORTING_DOCUMENT_TYPES } from "../lib/supplierDocumentTypes";
import { useToast } from "./ui/Toast";

export default function SupplierVerificationForm({ onSubmitted }: { onSubmitted: () => void }) {
  const { notify } = useToast();
  const [businessName, setBusinessName] = useState("");
  const [phone, setPhone] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");
  const [whatTheySell, setWhatTheySell] = useState("");
  const [cacRegistrationNumber, setCacRegistrationNumber] = useState("");
  const [taxIdNumber, setTaxIdNumber] = useState("");
  const [supportingDocumentType, setSupportingDocumentType] = useState(SUPPORTING_DOCUMENT_TYPES[0]!.value);
  const [supportingDocumentUrl, setSupportingDocumentUrl] = useState("");
  const [payoutBankName, setPayoutBankName] = useState("");
  const [payoutAccountNumber, setPayoutAccountNumber] = useState("");
  const [payoutAccountName, setPayoutAccountName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [docTouched, setDocTouched] = useState(false);

  const valid =
    businessName.trim() &&
    phone.trim() &&
    businessLocation.trim() &&
    whatTheySell.trim() &&
    cacRegistrationNumber.trim() &&
    taxIdNumber.trim() &&
    supportingDocumentType.trim() &&
    supportingDocumentUrl.trim() &&
    payoutBankName.trim() &&
    payoutAccountNumber.trim() &&
    payoutAccountName.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/supplier-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          phone,
          businessLocation,
          whatTheySell,
          cacRegistrationNumber,
          taxIdNumber,
          supportingDocumentType,
          supportingDocumentUrl,
          payoutBankName,
          payoutAccountNumber,
          payoutAccountName,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit application.");
      notify("success", "Verification application submitted. An admin will review it.");
      onSubmitted();
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to submit application.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5">
      <div>
        <Label htmlFor="verif-business-name">Business name</Label>
        <Input id="verif-business-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="verif-phone">Business phone number</Label>
        <Input id="verif-phone" type="tel" placeholder="e.g. 0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <HelperText>How an admin reaches you if your application needs a follow-up.</HelperText>
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <Label htmlFor="verif-cac">CAC registration number</Label>
          <Input id="verif-cac" value={cacRegistrationNumber} onChange={(e) => setCacRegistrationNumber(e.target.value)} required />
        </div>
        <div className="flex-1">
          <Label htmlFor="verif-tax">Tax ID number</Label>
          <Input id="verif-tax" value={taxIdNumber} onChange={(e) => setTaxIdNumber(e.target.value)} required />
        </div>
      </div>
      <div>
        <Label htmlFor="verif-location">Business location</Label>
        <Input id="verif-location" value={businessLocation} onChange={(e) => setBusinessLocation(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="verif-doc-type">Document type</Label>
        <Select id="verif-doc-type" value={supportingDocumentType} onChange={(e) => setSupportingDocumentType(e.target.value)} required>
          {SUPPORTING_DOCUMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <ImageUploadField
        label="Supporting document"
        folder="verification_documents"
        required
        invalid={docTouched && !supportingDocumentUrl}
        value={supportingDocumentUrl || null}
        onChange={(url) => {
          setDocTouched(true);
          setSupportingDocumentUrl(url || "");
        }}
        helperText="A clear photo matching the document type chosen above — required."
      />
      <div>
        <Label htmlFor="verif-sells">What do you produce or sell?</Label>
        <Textarea id="verif-sells" value={whatTheySell} onChange={(e) => setWhatTheySell(e.target.value)} required />
      </div>
      <div className="border-t border-border pt-3.5">
        <p className="mb-2.5 text-sm font-medium text-text-primary">Payout details</p>
        <p className="mb-3 text-xs leading-relaxed text-text-secondary">
          This is the bank account you&rsquo;ll be paid into. Required — an application can&rsquo;t be reviewed without it.
        </p>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="verif-bank-name">Bank name</Label>
            <Input id="verif-bank-name" value={payoutBankName} onChange={(e) => setPayoutBankName(e.target.value)} placeholder="e.g. GTBank" required />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="verif-account-number">Account number</Label>
              <Input id="verif-account-number" value={payoutAccountNumber} onChange={(e) => setPayoutAccountNumber(e.target.value)} required />
            </div>
            <div className="flex-1">
              <Label htmlFor="verif-account-name">Account holder name</Label>
              <Input id="verif-account-name" value={payoutAccountName} onChange={(e) => setPayoutAccountName(e.target.value)} required />
            </div>
          </div>
        </div>
      </div>
      <Button type="submit" loading={submitting} disabled={!valid || submitting}>
        Submit for verification
      </Button>
    </form>
  );
}
