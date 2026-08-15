"use client";

// components/DashboardShell.tsx
//
// The shared sidebar + header shell for both /buyer and /sourcer. Replaces
// TopBar.tsx's single horizontal bar — this is a real dashboard layout
// (persistent left nav, distinct content sections), not a role-toggle
// pill sitting on top of one long scrolling page. The sidebar's dark navy
// surface is Rebrand-I's own design (see the --color-nav-* tokens in
// app/globals.css) — it was defined back in Stage 2 but nothing used it
// until now.
import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X, LogOut, ArrowLeftRight } from "lucide-react";
import { cn } from "./ui/cn";
import ThemeToggle from "./ui/ThemeToggle";
import type { AppUser } from "../lib/types";

export interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  badge?: number;
}

export interface SwitchLink {
  label: string;
  href: string;
}

export interface DashboardShellProps {
  activeDashboard: "buyer" | "sourcer" | "admin";
  /** Which other dashboards this account can jump to — each caller
   * computes its own list from the real, server-verified role (see
   * BuyerDashboard/SourcerDashboard/AdminDashboard), not a single binary
   * toggle. Empty array renders no switch links at all. */
  switchLinks: SwitchLink[];
  navItems: NavItem[];
  user: AppUser;
  onSignOut: () => void;
  signingOut: boolean;
  pageTitle: string;
  pageSubtitle?: string;
  headerAction?: React.ReactNode;
  accountCluster?: React.ReactNode;
  children: React.ReactNode;
}

function SidebarContent({
  switchLinks,
  navItems,
  user,
  onSignOut,
  signingOut,
  onNavigate,
}: Pick<DashboardShellProps, "switchLinks" | "navItems" | "user" | "onSignOut" | "signingOut"> & {
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col bg-nav-bg px-4 py-6">
      <div className="mb-8 flex items-center gap-2.5 px-2">
        <Image src="/logo-mark.png" alt="" width={32} height={32} className="rounded-md" priority />
        <span className="font-display text-lg font-bold italic text-nav-text">SourceFi</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1" aria-label="Dashboard sections">
        {navItems.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              item.onClick();
              onNavigate?.();
            }}
            aria-current={item.active ? "page" : undefined}
            className={cn(
              "flex items-center justify-between rounded-md px-3 py-2.5 text-left font-body text-sm font-semibold transition-colors duration-base ease-base",
              item.active ? "bg-nav-active-bg text-nav-active-text" : "text-nav-text-muted hover:bg-white/5 hover:text-nav-text"
            )}
          >
            <span className="flex items-center gap-2.5">
              {item.icon}
              {item.label}
            </span>
            {typeof item.badge === "number" && item.badge > 0 && (
              <span
                className={cn(
                  "rounded-pill px-1.5 py-0.5 text-[10px] font-bold",
                  item.active ? "bg-accent text-accent-contrast" : "bg-white/10 text-nav-text-muted"
                )}
              >
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-4 flex flex-col gap-1 border-t border-white/10 pt-4">
        {switchLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            onClick={() => onNavigate?.()}
            className="flex items-center gap-2.5 rounded-md px-3 py-2.5 font-body text-sm font-semibold text-nav-text-muted transition-colors duration-base ease-base hover:bg-white/5 hover:text-nav-text"
          >
            <ArrowLeftRight size={16} />
            {link.label}
          </Link>
        ))}

        <div className="flex items-center justify-between gap-2 px-1 pt-2">
          <div className="min-w-0">
            <div className="truncate font-body text-sm font-semibold text-nav-text">
              {user.username ? `@${user.username}` : user.identity}
            </div>
            <div className="truncate font-body text-xs text-nav-text-muted">{user.identity}</div>
          </div>
        </div>

        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          aria-busy={signingOut || undefined}
          className="mt-1 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left font-body text-sm font-semibold text-nav-text-muted transition-colors duration-base ease-base hover:bg-white/5 hover:text-nav-text disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LogOut size={16} />
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </div>
  );
}

export default function DashboardShell({
  switchLinks,
  navItems,
  user,
  onSignOut,
  signingOut,
  pageTitle,
  pageSubtitle,
  headerAction,
  accountCluster,
  children,
}: DashboardShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-bg font-body md:flex">
      {/* Desktop sidebar — persistent, full height */}
      <aside className="hidden w-64 shrink-0 md:block">
        <div className="sticky top-0 h-screen">
          <SidebarContent
            switchLinks={switchLinks}
            navItems={navItems}
            user={user}
            onSignOut={onSignOut}
            signingOut={signingOut}
          />
        </div>
      </aside>

      {/* Mobile top bar + slide-out nav */}
      <div className="flex items-center justify-between border-b border-border bg-nav-bg px-4 py-3 md:hidden">
        <div className="flex items-center gap-2">
          <Image src="/logo-mark.png" alt="" width={24} height={24} className="rounded" />
          <span className="font-display text-base font-bold italic text-nav-text">SourceFi</span>
        </div>
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
          className="rounded-md p-2 text-nav-text hover:bg-white/5"
        >
          <Menu size={20} />
        </button>
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-[1000] md:hidden">
          <div className="modal-backdrop absolute inset-0 bg-black/50" onClick={() => setMobileNavOpen(false)} />
          <div className="modal-content absolute inset-y-0 left-0 w-72 max-w-[85vw]">
            <div className="flex justify-end px-2 pt-2">
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation"
                className="rounded-md bg-nav-bg p-2 text-nav-text hover:bg-white/5"
              >
                <X size={18} />
              </button>
            </div>
            <SidebarContent
              switchLinks={switchLinks}
              navItems={navItems}
              user={user}
              onSignOut={onSignOut}
              signingOut={signingOut}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="min-w-0 flex-1">
        <header className="flex flex-col gap-4 border-b border-border bg-surface px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold italic text-text-primary">{pageTitle}</h1>
            {pageSubtitle && <p className="mt-1 text-sm text-text-secondary">{pageSubtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {accountCluster}
            <ThemeToggle />
            {headerAction}
          </div>
        </header>

        <main className="px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
