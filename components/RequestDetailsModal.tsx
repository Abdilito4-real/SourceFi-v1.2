// components/RequestDetailsModal.tsx
import React, { useState } from "react";
import { X, Camera, ShieldAlert, CheckCircle2, Star, ShieldCheck } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";
import { Label, Input, Textarea } from "./ui/Field";
import JitsiMeetRoom from "./JitsiMeetRoom";
import { formatMoney } from "../lib/money";
import type { AppUser, Role, RequestStatus, SourcingRequest, ToastType } from "../lib/types";

export interface RequestDetailsModalProps {
  selected: SourcingRequest;
  role: Role;
  user: AppUser;
  auditNotes: string;
  setAuditNotes: (notes: string) => void;
  verificationOtp: string;
  setVerificationOtp: (otp: string) => void;
  onClose: () => void;
  // "invite_sent" isn't a real request status — it's a sentinel App.js's
  // handleAdvance special-cases to update evidence.invite_sent instead of
  // the row's actual status column.
  onAdvance: (req: SourcingRequest, nextStatus: RequestStatus | "invite_sent") => void | Promise<void>;
  onSubmitAudit: (dbId: number, notes: string, otp: string, image: string | null, businessId: string) => void;
  isSubmitting: boolean;
  showNotification: (type: ToastType, message: string) => void;
  setRequests: React.Dispatch<React.SetStateAction<SourcingRequest[]>>;
  requests: SourcingRequest[];
  /** Whether the signed-in account can actually perform `role`'s write
   * actions here — distinct from `role` itself, which only picks which
   * half of this modal's UI to render. An admin viewing the sourcer
   * dashboard renders the sourcer half (role="sourcer") but every one of
   * those actions is requireRole(["sourcer"])-checked server-side and
   * would 403; this disables them proactively instead of letting someone
   * fill out a whole claim/audit form only to hit "Not authorized for
   * this action" on submit. */
  canTransact: boolean;
}

export default function RequestDetailsModal({
  selected,
  role,
  user,
  auditNotes,
  setAuditNotes,
  verificationOtp,
  setVerificationOtp,
  onClose,
  onAdvance,
  onSubmitAudit,
  isSubmitting,
  showNotification,
  setRequests,
  requests,
  canTransact,
}: RequestDetailsModalProps) {
  const [localFeeInput, setLocalFeeInput] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [buyerJoined, setBuyerJoined] = useState(false);
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [businessIdInput, setBusinessIdInput] = useState("");

  const partnerEmail = selected.sourcer;
  const partnerRequests = requests ? requests.filter((r) => r.sourcer === partnerEmail) : [];
  const completedJobs = partnerRequests.filter((r) => r.status === "escrow_released").length;
  const activeJobs = partnerRequests.filter((r) => r.status === "claimed" || r.status === "escrow" || r.status === "verified").length;
  const totalJobs = completedJobs + activeJobs;

  const completionRate = totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 100;
  const totalVolumeMinor = partnerRequests
    .filter((r) => r.status === "escrow_released")
    .reduce((acc, r) => acc + (r.sourcingFeeMinor || 0), 0);
  const reviewsCount = completedJobs;

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setUploadedImage(reader.result as string);
        showNotification("success", "On-site material photo successfully attached.");
      };
      reader.readAsDataURL(file);
    }
  };

  const handleLocalClaim = async () => {
    if (!canTransact) {
      showNotification("error", "Claiming a mandate needs the sourcer role on this account.");
      return;
    }
    if (!localFeeInput || isNaN(Number(localFeeInput)) || parseFloat(localFeeInput) <= 0) {
      showNotification("error", "Please enter a valid numeric sourcing fee.");
      return;
    }
    setClaiming(true);
    try {
      const res = await fetch("/api/escrow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "claimRequest",
          requestId: selected.dbId,
          sourcingFee: parseFloat(localFeeInput),
        }),
      });
      if (res.ok) {
        const feeMinor = Math.round(parseFloat(localFeeInput) * 100);
        setRequests((rs) =>
          rs.map((r) => (r.dbId === selected.dbId ? { ...r, status: "claimed", sourcer: user.identity, sourcingFeeMinor: feeMinor } : r))
        );
        onClose();
        showNotification("success", "Sourcing request claimed successfully!");
      } else {
        const data = await res.json();
        showNotification("error", data.error || "Failed to claim request.");
      }
    } catch (err) {
      showNotification("error", "Sourcing claim failed to submit.");
    } finally {
      setClaiming(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="lg" className="max-h-[90vh] overflow-y-auto">
      <div className="mb-5 flex items-center justify-between">
        <span className="text-xs text-text-tertiary">Request {selected.id}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="text-text-tertiary hover:text-text-primary">
          <X size={18} />
        </button>
      </div>

      <h3 className="mb-2 font-display text-2xl italic text-text-primary">{selected.title}</h3>
      <StatusBadge status={selected.status} />

      <div className="mt-4.5 flex flex-wrap gap-4">
        <div className="min-w-[100px] flex-1">
          <Label>Delivery location</Label>
          <div className="text-base font-semibold text-text-primary">{selected.location}</div>
        </div>
        <div className="min-w-[100px] flex-1">
          <Label>Project budget</Label>
          <div className="text-base font-semibold text-text-primary">{formatMoney(selected.budgetMinor, selected.budgetCurrency)}</div>
        </div>
        <div className="min-w-[100px] flex-1">
          <Label>Sourcing fee</Label>
          <div className="text-base font-bold text-accent-text">{formatMoney(selected.sourcingFeeMinor)}</div>
        </div>
      </div>

      {selected.status === "escrow" && (
        <div className="mt-5.5">
          {role === "sourcer" && (
            <div>
              <Label>Live Supply Verification Feed</Label>
              <JitsiMeetRoom requestCode={selected.id} />
            </div>
          )}
          {role === "buyer" && (
            <div>
              {selected.inviteSent ? (
                !buyerJoined ? (
                  <div className="rounded-lg border border-border bg-surface-sunken p-5 text-center">
                    <p className="mb-3 text-sm text-text-secondary">
                      Sourcing partner is active on-site and has invited you to join the live verification stream!
                    </p>
                    <Button onClick={() => setBuyerJoined(true)} className="mx-auto max-w-[200px]">
                      📞 Join Video Walkspace
                    </Button>
                  </div>
                ) : (
                  <div>
                    <Label>Live Supply Verification Feed</Label>
                    <JitsiMeetRoom requestCode={selected.id} />
                  </div>
                )
              ) : (
                <p className="rounded-lg bg-surface-sunken p-3 text-center text-sm leading-relaxed text-text-secondary">
                  Awaiting sourcing partner @{selected.sourcer} to begin on-site verification and invite you to the call.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {(selected.status === "verified" || selected.status === "escrow_released") && (
        <div className="mt-5.5">
          <Label>Supply Verification Feed</Label>
          <JitsiMeetRoom requestCode={selected.id} />
        </div>
      )}

      {(selected.status === "claimed" || selected.status === "escrow" || selected.status === "verified" || selected.status === "escrow_released") && selected.sourcer && (
        <div className="mt-5 rounded-lg border border-border bg-surface-sunken p-4">
          <div className="mb-3 flex items-center gap-1.5">
            <Star size={14} className="fill-accent text-accent" />
            <span className="text-xs font-bold text-accent-text">Sourcing partner track record</span>
          </div>
          <div className="grid grid-cols-2 gap-3.5 text-sm text-text-secondary">
            <div>
              <strong>Completion rate:</strong> <span className="font-bold text-accent-text">{completionRate}%</span>
            </div>
            <div>
              <strong>Jobs completed:</strong> <span className="font-bold text-accent-text">{reviewsCount}</span>
            </div>
            <div className="col-span-2">
              <strong>Transaction volume:</strong> <span className="font-bold text-accent-text">{formatMoney(totalVolumeMinor)}</span>
            </div>
          </div>
          <div className="my-2.5 h-px bg-border" />
          <div className="flex items-center gap-1.5 text-[10.5px] text-text-tertiary">
            <ShieldCheck size={12} className="text-accent-text" />
            <span>Verified and recorded securely to the blockchain registry on contract closure</span>
          </div>
        </div>
      )}

      {role === "buyer" && (
        <div className="mt-6 border-t border-border pt-4.5">
          {selected.status === "open" && (
            <p className="text-sm leading-relaxed text-text-secondary">
              Your procurement request is broadcasted to our verified networks. Waiting for an accredited sourcing
              partner to claim.
            </p>
          )}

          {selected.status === "claimed" && (
            <div>
              <p className="mb-4 text-base leading-relaxed text-text-secondary">
                Sourcing partner @{selected.sourcer || "assigned partner"} has claimed this request. Deposit the
                sourcing fee into secure escrow to start the physical verification.
              </p>
              <span title={canTransact ? undefined : "Funding escrow needs the buyer role on this account."}>
                <Button
                  fullWidth
                  loading={isSubmitting}
                  disabled={isSubmitting || !canTransact}
                  onClick={() => onAdvance(selected, "escrow")}
                >
                  {isSubmitting ? "Authorizing…" : `⚡ Authorize Escrow Deposit (${formatMoney(selected.sourcingFeeMinor)})`}
                </Button>
              </span>
            </div>
          )}

          {selected.status === "escrow" && (
            <div className="flex flex-col gap-3.5">
              <p className="text-base leading-relaxed text-text-secondary">
                Sourcing Capital Secured: Funds are locked in the secure digital vault. Sourcing partner is currently
                conducting physical inspections.
              </p>
              <div className="flex gap-2.5 rounded-lg border-l-[3.5px] border-danger bg-danger-soft px-3.5 py-3">
                <ShieldAlert size={18} className="mt-0.5 shrink-0 text-danger-text" />
                <div className="text-sm leading-relaxed text-text-secondary">
                  <strong>Dispute & Reversal Policy:</strong> If the partner fails to complete the physical
                  verification or provide audit evidence, funds can be reversed to your account by our administrative
                  support team.
                </div>
              </div>
            </div>
          )}

          {selected.status === "verified" && (
            <div>
              <div className="mb-4 rounded-lg border border-border bg-accent-soft p-4.5">
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-accent-text">Verified sourcing report</div>
                <div className="flex flex-col gap-2 text-sm text-text-secondary">
                  <div>
                    <strong>Handshake code:</strong>{" "}
                    <span className="font-semibold text-accent-text">Confirmed</span>
                  </div>
                  <div>
                    <strong>Supplier registration:</strong>{" "}
                    <span>{selected.auditBusinessId || `REG-${selected.id}`}</span>
                  </div>
                  <div>
                    <strong>On-site notes:</strong> {selected.auditNotes || "On-site specifications verified and approved."}
                  </div>
                  <div className="mt-2 h-40 overflow-hidden rounded-lg border border-border">
                    <img
                      src={selected.auditImage || "https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=350&h=120&q=80"}
                      alt="On-Site Material Verification Proof"
                      className="h-full w-full object-cover"
                    />
                  </div>
                </div>
              </div>

              <p className="mb-4 text-base leading-relaxed text-text-secondary">
                Verify that all materials match your expectations. Click below to approve the verification.
              </p>
              <span title={canTransact ? undefined : "Releasing escrow needs the buyer role on this account."}>
                <Button
                  fullWidth
                  loading={isSubmitting}
                  disabled={isSubmitting || !canTransact}
                  onClick={() => onAdvance(selected, "escrow_released")}
                >
                  {isSubmitting ? "Releasing…" : "✓ Approve & Accept Material Verification"}
                </Button>
              </span>
            </div>
          )}

          {selected.status === "escrow_released" && (
            <p className="flex items-center gap-1.5 text-sm font-semibold text-success-text">
              <CheckCircle2 size={14} /> Escrow successfully released. Sourcing contract complete.
            </p>
          )}
        </div>
      )}

      {role === "sourcer" && (
        <div className="mt-6 border-t border-border pt-4.5">
          {selected.status === "open" && (
            <div className="flex flex-col gap-3">
              <p className="text-base leading-relaxed text-text-secondary">
                Claim this mandate. State your required sourcing fee in USD to secure your contract.
              </p>
              <Label htmlFor="local-fee">Sourcing Fee (USD)</Label>
              <Input
                id="local-fee"
                placeholder="e.g. 50"
                value={localFeeInput}
                onChange={(e) => setLocalFeeInput(e.target.value)}
                disabled={claiming || !canTransact}
              />
              <span title={canTransact ? undefined : "Claiming a mandate needs the sourcer role on this account."}>
                <Button
                  onClick={handleLocalClaim}
                  loading={claiming}
                  disabled={claiming || !canTransact || !localFeeInput.trim() || isNaN(Number(localFeeInput))}
                >
                  {claiming ? "Claiming…" : "Claim Sourcing Mandate"}
                </Button>
              </span>
            </div>
          )}

          {selected.status === "claimed" && (
            <p className="text-base leading-relaxed text-text-secondary">
              Sourcing mandate successfully claimed. Waiting for Buyer to deposit your sourcing fee into escrow
              before beginning inspections.
            </p>
          )}

          {selected.status === "escrow" && (
            <div>
              <p className="mb-4 text-base leading-relaxed text-text-secondary">
                Escrow funded. Site inspection is now active. Once you have verified the material specifications,
                enter notes and the 4-digit code.
              </p>

              {!selected.inviteSent && (
                <span
                  className="mb-5 block"
                  title={canTransact ? undefined : "Sending the invite needs the sourcer role on this account."}
                >
                  <Button
                    fullWidth
                    loading={isSubmitting}
                    disabled={isSubmitting || !canTransact}
                    onClick={() => onAdvance(selected, "invite_sent")}
                  >
                    {isSubmitting ? "Sending invite…" : "✉️ Invite Buyer to Video Inspection"}
                  </Button>
                </span>
              )}

              <div className="flex flex-col gap-3.5">
                <div>
                  <Label htmlFor="audit-notes">Audit Notes / Verification Notes</Label>
                  <Textarea
                    id="audit-notes"
                    placeholder="e.g. Verified BubbleDeck HDPE Slabs are in stock at warehouse..."
                    value={auditNotes}
                    onChange={(e) => setAuditNotes(e.target.value)}
                  />
                </div>

                <div>
                  <Label>On-Site Material Photo Evidence</Label>
                  {!uploadedImage ? (
                    <div className="flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-accent bg-accent-soft px-3.5 py-2.5 font-body text-sm font-semibold text-accent-text">
                        <Camera size={15} /> 📸 Capture / Upload Photo
                        <input type="file" accept="image/*" capture="environment" onChange={handleImageChange} className="hidden" />
                      </label>
                      <span className="text-sm text-text-secondary">No photo attached yet.</span>
                    </div>
                  ) : (
                    <div className="relative h-[100px] w-[140px] overflow-hidden rounded-lg border border-border">
                      <img src={uploadedImage} alt="Captured Material Evidence" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setUploadedImage(null)}
                        aria-label="Remove photo"
                        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <Label htmlFor="business-id">Corporate Business ID / Licence Number</Label>
                  <Input
                    id="business-id"
                    placeholder="e.g., SRC-KANO-4004"
                    value={businessIdInput}
                    onChange={(e) => setBusinessIdInput(e.target.value)}
                  />
                </div>

                <div>
                  <Label htmlFor="verification-otp">4-Digit Code (Standard: 1234)</Label>
                  <Input
                    id="verification-otp"
                    placeholder="e.g. 1234"
                    value={verificationOtp}
                    onChange={(e) => setVerificationOtp(e.target.value)}
                  />
                </div>
                <span title={canTransact ? undefined : "Submitting an audit needs the sourcer role on this account."}>
                  <Button
                    onClick={() => onSubmitAudit(selected.dbId, auditNotes, verificationOtp, uploadedImage, businessIdInput)}
                    disabled={
                      isSubmitting ||
                      !canTransact ||
                      !(auditNotes.trim().length > 0 && verificationOtp.trim().length > 0 && businessIdInput.trim().length > 0)
                    }
                    loading={isSubmitting}
                  >
                    Submit Verified Audit
                  </Button>
                </span>
              </div>
            </div>
          )}

          {selected.status === "verified" && (
            <p className="text-sm font-semibold text-success-text">✓ Audit submitted. Awaiting Buyer to release funds from escrow.</p>
          )}

          {selected.status === "escrow_released" && (
            <p className="flex items-center gap-1.5 text-sm font-semibold text-success-text">
              <CheckCircle2 size={14} /> Escrow released. Your commission has been disbursed.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
