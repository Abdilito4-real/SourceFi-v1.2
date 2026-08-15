// components/FundingModal.tsx
import React, { useState } from "react";
import { Copy, ArrowRight } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";

export interface FundingModalProps {
  onClose: () => void;
  accountAddress: string | null;
}

export default function FundingModal({ onClose, accountAddress }: FundingModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!accountAddress) return;
    navigator.clipboard.writeText(accountAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal open onClose={onClose} title="Deposit Sourcing Capital" size="md">
      <p className="mb-4 text-base leading-relaxed text-text-secondary">
        A secure, permanent account has been dynamically created for you and is linked directly to your authenticated
        email profile. You can fund this address using the official <strong>Circle Testnet Faucet</strong>.
      </p>

      <div className="mb-5 rounded-lg border border-border bg-surface-sunken p-4">
        <div className="mb-1.5 font-mono text-[10px] text-accent-text">YOUR SECURED ACCOUNT ADDRESS</div>
        <div className="flex items-center gap-2">
          <span className="flex-1 break-all rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs text-text-primary">
            {accountAddress || "Retrieving on-chain address..."}
          </span>
          {accountAddress && (
            <Button size="sm" onClick={handleCopy} className="shrink-0">
              <Copy size={13} /> {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </div>
      </div>

      <a
        href="https://faucet.circle.com"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 font-body text-md font-bold text-accent-contrast no-underline transition-[filter] duration-base ease-base hover:brightness-95"
      >
        🌐 Request Funds from Circle Faucet <ArrowRight size={15} />
      </a>
      <span className="mt-2.5 block text-center text-xs text-text-tertiary">
        This will open the official testnet faucet inside a new browser tab.
      </span>
    </Modal>
  );
}
