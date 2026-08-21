"use client";

// components/BuyerKycModal.tsx
//
// Shown reactively when fundOrder fails with BuyerKycRequiredError
// (see components/OrderDetailsModal.tsx's onKycRequired callback), not
// on load — same "prompt only when actually needed" posture as
// PushSoftPrompt. Real Yellow Card funding needs this data in its
// `recipient` object (name/phone/dob/idType/idNumber/address), see
// migration 0018_buyer_kyc.sql and lib/yellowCardProvider.ts.
//
// One-time, self-service, no admin review step, POST /api/buyer-kyc
// upserts (a resubmission updates the existing row).
import React, { useState } from "react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import Select from "./ui/Select";
import { Label, Input, ErrorText } from "./ui/Field";

const ID_TYPES: { value: string; label: string }[] = [
  { value: "nin", label: "National ID (NIN)" },
  { value: "passport", label: "International Passport" },
  { value: "drivers_license", label: "Driver's License" },
  { value: "voters_card", label: "Voter's Card" },
];

export interface BuyerKycModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the profile is successfully saved, the caller decides
   * what to do next (OrderDetailsModal re-runs the fund attempt). */
  onSubmitted: () => void;
}

export default function BuyerKycModal({ open, onClose, onSubmitted }: BuyerKycModalProps) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [idType, setIdType] = useState(ID_TYPES[0]!.value);
  const [idNumber, setIdNumber] = useState("");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allFilled = firstName.trim() && lastName.trim() && phone.trim() && dateOfBirth.trim() && idNumber.trim() && address.trim();

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/buyer-kyc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone, dateOfBirth, idType, idNumber, address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save your verification details.");
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save your verification details.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Verify your identity to fund this order" size="md">
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-text-secondary">
          Nigerian payment regulations require this before your first payment. It&rsquo;s a one-time step, you
          won&rsquo;t need to repeat it for future orders.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="kyc-first-name">First name</Label>
            <Input id="kyc-first-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
          </div>
          <div>
            <Label htmlFor="kyc-last-name">Last name</Label>
            <Input id="kyc-last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
          </div>
        </div>
        <div>
          <Label htmlFor="kyc-phone">Phone number</Label>
          <Input id="kyc-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+234..." autoComplete="tel" />
        </div>
        <div>
          <Label htmlFor="kyc-dob">Date of birth</Label>
          <Input id="kyc-dob" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} autoComplete="bday" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="kyc-id-type">ID type</Label>
            <Select id="kyc-id-type" value={idType} onChange={(e) => setIdType(e.target.value)}>
              {ID_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="kyc-id-number">ID number</Label>
            <Input id="kyc-id-number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="kyc-address">Address</Label>
          <Input id="kyc-address" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          <Button loading={submitting} disabled={!allFilled} onClick={handleSubmit}>
            Save and continue
          </Button>
          <Button variant="ghost" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
