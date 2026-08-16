"use client";

// components/SupplierVerificationForm.tsx
//
// Extracted from SupplierDashboard.tsx so it can be reused from
// BuyerDashboard.tsx too — a REJECTED first-time applicant is still
// role='buyer' (only approval flips the role) and, until this component
// was shared, had no way to reapply at all: the re-apply form only ever
// lived inside /supplier, which a plain buyer can't reach. Same POST
// /api/supplier-verification either way — first application, expired-
// supplier re-verification, and a rejected applicant trying again all go
// through this one form.
import React, { useState } from "react";
import Button from "./ui/Button";
import { Label, Input, Textarea } from "./ui/Field";
import { useToast } from "./ui/Toast";

export default function SupplierVerificationForm({ onSubmitted }: { onSubmitted: () => void }) {
  const { notify } = useToast();
  const [businessName, setBusinessName] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");
  const [whatTheySell, setWhatTheySell] = useState("");
  const [cacRegistrationNumber, setCacRegistrationNumber] = useState("");
  const [taxIdNumber, setTaxIdNumber] = useState("");
  const [supportingDocumentUrl, setSupportingDocumentUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = businessName.trim() && businessLocation.trim() && whatTheySell.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/supplier-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName, businessLocation, whatTheySell, cacRegistrationNumber, taxIdNumber, supportingDocumentUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit application.");
      notify("success", "Verification application submitted — an admin will review it.");
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
      <div className="flex gap-3">
        <div className="flex-1">
          <Label htmlFor="verif-cac">CAC registration number (optional)</Label>
          <Input id="verif-cac" value={cacRegistrationNumber} onChange={(e) => setCacRegistrationNumber(e.target.value)} />
        </div>
        <div className="flex-1">
          <Label htmlFor="verif-tax">Tax ID number (optional)</Label>
          <Input id="verif-tax" value={taxIdNumber} onChange={(e) => setTaxIdNumber(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="verif-location">Business location</Label>
        <Input id="verif-location" value={businessLocation} onChange={(e) => setBusinessLocation(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="verif-doc">Supporting document (optional)</Label>
        <Input
          id="verif-doc"
          placeholder="Link to your CAC certificate, utility bill, etc."
          value={supportingDocumentUrl}
          onChange={(e) => setSupportingDocumentUrl(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="verif-sells">What do you produce or sell?</Label>
        <Textarea id="verif-sells" value={whatTheySell} onChange={(e) => setWhatTheySell(e.target.value)} required />
      </div>
      <Button type="submit" loading={submitting} disabled={!valid || submitting}>
        Submit for verification
      </Button>
    </form>
  );
}
