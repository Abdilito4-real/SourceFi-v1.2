"use client";

// components/NotificationSettingsPage.tsx
//
// Reachable from any role (buyer/supplier/admin all get pushed to)
// deliberately not nested under DashboardShell's role-specific nav, just
// a standalone page with a way back. Redirects out if not logged in at
// all, same guard shape as the role dashboards.
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { useSession } from "./SessionProvider";
import NotificationPreferencesPanel from "./NotificationPreferencesPanel";
import ThemeToggle from "./ui/ThemeToggle";

export default function NotificationSettingsPage() {
  const router = useRouter();
  const { checkingSession, authenticated, user } = useSession();

  useEffect(() => {
    if (!checkingSession && !authenticated) router.replace("/");
  }, [checkingSession, authenticated, router]);

  if (checkingSession || !authenticated || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 size={22} className="spin-icon text-accent" />
      </div>
    );
  }

  const homeHref = user.role === "admin" ? "/admin" : user.role === "supplier" ? "/supplier" : "/buyer";

  return (
    <div className="min-h-screen bg-bg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-5">
        <button
          type="button"
          onClick={() => router.push(homeHref)}
          className="flex items-center gap-2 text-sm font-semibold text-text-secondary hover:text-text-primary"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-xl px-6 py-8">
        <h1 className="font-display text-2xl font-semibold italic text-text-primary">Notification settings</h1>
        <p className="mt-1 text-sm text-text-secondary">Choose what you hear about, and when.</p>
        <div className="mt-6">
          <NotificationPreferencesPanel />
        </div>
      </main>
    </div>
  );
}
