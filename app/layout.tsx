import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Libre_Baskerville, Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import ThemeScript from "../components/ui/ThemeScript";
import { ToastProvider } from "../components/ui/Toast";
import ServiceWorkerUpdater from "../components/ui/ServiceWorkerUpdater";
import InstallPrompt from "../components/ui/InstallPrompt";

// Self-hosted via next/font instead of a <link> to fonts.googleapis.com:
// one origin fewer to connect to, fonts are subset/served from the app's
// own domain, and Next inlines the fallback metrics to avoid layout shift.
// Matters more than usual here — sourcers are on metered mobile data.
//
// Baskerville, deliberately scoped to display/headings only (font-display
// in Tailwind config) — a classical serif at UI-chrome sizes (buttons,
// table cells, form labels) hurts scanability, so the body/UI sans stays
// Space Grotesk. This pairing is the editorial-architectural direction
// this redesign is going for, not the previous release's terminal/tech
// aesthetic (which leaned on IBM Plex Mono for nearly everything — that
// font now stays reserved for the few places a genuine monospace value
// still belongs, like tx hashes and request codes).
const display = Libre_Baskerville({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const body = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-body",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SourceFi — Verified sourcing. Secure payments.",
  description: "Specialty construction material sourcing with built-in verification and escrow.",
  // app/manifest.ts is auto-detected and auto-linked by Next — no manual
  // <link rel="manifest"> needed here.
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "SourceFi",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Two variants, not one: the status bar should track whichever palette
  // is actually on screen. This only follows the OS-level setting (a
  // media query can't see the in-app manual toggle) — ThemeToggle updates
  // the live <meta name="theme-color"> itself for the manual-override case.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0b1b38" },
    { media: "(prefers-color-scheme: dark)", color: "#080f14" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      // ThemeScript sets data-theme synchronously before hydration so
      // there's no flash of the wrong palette. React's hydration diff
      // sees that attribute appear "from nowhere" and would otherwise warn
      // — this is the same suppression next-themes and similar libraries
      // use for the identical, expected mismatch.
      suppressHydrationWarning
    >
      <head>
        <ThemeScript />
      </head>
      <body>
        <ToastProvider>
          {children}
          <ServiceWorkerUpdater />
          <InstallPrompt />
        </ToastProvider>
      </body>
    </html>
  );
}
