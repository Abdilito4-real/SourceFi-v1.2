"use client";

// components/ArcEscrowDemo.tsx
//
// New for ETHOnline 2026 (Continuity track): a minimal UI to demo the
// SourceFiEscrow contract deployed to Arc Testnet at
// 0xd3a97B44C0D6DD006C29f71180938a5A4EE9B13D (see
// github.com/Ubaidreak/sourcefi-arc-escrow for the contract + tests).
// Uses Privy's embedded wallet (already wired app-wide via
// components/Web3Providers.tsx) to sign transactions directly -- the SAME
// wallet/auth system the rest of this app already uses, just calling a
// new contract.
import { useState, useEffect } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, createPublicClient, custom, keccak256, toHex, parseUnits } from "viem";
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
  const { authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [orderId, setOrderId] = useState("demo-1");
  const [supplierAddress, setSupplierAddress] = useState("");
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const walletAddress = wallets[0]?.address;

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

  async function refreshBalance() {
    if (!wallets[0]) return;
    try {
      const { publicClient, address } = await getClients();
      const balance = await publicClient.readContract({
        address: ARC_USDC_ADDRESS,
        abi: USDC_ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      });
      setUsdcBalance((Number(balance) / 10 ** USDC_DECIMALS).toFixed(4));
    } catch (err) {
      console.error("Balance fetch failed:", err);
      setUsdcBalance(null);
    }
  }

  function copyAddress() {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  useEffect(() => {
    if (authenticated && wallets[0]) {
      refreshBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, wallets.length]);

  async function handleFund() {
    setBusy(true);
    setStatus("Checking balance...");
    try {
      const { walletClient, publicClient, address } = await getClients();
      const onChainId = toOnChainOrderId(orderId);
      const amountBaseUnits = parseUnits(amount, USDC_DECIMALS);

      const currentBalance = await publicClient.readContract({
        address: ARC_USDC_ADDRESS,
        abi: USDC_ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      });

      if (currentBalance < amountBaseUnits) {
        const have = (Number(currentBalance) / 10 ** USDC_DECIMALS).toFixed(4);
        setStatus(`Insufficient balance: you have ${have} USDC but tried to fund ${amount} USDC. Get testnet USDC from faucet.circle.com.`);
        setBusy(false);
        return;
      }

      setStatus("Approving USDC...");
      const approveHash = await walletClient.writeContract({
        address: ARC_USDC_ADDRESS,
        abi: USDC_ERC20_ABI,
        functionName: "approve",
        args: [SOURCEFI_ESCROW_ADDRESS, amountBaseUnits],
        gas: BigInt(100000),
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStatus("Funding order...");
      const fundHash = await walletClient.writeContract({
        address: SOURCEFI_ESCROW_ADDRESS,
        abi: SOURCEFI_ESCROW_ABI,
        functionName: "fundOrder",
        args: [onChainId, supplierAddress as `0x${string}`, amountBaseUnits],
          gas: BigInt(300000),
      });
      await publicClient.waitForTransactionReceipt({ hash: fundHash });
      setStatus(`Funded! Tx: ${fundHash}`);
      refreshBalance();
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("intrinsic gas too low") || message.includes("insufficient funds")) {
        setStatus("Not enough native USDC for gas. Get testnet USDC from faucet.circle.com for this wallet.");
      } else {
        setStatus(`Error: ${message}`);
      }
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
      gas: BigInt(150000),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`Delivery confirmed, funds released! Tx: ${hash}`);
      refreshBalance();
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
                gas: BigInt(150000),
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

      <div className="rounded-lg bg-gray-50 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-gray-500">Your wallet:</span>
          <div className="flex items-center gap-2">
            <button onClick={copyAddress} className="font-mono text-xs text-blue-600 hover:underline">
              {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)} {copied ? "copied!" : "(copy)"}
            </button>
            <button onClick={logout} className="text-xs text-red-500 hover:underline">
              disconnect
            </button>
          </div>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-gray-500">USDC balance:</span>
          <span className="font-mono">
            {usdcBalance ?? "--"}{" "}
            <button onClick={refreshBalance} className="ml-1 text-xs text-blue-600 hover:underline">
              refresh
            </button>
          </span>
        </div>
      </div>

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