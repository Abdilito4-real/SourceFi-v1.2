"use client";

// components/ui/ThemeToggle.tsx
import React, { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

type Theme = "light" | "dark";

// Matches the theme_color values in app/manifest.ts and app/layout.tsx's
// viewport export (light/dark meta tags) — kept as one constant since a
// mismatch here would make the manual toggle and the OS-driven status bar
// color disagree.
const THEME_COLOR: Record<Theme, string> = { light: "#0b1b38", dark: "#080f14" };

// The two <meta name="theme-color" media="..."> tags Next renders from the
// viewport export only track the OS setting — a media query can't see our
// in-app localStorage toggle. This upserts one unconditional tag (no
// `media` attribute, so it always matches) after them, which browsers
// resolve in favor of over the conditional ones once it's present.
function syncThemeColorMeta(theme: Theme) {
  let tag = document.getElementById("dynamic-theme-color") as HTMLMetaElement | null;
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute("name", "theme-color");
    tag.id = "dynamic-theme-color";
    document.head.appendChild(tag);
  }
  tag.setAttribute("content", THEME_COLOR[theme] || THEME_COLOR.light);
}

export default function ThemeToggle({ className = "" }: { className?: string }) {
  // Starts null so we render nothing meaningful until we've read the DOM
  // attribute ThemeScript already set — avoids a hydration mismatch between
  // server-rendered "light" and whatever the client actually resolved.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = (document.documentElement.getAttribute("data-theme") as Theme | null) || "light";
    setTheme(current);
    syncThemeColorMeta(current);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    syncThemeColorMeta(next);
    try {
      localStorage.setItem("sourcefi_theme", next);
    } catch (e) {
      /* localStorage unavailable — theme just won't persist across visits */
    }
  };

  if (!theme) {
    return <span className={`inline-block h-9 w-9 ${className}`} aria-hidden="true" />;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={theme === "dark"}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-secondary transition-colors duration-base ease-base hover:text-text-primary hover:border-border-strong ${className}`}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
