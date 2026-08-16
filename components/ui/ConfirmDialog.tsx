"use client";

// components/ui/ConfirmDialog.tsx
//
// The reusable shape for "any irreversible or financial action needs
// explicit confirmation showing exact amount, recipient, and what happens
// next" (feedback-layer Prompt 1). Built on Modal with dismissible={false}
//, never closable by backdrop click or Escape, only by the Cancel/Confirm
// buttons this component renders itself, per that same rule.
//
// Optional requireTypedConfirmation: pass the exact string the user must
// type back (e.g. a formatted amount) to enable Confirm, "above a
// configurable threshold, require typed confirmation rather than a single
// tap." Below that threshold, don't pass it and this is a plain two-button
// confirm.
import React, { useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import Modal from "./Modal";
import Button from "./Button";
import { Label, Input, HelperText } from "./Field";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Amount, recipient, what happens next, spelled out, not summarized. */
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** True while the confirmed action is in flight, disables both buttons
   * and shows the spinner on Confirm so a second tap can't double-submit. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Exact string the user must type to enable Confirm. Use for amounts at
   * or above whatever threshold this call site defines. */
  requireTypedConfirmation?: string;
  typedConfirmationLabel?: string;
  /** Extra condition (beyond requireTypedConfirmation) that must be true
   * to enable Confirm, e.g. a mandatory reason field inside `body` that
   * hasn't been filled in yet (Prompt 3's admin suspend/resolve-dispute
   * flows). The caller owns the field and its own validation; this is
   * just where that result gets ANDed into whether Confirm is clickable. */
  confirmDisabled?: boolean;
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  onConfirm,
  onCancel,
  requireTypedConfirmation,
  typedConfirmationLabel = "Type the amount above to confirm",
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();

  // Fresh input every time the dialog opens, otherwise a leftover typed
  // value from a previous confirmation could carry over and silently
  // pre-satisfy the check.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);

  const typedOk = !requireTypedConfirmation || typed.trim() === requireTypedConfirmation.trim();

  return (
    <Modal open={open} onClose={onCancel} dismissible={false} size="sm" title={title}>
      <div className="flex flex-col gap-4">
        {tone === "danger" && (
          <div className="flex items-start gap-2 text-danger-text">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div className="text-sm leading-relaxed text-text-primary">{body}</div>
          </div>
        )}
        {tone !== "danger" && <div className="text-sm leading-relaxed text-text-primary">{body}</div>}

        {requireTypedConfirmation && (
          <div>
            <Label htmlFor={inputId}>{typedConfirmationLabel}</Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireTypedConfirmation}
              disabled={loading}
              autoComplete="off"
              inputMode="text"
            />
            <HelperText>Must match exactly: {requireTypedConfirmation}</HelperText>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={loading}
            disabled={!typedOk || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button variant="ghost" disabled={loading} onClick={onCancel}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
