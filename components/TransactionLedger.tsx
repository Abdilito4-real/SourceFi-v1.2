// components/TransactionLedger.tsx
import React from "react";
import { CheckCircle2, History } from "lucide-react";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import EmptyState from "./ui/EmptyState";
import { formatMoney } from "../lib/money";
import type { Role, SourcingRequest } from "../lib/types";

export interface TransactionLedgerProps {
  role: Role;
  requests: SourcingRequest[];
  onClearPayment: (dbId: number) => void;
  isSubmitting: boolean;
  /** Whether the signed-in account can actually clear a payout here — an
   * admin can view this ledger (role="sourcer" is about which half of the
   * UI renders, same as RequestDetailsModal), but clearSourcingPayment is
   * requireRole(["sourcer"])-checked server-side and would 403 for them. */
  canTransact: boolean;
}

export default function TransactionLedger({ role, requests, onClearPayment, isSubmitting, canTransact }: TransactionLedgerProps) {
  const txHistory = requests.filter((r) => r.status === "escrow_released");

  if (txHistory.length === 0) {
    return <EmptyState icon={History} title="No transactions recorded in this session." />;
  }

  return (
    <div className="flex flex-col gap-3.5">
      {txHistory.map((tx) => {
        const depositHash = tx.depositTxHash || "rec_demo_hash_dep";
        const releaseHash = tx.releaseTxHash || "rec_demo_hash_rel";
        const clearedBySourcer = tx.clearedBySourcer;

        return (
          <div key={tx.id} className="flex flex-col gap-3 rounded-lg border border-border bg-surface-elevated p-5">
            <div className="flex flex-wrap items-start justify-between gap-2.5">
              <div>
                <span className="font-mono text-[10.5px] text-accent-text">
                  {tx.id} · {tx.category}
                </span>
                <h4 className="mt-1 font-display text-lg font-semibold text-text-primary">{tx.title}</h4>
              </div>
              <Badge tone="success">Completed</Badge>
            </div>

            <div className="h-px bg-border" />

            {role === "buyer" && (
              <div className="flex flex-col gap-1.5 text-sm text-text-secondary">
                <div className="flex justify-between">
                  <span>Funds Deposited to Escrow:</span>
                  <span className="font-semibold text-text-primary">{formatMoney(tx.sourcingFeeMinor + tx.platformFeeMinor)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Deposit Verification Signature:</span>
                  <span className="font-mono text-xs text-accent-text underline" title={depositHash}>
                    {depositHash.substring(0, 16)}...
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Commission Disbursed to Partner:</span>
                  <span className="font-semibold text-text-primary">{formatMoney(tx.sourcingFeeMinor)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Disbursement Verification Signature:</span>
                  <span className="font-mono text-xs text-accent-text underline" title={releaseHash}>
                    {releaseHash.substring(0, 16)}...
                  </span>
                </div>
              </div>
            )}

            {role === "sourcer" && (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-col gap-1.5 text-sm text-text-secondary">
                  <div className="flex justify-between">
                    <span>Earned Commission:</span>
                    <span className="font-semibold text-text-primary">{formatMoney(tx.sourcingFeeMinor)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Disbursement Verification Signature:</span>
                    <span className="font-mono text-xs text-accent-text underline" title={releaseHash}>
                      {releaseHash.substring(0, 16)}...
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Escrow Release Date:</span>
                    <span className="text-text-primary">{tx.releasedAt ? new Date(tx.releasedAt).toLocaleString() : "just now"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Sourcing Clearance Status:</span>
                    <span className={`font-mono text-xs font-bold ${clearedBySourcer ? "text-success-text" : "text-danger-text"}`}>
                      {clearedBySourcer ? "✓ CLEARED & AUDITED" : "⚠️ UNCLEARED PAYMENT"}
                    </span>
                  </div>
                </div>

                {!clearedBySourcer ? (
                  <div className="mt-1 flex flex-col gap-2.5 rounded-lg border-l-[3px] border-accent bg-accent-soft px-3.5 py-3">
                    <div className="text-sm leading-relaxed text-text-secondary">
                      This payout has been disbursed. You can physically clear and acknowledge receipt to move it
                      cleanly into your audited income log.
                    </div>
                    <span
                      className="self-start"
                      title={canTransact ? undefined : "Clearing a payout needs the sourcer role on this account."}
                    >
                      <Button
                        size="sm"
                        loading={isSubmitting}
                        onClick={() => onClearPayment(tx.dbId)}
                        disabled={isSubmitting || !canTransact}
                      >
                        {isSubmitting ? "Clearing…" : "⚡ Acknowledge & Clear Payout"}
                      </Button>
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 rounded-md bg-success-soft px-3 py-2 text-xs font-semibold text-success-text">
                    <CheckCircle2 size={13} /> Payment cleared & audited locally into registry log on{" "}
                    {tx.clearedAt ? new Date(tx.clearedAt).toLocaleString() : "just now"}.
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
