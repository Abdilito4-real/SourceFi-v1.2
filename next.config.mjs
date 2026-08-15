// next.config.mjs
//
// This is the file Next.js actually loads. A sibling file named
// `next.config` (no .js/.mjs extension) previously held real webpack
// fixes for the wallet-connector dependency noise — Next.js never reads
// unextensioned config files, so that file was silent dead weight with
// zero effect. Its logic is folded in below; the dead file has been removed.
//
// Next 16 defaults `next dev` AND `next build` to Turbopack, which does not
// run webpack plugins — but @ducanh2912/next-pwa wraps workbox-webpack-plugin,
// a webpack-only tool, and the IgnorePlugin fix below is webpack-specific
// too. That's why package.json's dev/build scripts pass `--webpack`
// explicitly: this project has a hard webpack dependency via its PWA
// tooling, not an oversight to "migrate to Turbopack" later without first
// swapping the service-worker generator for something Turbopack-native.
import withPWAInit from "@ducanh2912/next-pwa";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // lucide-react is imported by name (import { X, Y } from "lucide-react")
  // across most components in this app — without this, webpack has to
  // resolve and consider tracing the ENTIRE icon package on every one of
  // those imports instead of just the icons actually used. This is a
  // documented, safe win specifically for large named-export packages like
  // this one; it doesn't change behavior, only what webpack has to walk.
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  images: {
    // next/image needs an explicit allowlist for any external host it's
    // asked to optimize — components/OnboardingCarousel.tsx is the one
    // place that does (real photography for the intro slides). Everywhere
    // else that references an Unsplash URL uses a plain <img>, which
    // doesn't go through next/image and doesn't need this.
    remotePatterns: [{ protocol: "https", hostname: "images.unsplash.com" }],
  },
  webpack: (config, { webpack }) => {
    // The wagmi/Reown/WalletConnect ecosystem bundles many optional wallet
    // connectors (Coinbase's x402 payment protocol, Porto passkey wallet,
    // and others), each of which references peer packages that aren't
    // installed by default since we don't use those specific connectors.
    // Rather than installing or fixing each one individually as it surfaces,
    // this ignores the whole known family at once.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^(@x402\/|porto)/,
      })
    );

    // A few additional packages commonly referenced optionally by
    // WalletConnect-ecosystem libraries that aren't needed in the browser.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "pino-pretty": false,
      encoding: false,
      lokijs: false,
    };

    return config;
  },
};

const withPWA = withPWAInit({
  dest: "public",
  // Disabled in dev on purpose: HMR and the service worker fight over
  // caching in ways that produce confusing, non-representative behavior.
  // PWA behavior (precaching, offline fallback, update flow) is verified
  // against a production build (`next build && next start`) instead.
  disable: process.env.NODE_ENV === "development",
  cacheOnFrontEndNav: true,
  reloadOnOnline: true,
  fallbacks: {
    // Served for any navigation that isn't precached and the network
    // request fails — replaces the browser's default offline page.
    document: "/offline",
  },
  workboxOptions: {
    disableDevLogs: true,
    // A waiting worker must NOT take over on its own — see
    // components/ui/ServiceWorkerUpdater.js, which offers the reload as an
    // explicit user action instead. (These are workbox-webpack-plugin's own
    // defaults; set explicitly here so the intent survives a library upgrade.)
    skipWaiting: false,
    clientsClaim: false,
    runtimeCaching: [
      {
        // Read-only, non-financial: safe to serve a recent cached copy if
        // the network is slow/down, but always prefer a fresh fetch first.
        // Workbox route matching is GET-only by default — every mutating
        // escrow/request action in this app is POST/PATCH, so none of them
        // are reachable through this cache layer at all, deliberately.
        urlPattern: /\/api\/requests(\/.*)?$/,
        method: "GET",
        handler: "NetworkFirst",
        options: {
          cacheName: "sourcefi-api-requests",
          networkTimeoutSeconds: 4,
          expiration: { maxEntries: 50, maxAgeSeconds: 5 * 60 },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // Material photos, the verified-audit evidence fallback image, etc.
        urlPattern: ({ request }) => request.destination === "image",
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "sourcefi-images",
          expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 },
        },
      },
      {
        // Self-hosted next/font files — effectively immutable per build.
        urlPattern: ({ request }) => request.destination === "font",
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "sourcefi-fonts",
          expiration: { maxEntries: 20, maxAgeSeconds: 60 * 24 * 60 * 60 },
        },
      },
    ],
  },
});

export default withPWA(nextConfig);
