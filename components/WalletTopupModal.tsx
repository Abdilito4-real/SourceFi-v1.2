"use client";

// components/WalletTopupModal.tsx
//
// Buyer tops up their platform wallet balance (migration 0020_buyer_wallet.sql).
// Real Yellow Card bank-transfer top-up once YELLOW_CARD_API_KEY/
// YELLOW_CARD_SECRET_KEY are set (lib/paymentProvider.ts's
// getWalletTopupProvider()), simulated otherwise — see
// lib/yellowCardWalletTopupProvider.ts's module comment for exactly why
// it's one-way (no withdrawal). A BuyerKycModal detour if this is the
// buyer's first top-up (same "prompt only when actually needed" trigger
// BuyerKycModal always used, just moved here from gating fundOrder
// directly).
import React, { useEffect, useRef, useState } from "react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import ErrorPanel from "./ui/ErrorPanel";
import { Label, Input, ErrorText, HelperText } from "./ui/Field";
import BuyerKycModal from "./BuyerKycModal";
import { formatMoney, toMinorUnits, MIN_WALLET_TOPUP_MINOR } from "../lib/money";

type PaymentInstructions = { bankName: string; accountNumber: string; accountName: string };

// Real money on a real bank transfer's own timeline, not a stub's
// instant fake confirmation — this only matters once paymentInstructions
// come back, i.e. once a real provider is actually configured.
const BALANCE_POLL_MS = 4000;

export interface WalletTopupModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once a top-up is actually CONFIRMED and the wallet balance
   * has genuinely increased (the caller refreshes its own balance
   * display / shows a success toast). For the simulated path this fires
   * moments after submit; for a real Yellow Card top-up it only fires
   * once this modal's own poll below sees the balance move, which can
   * take real minutes. Carries the top-up's own reference (from
   * POST /api/wallet/topup's response) so the caller can offer a
   * receipt — GET /api/wallet/topups/{reference}/receipt. */
  onSubmitted: (reference: string) => void;
  /** Set when this modal was opened because a fund attempt came back
   * short (InsufficientWalletBalanceError), prefills the amount with
   * exactly the shortfall rather than leaving the buyer to guess. */
  prefillShortfallMinor?: number | null;
}

export default function WalletTopupModal({ open, onClose, onSubmitted, prefillShortfallMinor }: WalletTopupModalProps) {
  const [amount, setAmount] = useState(prefillShortfallMinor ? (prefillShortfallMinor / 100).toString() : "");
  const [submitting, setSubmitting] = useState(false);
  // ErrorPanel, not a bare string: same "a toast/inline message is never
  // the only confirmation of a financial failure" standard the rest of
  // the payment flow holds itself to (OrderDetailsModal's
  // runFinancialAction) — this is the one wallet-adjacent surface that
  // didn't meet it before. referenceCode comes through automatically on
  // an unexpected server error now that app/api/wallet/topup/route.ts
  // routes its fallback through dbErrorResponse.
  const [error, setError] = useState<{ title: string; referenceCode?: string } | null>(null);
  const [showKycModal, setShowKycModal] = useState(false);
  const [paymentInstructions, setPaymentInstructions] = useState<PaymentInstructions | null>(null);
  const [confirming, setConfirming] = useState(false);
  const startingBalanceRef = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const referenceRef = useRef<string | null>(null);

  const amountMinor = amount.trim() !== "" && !isNaN(Number(amount)) ? toMinorUnits(amount) : 0;
  const validAmount = amountMinor >= MIN_WALLET_TOPUP_MINOR;

  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => clearPoll, []); // stop polling if the modal unmounts mid-wait

  const startPolling = async () => {
    setConfirming(true);
    try {
      const res = await fetch("/api/wallet");
      const data = await res.json();
      startingBalanceRef.current = typeof data.balanceMinor === "number" ? data.balanceMinor : 0;
    } catch {
      startingBalanceRef.current = null; // couldn't establish a baseline, still poll, just can't compare
    }

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/wallet");
        const data = await res.json();
        const balanceMinor = typeof data.balanceMinor === "number" ? data.balanceMinor : null;
        if (balanceMinor !== null && startingBalanceRef.current !== null && balanceMinor > startingBalanceRef.current) {
          clearPoll();
          setConfirming(false);
          onSubmitted(referenceRef.current!);
        }
      } catch {
        // A dropped poll tick isn't a failure, the next one just tries again.
      }
    }, BALANCE_POLL_MS);
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/wallet/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // A fresh key per explicit submit press — a re-click after a
        // failure is a new logical attempt, not a transparent retry of
        // the same one (the button's disabled while submitting, so a
        // same-press double-fire can't happen); a real provider's own
        // dedup keys off this, see lib/walletService.ts's
        // WalletTopupProvider doc comment for why.
        body: JSON.stringify({ amountMinor, idempotencyKey: crypto.randomUUID() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.kycRequired) {
          setShowKycModal(true);
          return;
        }
        // Captured directly from the response, not via a thrown Error,
        // so referenceCode (present on an unexpected server error since
        // app/api/wallet/topup/route.ts routes its fallback through
        // dbErrorResponse) survives into the ErrorPanel below.
        setError({ title: data.error || "Failed to start top-up.", referenceCode: data.referenceCode });
        return;
      }

      referenceRef.current = data.reference;

      if (data.paymentInstructions) {
        // Real Yellow Card top-up: not done the moment the API responds,
        // the buyer still has to actually send the transfer and Yellow
        // Card still has to confirm it. Show the account to pay into and
        // start watching the real balance instead of calling onSubmitted
        // immediately.
        setPaymentInstructions(data.paymentInstructions);
        void startPolling();
      } else {
        // Simulated path (Yellow Card not configured): unchanged from
        // before, the stub confirms moments after this returns.
        onSubmitted(data.reference);
      }
    } catch {
      // fetch itself threw, network drop, not a server response at all —
      // same distinction OrderDetailsModal's runFinancialAction draws.
      setError({ title: "Couldn't reach the server. Check your connection and try again." });
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    clearPoll();
    setPaymentInstructions(null);
    setConfirming(false);
    onClose();
  };

  return (
    <>
      <Modal open={open && !showKycModal} onClose={handleClose} title="Top up your wallet" size="sm">
        {paymentInstructions ? (
          <div className="flex flex-col gap-3.5">
            <div className="rounded-md border border-accent-strong bg-surface px-3 py-2.5 text-sm text-text-primary">
              <div className="font-semibold">Pay {formatMoney(amountMinor, "NGN")} into this account to complete your top-up:</div>
              <div className="mt-1.5 font-mono">
                {paymentInstructions.bankName} · {paymentInstructions.accountNumber}
                <br />
                {paymentInstructions.accountName}
              </div>
            </div>
            <p className="text-xs leading-relaxed text-text-secondary">
              Your balance updates automatically once the transfer is confirmed, this page checks every few seconds. Bank
              transfers can take a few minutes, feel free to close this and check back later, nothing else needs doing on
              your end.
            </p>
            {confirming && <p className="text-xs font-semibold text-accent-text">Watching for your transfer…</p>}
            <Button variant="ghost" onClick={handleClose} fullWidth>
              Close
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            <p className="text-sm leading-relaxed text-text-secondary">
              Fund your SourceFi balance once, then fund orders from it instantly, no bank transfer per order.
            </p>
            <div>
              <Label htmlFor="wallet-topup-amount">Amount</Label>
              <Input
                id="wallet-topup-amount"
                prefix="₦"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="50,000"
                autoFocus
              />
              {amount.trim() !== "" && !validAmount ? (
                <ErrorText>Must be at least {formatMoney(MIN_WALLET_TOPUP_MINOR, "NGN")}.</ErrorText>
              ) : (
                <HelperText>
                  If Yellow Card isn&rsquo;t configured yet, this top-up is simulated and your balance updates in a moment, no
                  real bank transfer happens.
                </HelperText>
              )}
            </div>
            {error && (
              <ErrorPanel
                title={error.title}
                fundPosition="No money has left your account."
                referenceCode={error.referenceCode}
                retrying={submitting}
                onRetry={submit}
                onDismiss={() => setError(null)}
              />
            )}
            <Button loading={submitting} disabled={submitting || !validAmount} onClick={submit} fullWidth>
              Top up {amountMinor > 0 ? formatMoney(amountMinor, "NGN") : ""}
            </Button>
          </div>
        )}
      </Modal>
      <BuyerKycModal
        open={showKycModal}
        onClose={() => setShowKycModal(false)}
        onSubmitted={() => {
          setShowKycModal(false);
          void submit();
        }}
      />
    </>
  );
}
