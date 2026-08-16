"use client";

// components/SessionProvider.tsx
//
// The session-bootstrap logic (Privy token -> our own cookie) and the
// shared orders list live here — mounted once in app/(main)/layout.tsx,
// above every route in the group, so navigating between /buyer and
// /supplier doesn't re-run the Privy handshake or refetch everything from
// scratch.
//
// Marketplace pivot: the old wallet-balance polling (Arc testnet native
// balance, shown in BuyerDashboard's header) is gone on purpose — the
// buyer never sees a wallet or a balance now (design doc Section 3: "the
// buyer should experience this as a normal NGN marketplace payment").
// Privy's wallet hooks stay (auth still goes through Privy), just not
// surfaced as a balance anywhere.
import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from "react";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useToast } from "./ui/Toast";
import type { AppUser, OrderRow } from "../lib/types";

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
  /** Server-verified: role is 'supplier' or 'admin'. A UX hint for which
   * nav links to show — never the actual authorization boundary, which
   * every route re-checks via requireRole() server-side regardless. */
  canBeSupplier: boolean;
  orders: OrderRow[];
  setOrders: React.Dispatch<React.SetStateAction<OrderRow[]>>;
  loadingOrders: boolean;
  refetchOrders: () => Promise<void>;
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
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(true);

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

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
      await logout();
      setUser(null);
      setOrders([]);
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

  const refetchOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const res = await fetch("/api/orders");
      const data: { orders?: OrderRow[]; error?: string } = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load orders.");
      setOrders(data.orders || []);
    } catch (err) {
      notify("error", err instanceof Error ? err.message : "Failed to load orders.");
    } finally {
      setLoadingOrders(false);
    }
  }, [notify]);

  useEffect(() => {
    if (!user) return;
    refetchOrders();
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

  // Whether the Supplier dashboard is even reachable depends on the
  // server-verified role from GET /api/auth/me (user.role), not a
  // client-side flag anyone could set from devtools.
  const canBeSupplier = user?.role === "supplier" || user?.role === "admin";

  const value = useMemo<SessionContextValue>(
    () => ({
      privyReady: ready,
      authenticated,
      checkingSession,
      user,
      needsOnboarding,
      completingOnboarding,
      completeOnboarding,
      canBeSupplier,
      orders,
      setOrders,
      loadingOrders,
      refetchOrders,
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
      canBeSupplier,
      orders,
      loadingOrders,
      refetchOrders,
      web3ConnectedAddress,
      wallets,
      login,
      signingOut,
      handleSignOut,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
