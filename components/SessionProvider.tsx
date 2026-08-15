"use client";

// components/SessionProvider.tsx
//
// The session-bootstrap logic (Privy token -> our own cookie), wallet
// balance polling, idle-timeout sign-out, and the shared requests list
// used to all live inline in the old single-page App.tsx. Now that the
// buyer and sourcer dashboards are separate routes, this is the one place
// that state lives — mounted once in app/(main)/layout.tsx, above every
// route in the group, so navigating between /buyer and /sourcer doesn't
// re-run the Privy handshake or refetch everything from scratch.
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { createPublicClient, http, formatUnits } from "viem";
import { arcTestnet } from "../lib/constants";
import { useToast } from "./ui/Toast";
import type { AppUser, Role, SourcingRequest, SourcingRequestRow } from "../lib/types";

/** Maps a raw API row onto the client's display shape. Money stays in
 * minor units end to end — components format it with lib/money's
 * formatMoney at the point of display, never before. */
function toSourcingRequest(r: SourcingRequestRow): SourcingRequest {
  return {
    id: r.request_code,
    dbId: r.id,
    title: r.title,
    buyer: r.buyer_email || "",
    budgetMinor: r.budget_minor,
    budgetCurrency: r.budget_currency,
    location: r.location || "Not specified",
    posted: new Date(r.created_at).toLocaleDateString(),
    status: r.status,
    category: r.category || "",
    sourcer: r.sourcer_email,
    sourcingFeeMinor: r.sourcing_fee_minor || 0,
    platformFeeMinor: r.platform_fee_minor || 0,
    inviteSent: Boolean(r.invite_sent_at),
    clearedBySourcer: r.cleared_by_sourcer,
    clearedAt: r.cleared_at,
    flagged: r.flagged,
    auditNotes: r.audit_notes,
    auditImage: r.audit_image,
    auditBusinessId: r.audit_business_id,
    depositTxHash: r.deposit_tx_hash,
    releaseTxHash: r.release_tx_hash,
    releasedAt: r.released_at,
  };
}

interface SessionContextValue {
  privyReady: boolean;
  authenticated: boolean;
  checkingSession: boolean;
  user: AppUser | null;
  needsOnboarding: boolean;
  /** True while /api/auth/me is being patched with the chosen username —
   * distinct from checkingSession so the onboarding form's own submit
   * button can show a loading state without re-triggering the full-page
   * spinner. */
  completingOnboarding: boolean;
  completeOnboarding: (username: string) => Promise<{ success: boolean; error?: string }>;
  canBeSourcer: boolean;
  requests: SourcingRequest[];
  setRequests: React.Dispatch<React.SetStateAction<SourcingRequest[]>>;
  loadingRequests: boolean;
  refetchRequests: () => Promise<void>;
  walletBalance: string;
  web3ConnectedAddress: string | null;
  wallets: ConnectedWallet[];
  login: () => void;
  signingOut: boolean;
  handleSignOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

export default function SessionProvider({ children }: { children: React.ReactNode }) {
  const { login, logout, ready, authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { notify } = useToast();

  const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");
  const externalWallet = wallets.find((w) => w.walletClientType !== "privy");
  const web3ConnectedAddress: string | null = embeddedWallet?.address || externalWallet?.address || null;

  const [user, setUser] = useState<AppUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [completingOnboarding, setCompletingOnboarding] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [requests, setRequests] = useState<SourcingRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [walletBalance, setWalletBalance] = useState("0.00");

  // Stage 4 session bootstrap: exchange a verified Privy access token for
  // our own httpOnly session cookie (POST /api/auth/session), once per
  // Privy auth state change — not per render, and not stored anywhere
  // ourselves. See lib/session.ts for why this app runs its own session
  // layer instead of trusting Privy's client-side auth state directly for
  // API authorization.
  useEffect(() => {
    if (!ready) return;
    if (!authenticated) {
      setUser(null);
      setCheckingSession(false);
      return;
    }

    // Bug this fixes: once the initial (unauthenticated) pass already ran,
    // checkingSession was sitting at false. When `authenticated` then flips
    // true, this effect re-runs to do the real work below — but without
    // this line, RootGate never knew a second, slower phase had started: it
    // kept rendering SignInScreen's "Continue" button, clickable, for the
    // entire multi-second POST /api/auth/session. A user (or an impatient
    // re-click) firing login() a second time mid-flight is exactly what
    // produced Privy's "already logged in" warning.
    setCheckingSession(true);

    let cancelled = false;
    (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) throw new Error("No access token available.");

        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to establish session.");
        }

        const updatedUser: AppUser = {
          method: data.user.walletAddress && data.user.email?.startsWith("web3_") ? "web3" : "email",
          identity: data.user.email,
          username: data.user.username,
          walletAddress: data.user.walletAddress,
          role: data.user.role,
        };
        setUser(updatedUser);
        setNeedsOnboarding(!data.user.username);
      } catch (err) {
        if (!cancelled) {
          console.error("Session establishment failed:", err);
          setUser(null);
          notify("error", err instanceof Error ? err.message : "Couldn't sign you in. Please try again.");
        }
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  useEffect(() => {
    if (!web3ConnectedAddress) return;
    let active = true;
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http("https://rpc.testnet.arc.network") });
    const fetchBalance = async () => {
      try {
        const rawBalance = await publicClient.getBalance({ address: web3ConnectedAddress as `0x${string}` });
        if (active) {
          setWalletBalance(parseFloat(formatUnits(rawBalance, 18)).toFixed(2));
        }
      } catch (err) {
        console.warn("Failed to fetch balance:", err);
      }
    };
    fetchBalance();
    const interval = setInterval(fetchBalance, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [web3ConnectedAddress]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
      await logout();
      setUser(null);
      setRequests([]);
      setNeedsOnboarding(false);
    } finally {
      setSigningOut(false);
    }
  }, [logout]);

  useEffect(() => {
    if (!authenticated) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        handleSignOut();
        notify("error", "Session locked automatically due to inactivity.");
      }, 30 * 60 * 1000);
    };
    const events = ["mousedown", "mousemove", "keypress", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, resetTimer));
    resetTimer();
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      events.forEach((e) => window.removeEventListener(e, resetTimer));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  const refetchRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      const res = await fetch("/api/requests");
      const data: { requests?: SourcingRequestRow[]; error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load sourcing requests.");
      setRequests((data.requests || []).map(toSourcingRequest));
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to load sourcing requests.");
    } finally {
      setLoadingRequests(false);
    }
  }, [notify]);

  useEffect(() => {
    if (!user) return;
    refetchRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const completeOnboarding = useCallback(
    async (username: string) => {
      setCompletingOnboarding(true);
      try {
        const res = await fetch("/api/auth/me", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to save your profile.");
        setUser((prev) => (prev ? { ...prev, username: data.user.username } : prev));
        setNeedsOnboarding(false);
        notify("success", "Profile completed.");
        return { success: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        return { success: false, error: message };
      } finally {
        setCompletingOnboarding(false);
      }
    },
    [notify]
  );

  // Stage 4: whether the Sourcer dashboard is even reachable depends on the
  // server-verified role from GET /api/auth/me (user.role), not a
  // client-side flag anyone could set from devtools.
  const canBeSourcer = user?.role === "sourcer" || user?.role === "admin";

  const value = useMemo<SessionContextValue>(
    () => ({
      privyReady: ready,
      authenticated,
      checkingSession,
      user,
      needsOnboarding,
      completingOnboarding,
      completeOnboarding,
      canBeSourcer,
      requests,
      setRequests,
      loadingRequests,
      refetchRequests,
      walletBalance,
      web3ConnectedAddress,
      wallets,
      login,
      signingOut,
      handleSignOut,
    }),
    [
      ready,
      authenticated,
      checkingSession,
      user,
      needsOnboarding,
      completingOnboarding,
      completeOnboarding,
      canBeSourcer,
      requests,
      loadingRequests,
      refetchRequests,
      walletBalance,
      web3ConnectedAddress,
      wallets,
      login,
      signingOut,
      handleSignOut,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
