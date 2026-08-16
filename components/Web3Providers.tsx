"use client";

// components/Web3Providers.tsx
import React from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { KeyRound } from "lucide-react";

const PLACEHOLDER_APP_ID = "your_actual_privy_app_id_here";
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

// Define the exact Arc Testnet custom chain parameters for Privy [2.2.7]
const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 18, // Native gas uses 18 decimals per official docs.arc.io
  },
  rpcUrls: {
    default: { http: ["https://arc-testnet.drpc.org", "https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
};

// PrivyProvider throws synchronously, an unhandled runtime error, full red
// Next.js overlay, the instant it's handed anything that isn't a
// well-formed app ID. That's the exact crash this screen replaces: a
// missing/placeholder NEXT_PUBLIC_PRIVY_APP_ID is a setup step, not a bug,
// so it gets a plain explanation instead of a stack trace.
function MissingPrivyConfig() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-8 text-center">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-accent bg-accent-soft">
          <KeyRound size={18} className="text-accent-text" />
        </div>
        <h1 className="mb-2 font-display text-xl font-semibold text-text-primary">Privy isn&rsquo;t configured yet</h1>
        <p className="mb-4 text-sm leading-relaxed text-text-secondary">
          <code className="font-mono text-accent-text">NEXT_PUBLIC_PRIVY_APP_ID</code> is missing or still set to the
          placeholder value in <code className="font-mono text-accent-text">.env.local</code>.
        </p>
        <ol className="mb-1 list-inside list-decimal space-y-1.5 text-left text-sm text-text-secondary">
          <li>
            Get an App ID from{" "}
            <a href="https://dashboard.privy.io" target="_blank" rel="noopener noreferrer" className="text-accent-text underline">
              dashboard.privy.io
            </a>
          </li>
          <li>
            Set <code className="font-mono text-xs text-accent-text">NEXT_PUBLIC_PRIVY_APP_ID</code> in{" "}
            <code className="font-mono text-xs text-accent-text">.env.local</code> (see{" "}
            <code className="font-mono text-xs text-accent-text">.env.local.example</code>)
          </li>
          <li>Restart the dev server</li>
        </ol>
      </div>
    </div>
  );
}

export default function Web3Providers({ children }: { children: React.ReactNode }) {
  if (!PRIVY_APP_ID || PRIVY_APP_ID === PLACEHOLDER_APP_ID) {
    return <MissingPrivyConfig />;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "light",
          accentColor: "#C08A3E",
          logo: "https://avatars.githubusercontent.com/u/17922993",
        },
        loginMethods: ["wallet", "email", "google"],
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "all-users",
          },
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
