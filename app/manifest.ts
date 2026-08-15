// app/manifest.ts
//
// Next.js's App Router metadata-file convention: this is auto-served at
// /manifest.webmanifest and auto-linked from every page's <head> — no
// manual <link rel="manifest"> needed.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SourceFi",
    short_name: "SourceFi",
    description: "Verified sourcing and escrow-protected procurement for hard-to-find construction materials in Nigeria.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait-primary",
    // Light theme (Rebrand-I) is the default, unauthenticated first paint —
    // these match app/globals.css :root, not the dark override, so the
    // install/splash experience matches what a fresh visitor actually sees.
    background_color: "#f6f2ea",
    theme_color: "#0b1b38",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
