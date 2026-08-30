"use client";

// components/ReceiptModal.tsx
//
// Fetches and displays one receipt (lib/receiptService.ts, via
// app/api/orders/[id]/receipt or app/api/wallet/topups/[reference]/receipt)
// for a "View receipt" action wired in contextually after a successful
// transaction — WalletTopupModal's top-up confirming, OrderDetailsModal's
// fund-order action succeeding, and an order reaching `settled`. Not a
// receipts history hub (no list view exists yet, deliberately out of
// scope for now) — this always shows exactly one receipt, for the
// endpoint it was opened with.
//
// `type="button"` on the download link (styled as a Button but a plain
// <a>, not a fetch+blob dance) — a same-origin navigation carries the
// session cookie automatically, and Content-Disposition: inline lets the
// browser's own PDF viewer handle it, no client-side blob/download
// plumbing needed here.
import React, { useEffect, useState } from "react";
import { Download } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import { formatMoney } from "../lib/money";
import type { OrderReceipt, TopupReceipt } from "../lib/receiptService";

export interface ReceiptModalProps {
  open: boolean;
  onClose: () => void;
  /** The JSON GET endpoint, e.g. "/api/orders/7/receipt?leg=funding" or
   * "/api/wallet/topups/yc-receive-1/receipt" — the same endpoint with
   * "&format=pdf"/"?format=pdf" appended is the PDF download. */
  endpoint: string;
}

function Row({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: "success" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-text-secondary">{label}</span>
      <span
        className={`text-right text-sm ${bold ? "font-display text-lg font-semibold" : ""} ${
          tone === "success" ? "text-success-text" : "text-text-primary"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export default function ReceiptModal({ open, onClose, endpoint }: ReceiptModalProps) {
  const [receipt, setReceipt] = useState<OrderReceipt | TopupReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReceipt(null);
    setError(null);
    setLoading(true);
    fetch(endpoint)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Couldn't load the receipt.");
        setReceipt(data.receipt);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load the receipt."))
      .finally(() => setLoading(false));
  }, [open, endpoint]);

  const pdfHref = endpoint + (endpoint.includes("?") ? "&" : "?") + "format=pdf";

  return (
    <Modal open={open} onClose={onClose} title="Receipt" size="sm">
      {loading && <p className="py-6 text-center text-sm text-text-tertiary">Loading…</p>}
      {error && <p className="py-6 text-center text-sm text-danger-text">{error}</p>}

      {receipt && receipt.kind === "topup" && (
        <div className="flex flex-col gap-1">
          <Row label="Type" value="Wallet top-up" />
          <Row label="Provider" value="Yellow Card" />
          <Row label="Confirmed" value={new Date(receipt.confirmedAt).toLocaleString()} />
          <div className="my-2 border-t border-border" />
          <Row label="Amount credited" value={formatMoney(receipt.amountMinor, "NGN")} bold tone="success" />
        </div>
      )}

      {receipt && receipt.kind !== "topup" && (
        <div className="flex flex-col gap-1">
          <Row label="Order" value={`${receipt.orderCode}`} />
          <Row label="Material" value={receipt.title} />
          {receipt.supplierBusinessName && <Row label="Supplier" value={receipt.supplierBusinessName} />}
          <Row label="Confirmed" value={new Date(receipt.confirmedAt).toLocaleString()} />
          <div className="my-2 border-t border-border" />
          <Row label="Gross amount" value={formatMoney(receipt.grossAmountMinor, "NGN")} />
          <Row label="Platform fee" value={`- ${formatMoney(receipt.platformFeeMinor, "NGN")}`} />
          <div className="my-2 border-t border-border" />
          <Row
            label={receipt.kind === "funding" ? "Net into escrow" : "Net paid to supplier"}
            value={formatMoney(receipt.netAmountMinor, "NGN")}
            bold
            tone="success"
          />
        </div>
      )}

      {receipt && (
        <Button
          type="button"
          fullWidth
          className="mt-5"
          onClick={() => window.open(pdfHref, "_blank", "noopener,noreferrer")}
        >
          <Download size={15} aria-hidden="true" />
          Download PDF
        </Button>
      )}
    </Modal>
  );
}
