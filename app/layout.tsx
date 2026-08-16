import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Roboto, IBM_Plex_Mono } from "next/font/google";
import ThemeScript from "../components/ui/ThemeScript";
import { ToastProvider } from "../components/ui/Toast";
import ServiceWorkerUpdater from "../components/ui/ServiceWorkerUpdater";
import InstallPrompt from "../components/ui/InstallPrompt";

// Self-hosted via next/font instead of a <link> to fonts.googleapis.com:
// one origin fewer to connect to, fonts are subset/served from the app's
// own domain, and Next inlines the fallback metrics to avoid layout shift.
// Matters more than usual here — sourcers are on metered mobile data.
//
// Brand direction: Circular (Lineto) for headings/prominent UI text,
// paired with Roboto for body text. IMPORTANT — Circular is a paid,
// commercially licensed typeface; this repo does not (and should not)
// bundle or fetch the actual font files, since there's no license here
// to redistribute them. `tailwind.config.js`'s `font-display` stack
// names "Circular"/"CircularStd" FIRST, so it renders automatically
// wherever it's actually available (a viewer's OS/device already has it
// installed, or this app is later deployed with a real licensed
// self-hosted copy via next/font/local) — with NO code change needed
// when that happens. Until then it falls straight through to this
// Roboto load, which is what both `font-display` and `font-body`
// actually render as today. Loaded once, referenced by both Tailwind
// families (see tailwind.config.js) rather than duplicated.
const sans = Roboto({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  style: ["normal", "italic"],
  variable: "--font-sans",
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
      className={`${sans.variable} ${mono.variable}`}
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
