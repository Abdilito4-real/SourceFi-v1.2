// lib/constants.ts
//
// Styling tokens (C, inputStyle, primaryBtn, Label, StatusBadge) used to
// live here as inline-style objects, superseded by components/ui/* and
// the Tailwind tokens in app/globals.css. This file is now chain config
// and the on-chain transfer helper only, the material catalog that used
// to live here (materialLibrary) is gone: materials are now
// supplier-uploaded listings (supplier_listings, migration 0006), not an
// admin-curated static array. See app/api/materials/route.ts for the
// buyer-facing search that replaced browsing this array.
export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
};

export const ARC_USDC_ERC20_ADDRESS = "0x3600000000000000000000000000000000000000";

export const ERC20_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
] as const;

/** Deliberately minimal rather than importing Privy's ConnectedWallet type:
 * this function only ever calls these two members, and pinning to Privy's
 * exact type surface would make this file break on every Privy upgrade
 * that renames something we don't even use. */
export interface EthereumWalletLike {
  address: string;
  getEthereumProvider: () => Promise<{
    request: (args: { method: string; params: unknown[] }) => Promise<string>;
  }>;
}

export async function sendUsdcOnArc(
  activeWallet: EthereumWalletLike | null | undefined,
  recipientAddress: string,
  amount: number
): Promise<string> {
  if (!activeWallet) throw new Error("No active connected wallet found.");

  // Get the Ethereum provider from the Privy wallet
  const provider = await activeWallet.getEthereumProvider();

  // Format standard float number to 18-decimal hex value
  const weiValue = BigInt(Math.floor(amount * 1e18));
  const hexValue = "0x" + weiValue.toString(16);

  // Send native transfer tx
  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: activeWallet.address,
        to: recipientAddress,
        value: hexValue,
      },
    ],
  });

  return txHash;
}
