/** @type {import('tailwindcss').Config} */
//
// This config does not define a single hex value. Every color resolves to a
// CSS custom property declared once in app/globals.css (light values on
// :root, dark overrides on [data-theme="dark"]). Components style against
// role names (bg-surface, text-secondary, border-strong…) and get the
// correct palette automatically, there's nothing theme-specific to update
// when a component is written.
//
module.exports = {
  darkMode: ["selector", '[data-theme="dark"]'],
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./components/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        "surface-elevated": "var(--color-surface-elevated)",
        "surface-sunken": "var(--color-surface-sunken)",
        border: {
          DEFAULT: "var(--color-border)",
          strong: "var(--color-border-strong)",
        },
        text: {
          primary: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          tertiary: "var(--color-text-tertiary)",
          inverse: "var(--color-text-inverse)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          soft: "var(--color-accent-soft)",
          text: "var(--color-accent-text)",
          contrast: "var(--color-accent-contrast)",
        },
        success: {
          DEFAULT: "var(--color-success)",
          soft: "var(--color-success-soft)",
          text: "var(--color-success-text)",
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          soft: "var(--color-warning-soft)",
          text: "var(--color-warning-text)",
        },
        danger: {
          DEFAULT: "var(--color-danger)",
          soft: "var(--color-danger-soft)",
          text: "var(--color-danger-text)",
        },
        focus: "var(--color-focus-ring)",
        nav: {
          bg: "var(--color-nav-bg)",
          text: "var(--color-nav-text)",
          "text-muted": "var(--color-nav-text-muted)",
          "active-bg": "var(--color-nav-active-bg)",
          "active-text": "var(--color-nav-text-active)",
        },
      },
      fontFamily: {
        // "Circular"/"CircularStd" tried first, a paid Lineto typeface
        // this repo doesn't (and shouldn't) bundle; renders automatically
        // if a viewer's device already has it, or once this app is
        // deployed with a real licensed self-host. var(--font-sans) is
        // the actual loaded font (Roboto, via next/font in app/layout.tsx)
        // that everyone sees today. See app/layout.tsx's comment.
        display: ["Circular", "CircularStd", "var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        body: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        xs: ["11px", { lineHeight: "1.5" }],
        sm: ["12px", { lineHeight: "1.5" }],
        base: ["13.5px", { lineHeight: "1.55" }],
        md: ["15px", { lineHeight: "1.5" }],
        lg: ["17px", { lineHeight: "1.4" }],
        xl: ["19px", { lineHeight: "1.3" }],
        "2xl": ["22px", { lineHeight: "1.25" }],
        "3xl": ["26px", { lineHeight: "1.2" }],
        "4xl": ["32px", { lineHeight: "1.15" }],
        display: ["clamp(2.25rem, 5vw, 3.625rem)", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
      },
      borderRadius: {
        sm: "6px",
        DEFAULT: "8px",
        md: "9px",
        lg: "10px",
        xl: "12px",
        "2xl": "14px",
        pill: "999px",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-md)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      transitionTimingFunction: {
        base: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        base: "150ms",
      },
    },
  },
  plugins: [],
};
