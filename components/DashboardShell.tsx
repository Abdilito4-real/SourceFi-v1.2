"use client";

// components/DashboardShell.tsx
//
// The shared sidebar + header shell for both /buyer and /sourcer. Replaces
// TopBar.tsx's single horizontal bar, this is a real dashboard layout
// (persistent left nav, distinct content sections), not a role-toggle
// pill sitting on top of one long scrolling page. The sidebar's dark navy
// surface is Rebrand-I's own design (see the --color-nav-* tokens in
// app/globals.css), it was defined back in Stage 2 but nothing used it
// until now.
import React, { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X, LogOut, ArrowLeftRight } from "lucide-react";
import { cn } from "./ui/cn";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import ThemeToggle from "./ui/ThemeToggle";
import PushSoftPrompt from "./PushSoftPrompt";
import IncomingCallBanner from "./IncomingCallBanner";
import MyProfileModal from "./MyProfileModal";
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
  activeDashboard: "buyer" | "supplier" | "admin";
  /** Which other dashboards this account can jump to, each caller
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
  notificationBell?: React.ReactNode;
  children: React.ReactNode;
}

function SidebarContent({
  switchLinks,
  navItems,
  user,
  onSignOut,
  signingOut,
  onOpenProfile,
  onNavigate,
}: Pick<DashboardShellProps, "switchLinks" | "navItems" | "user" | "onSignOut" | "signingOut"> & {
  onOpenProfile: () => void;
  onNavigate?: () => void;
}) {
  return (
    // overflow-y-auto: defensive, not just for desktop's fixed h-screen
    // sidebar. The mobile drawer is full-height too, and with enough nav
    // items + switch links + account footer (Admin's 6 nav items is
    // already close), a short landscape-phone viewport can run out of
    // room; without this the bottom (sign out) would just be clipped
    // with no way to reach it.
    <div className="flex h-full flex-col overflow-y-auto bg-nav-bg px-4 py-6">
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
            // border-left-color deliberately left out of the transition
            // (background-color/color only, not the blanket
            // transition-colors): it's theme-driven, and transitioning a
            // var()-only color change under a held `transition` can get
            // visibly stuck on the pre-toggle color until something else
            // forces a reflow, see the identical note in OrderCard.tsx.
            // py-3 (not py-2.5): this is the mobile drawer's nav list as
            // much as the desktop sidebar's, ~44px is the real minimum
            // comfortable tap target on a touch screen.
            className={cn(
              "flex items-center justify-between rounded-md border-l-2 px-3 py-3 text-left font-body text-sm font-semibold transition-[background-color,color] duration-base ease-base",
              item.active
                ? "border-l-accent bg-nav-active-bg text-nav-active-text"
                : "border-l-transparent text-nav-text-muted hover:bg-white/5 hover:text-nav-text"
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
            className="flex items-center gap-2.5 rounded-md px-3 py-3 font-body text-sm font-semibold text-nav-text-muted transition-colors duration-base ease-base hover:bg-white/5 hover:text-nav-text"
          >
            <ArrowLeftRight size={16} />
            {link.label}
          </Link>
        ))}

        <button
          type="button"
          onClick={onOpenProfile}
          aria-label="View my profile"
          className="flex items-center gap-2.5 rounded-md px-1 pt-2 text-left transition-colors duration-base ease-base hover:bg-white/5"
        >
          {user.profilePictureUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a
            // Cloudinary URL, not a local Next.js image asset.
            <img src={user.profilePictureUrl} alt="" className="h-8 w-8 shrink-0 rounded-full border border-white/10 object-cover" />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/10 font-display text-xs font-semibold text-nav-text"
            >
              {(user.username || user.identity || "?").charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate font-body text-sm font-semibold text-nav-text">
              {user.username ? `@${user.username}` : user.identity}
            </div>
            <div className="truncate font-body text-xs text-nav-text-muted">{user.identity}</div>
          </div>
        </button>

        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          aria-busy={signingOut || undefined}
          className="mt-1 flex items-center gap-2.5 rounded-md px-3 py-3 text-left font-body text-sm font-semibold text-nav-text-muted transition-colors duration-base ease-base hover:bg-white/5 hover:text-nav-text disabled:cursor-not-allowed disabled:opacity-60"
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
  notificationBell,
  children,
}: DashboardShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Same missing-lock bug Modal.tsx had: this drawer is also a `fixed
  // inset-0` overlay, so touch-dragging its backdrop could scroll the
  // dashboard behind it. Shared, reference-counted with every Modal —
  // see components/ui/useBodyScrollLock.ts.
  useBodyScrollLock(mobileNavOpen);

  // First thing after sign-in: this shell is what mounts the moment a
  // signed-in user lands on their dashboard, so this is that moment.
  // PushSoftPrompt itself still gates on the real rule (permission
  // still "default", never soft-declined before), so this is a no-op
  // and shows nothing once the user has actually answered once.
  const [pushPromptOpen, setPushPromptOpen] = useState(false);
  useEffect(() => {
    setPushPromptOpen(true);
  }, []);

  const [profileModalOpen, setProfileModalOpen] = useState(false);

  return (
    <div className="min-h-screen bg-bg font-body md:flex">
      {/* Desktop sidebar, persistent, full height */}
      <aside className="hidden w-64 shrink-0 md:block">
        <div className="sticky top-0 h-screen">
          <SidebarContent
            switchLinks={switchLinks}
            navItems={navItems}
            user={user}
            onSignOut={onSignOut}
            signingOut={signingOut}
            onOpenProfile={() => setProfileModalOpen(true)}
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
          // Stays mounted (not conditionally rendered) so the layout
          // doesn't jump, but invisible while the drawer's own close
          // button is up, otherwise this peeks through the drawer's
          // semi-transparent backdrop as a second, confusing menu icon.
          // p-2.5, not p-2: the primary way into navigation on mobile,
          // worth the extra few px toward a real ~44px tap target.
          className={cn("-mr-1 rounded-md p-2.5 text-nav-text hover:bg-white/5", mobileNavOpen && "invisible")}
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
                className="rounded-md bg-nav-bg p-2.5 text-nav-text hover:bg-white/5"
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
              onOpenProfile={() => {
                setProfileModalOpen(true);
                setMobileNavOpen(false);
              }}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="min-w-0 flex-1">
        <header className="flex flex-col gap-4 border-b border-border bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5">
          <div>
            <h1 className="font-display text-xl font-semibold italic text-text-primary sm:text-2xl">{pageTitle}</h1>
            {pageSubtitle && <p className="mt-1 text-sm text-text-secondary">{pageSubtitle}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {accountCluster}
            {notificationBell}
            <ThemeToggle />
            {headerAction}
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>

      <PushSoftPrompt
        open={pushPromptOpen}
        onClose={() => setPushPromptOpen(false)}
        reason="You're signed in."
      />
      <IncomingCallBanner role={user.role} />
      {profileModalOpen && <MyProfileModal onClose={() => setProfileModalOpen(false)} />}
    </div>
  );
}
