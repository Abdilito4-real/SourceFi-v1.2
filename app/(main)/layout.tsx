// app/(main)/layout.tsx
//
// Web3Providers (Privy + wagmi) is scoped to the actual buyer/sourcer app
// only, not the root layout — routes outside this group (e.g.
// /design-system) don't pay for the wallet/auth bundle and don't need a
// real NEXT_PUBLIC_PRIVY_APP_ID to render.
//
// SessionProvider is mounted here, above every route in the group (/,
// /buyer, /sourcer), so client-side navigation between the two dashboards
// reuses the same session/requests state instead of re-running the Privy
// handshake and refetching everything on every route change.
import Web3Providers from "../../components/Web3Providers";
import SessionProvider from "../../components/SessionProvider";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <Web3Providers>
      <SessionProvider>{children}</SessionProvider>
    </Web3Providers>
  );
}
