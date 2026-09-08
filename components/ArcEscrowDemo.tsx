"use client";

// components/ArcEscrowDemo.tsx
//
// New for ETHOnline 2026 (Continuity track): a minimal UI to demo the
// SourceFiEscrow contract deployed to Arc Testnet at
// 0xd3a97B44C0D6DD006C29f71180938a5A4EE9B13D (see
// github.com/Ubaidreak/sourcefi-arc-escrow for the contract + tests).
// Uses Privy's embedded wallet (already wired app-wide via
// components/Web3Providers.tsx) to sign transactions directly — the SAME
// wallet/auth system the rest of this app already uses, just calling a
// new contract.
import { useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, createPublicClient, custom, http, keccak256, toHex, parseUnits } from "viem";
import {
  SOURCEFI_ESCROW_ADDRESS,
  SOURCEFI_ESCROW_ABI,
  ARC_USDC_ADDRESS,
  USDC_ERC20_ABI,
  USDC_DECIMALS,
} from "@/lib/arcEscrowConfig";

const arcTestnetChain = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
 rpcUrls: { default: { http: ["https://arc-testnet.g.alchemy.com/v2/alch_pC4WV8aQ0ewpqxtA9mnR1"] } },
} as const;

function toOnChainOrderId(demoOrderId: string): `0x${string}` {
  return keccak256(toHex(`demo-order:${demoOrderId}`));
}

export default function ArcEscrowDemo() {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const [orderId, setOrderId] = useState("demo-1");
  const [supplierAddress, setSupplierAddress] = useState("");
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function getClients() {
    const wallet = wallets[0];
    if (!wallet) throw new Error("No wallet connected");
    const provider = await wallet.getEthereumProvider();
    const walletClient = createWalletClient({
      chain: arcTestnetChain,
      transport: custom(provider),
      account: wallet.address as `0x${string}`,
    });
   const publicClient = createPublicClient({
  chain: arcTestnetChain,
  transport: custom(provider),
});
    return { walletClient, publicClient, address: wallet.address as `0x${string}` };
  }

  async function handleFund() {
    setBusy(true);
    setStatus("Approving USDC...");
    try {
      const { walletClient, publicClient, address } = await getClients();
      const onChainId = toOnChainOrderId(orderId);
      const amountBaseUnits = parseUnits(amount, USDC_DECIMALS);

      const approveHash = await walletClient.writeContract({
        address: ARC_USDC_ADDRESS,
        abi: USDC_ERC20_ABI,
        functionName: "approve",
        args: [SOURCEFI_ESCROW_ADDRESS, amountBaseUnits],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStatus("Funding order...");
      const fundHash = await walletClient.writeContract({
        address: SOURCEFI_ESCROW_ADDRESS,
        abi: SOURCEFI_ESCROW_ABI,
        functionName: "fundOrder",
        args: [onChainId, supplierAddress as `0x${string}`, amountBaseUnits],
      });
      await publicClient.waitForTransactionReceipt({ hash: fundHash });
      setStatus(`Funded! Tx: ${fundHash}`);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setStatus("Confirming delivery...");
    try {
      const { walletClient, publicClient } = await getClients();
      const onChainId = toOnChainOrderId(orderId);
      const hash = await walletClient.writeContract({
        address: SOURCEFI_ESCROW_ADDRESS,
        abi: SOURCEFI_ESCROW_ABI,
        functionName: "confirmDelivery",
        args: [onChainId],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`Delivery confirmed, funds released! Tx: ${hash}`);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDispute() {
    setBusy(true);
    setStatus("Raising dispute...");
    try {
      const { walletClient, publicClient } = await getClients();
      const onChainId = toOnChainOrderId(orderId);
      const hash = await walletClient.writeContract({
        address: SOURCEFI_ESCROW_ADDRESS,
        abi: SOURCEFI_ESCROW_ABI,
        functionName: "raiseDispute",
        args: [onChainId, "ipfs://demo-evidence"],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`Dispute raised! Tx: ${hash}`);
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!authenticated) {
    return (
      <div className="p-6">
        <button onClick={login} className="rounded bg-black px-4 py-2 text-white">
          Connect Wallet to Try On-Chain Escrow
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md space-y-4 rounded-xl border p-6">
      <h2 className="text-lg font-semibold">Arc Testnet Escrow Demo</h2>
      <div className="space-y-2">
        <label className="block text-sm">Order ID</label>
        <input value={orderId} onChange={(e) => setOrderId(e.target.value)} className="w-full rounded border p-2" />

        <label className="block text-sm">Supplier Address</label>
        <input
          value={supplierAddress}
          onChange={(e) => setSupplierAddress(e.target.value)}
          placeholder="0x..."
          className="w-full rounded border p-2"
        />

        <label className="block text-sm">Amount (USDC)</label>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded border p-2" />
      </div>

      <div className="flex gap-2">
        <button disabled={busy} onClick={handleFund} className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">
          Fund Order
        </button>
        <button disabled={busy} onClick={handleConfirm} className="rounded bg-green-600 px-3 py-2 text-sm text-white disabled:opacity-50">
          Confirm Delivery
        </button>
        <button disabled={busy} onClick={handleDispute} className="rounded bg-red-600 px-3 py-2 text-sm text-white disabled:opacity-50">
          Raise Dispute
        </button>
      </div>

      {status && <p className="text-sm text-gray-600 break-all">{status}</p>}
    </div>
  );
}