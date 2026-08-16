import { cookieStorage, createStorage } from "wagmi";
import { injected } from "wagmi/connectors";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";

export const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;

if (!projectId) {
  throw new Error("NEXT_PUBLIC_REOWN_PROJECT_ID is not defined in .env.local");
}

// Arc Testnet, not in AppKit's built-in network list, so defined manually.
// Values confirmed against official docs.arc.io.
export const arcTestnet = defineChain({
  id: 5042002,
  caipNetworkId: "eip155:5042002",
  chainNamespace: "eip155",
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const networks = [arcTestnet];

// Deliberately using ONLY injected(), covers MetaMask, Rabby, Rainbow, OKX
// and Coinbase's browser extension, since they all implement the same
// standard EIP-1193 window.ethereum interface. walletConnect() was removed:
// it exists for QR-code/mobile wallet scanning, which isn't needed for
// browser-extension testing, and removing it eliminates its entire separate
// dependency chain rather than chasing missing pieces one at a time.
export const wagmiAdapter = new WagmiAdapter({
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  projectId,
  networks,
  connectors: [injected()],
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
