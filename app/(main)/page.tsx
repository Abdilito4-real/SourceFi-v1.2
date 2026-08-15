// app/(main)/page.tsx
//
// The gate: sign in, finish onboarding, or (once both are done) redirect
// to /buyer. Neither dashboard route lives here anymore — see
// app/(main)/buyer/page.tsx and app/(main)/sourcer/page.tsx.
import ClientOnlyRootGate from "../../components/ClientOnlyRootGate";

// This route is an entirely client-rendered wallet shell (Web3Providers /
// Privy in the (main) layout, the actual gate loaded with ssr:false — see
// components/ClientOnlyRootGate.tsx). It was never a valid candidate for
// static generation: Privy's provider throws synchronously on an invalid/
// placeholder app ID during Next's build-time prerender pass, which would
// otherwise fail the build regardless of what NEXT_PUBLIC_PRIVY_APP_ID
// happens to be set to at build time. Opting out here keeps `next build`
// succeeding independent of that.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ClientOnlyRootGate />;
}
