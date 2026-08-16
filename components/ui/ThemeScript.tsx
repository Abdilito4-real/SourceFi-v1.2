// components/ui/ThemeScript.tsx
//
// Runs before React hydrates so the correct palette is painted on the very
// first frame, no light-then-dark flash. Reads a saved preference first;
// with no stored preference, the default is unconditionally light
// (Rebrand-I), deliberately NOT falling back to the OS's
// prefers-color-scheme, so a first-time visitor with an OS set to dark
// mode still lands on light. Dark stays fully available, just opt-in via
// ThemeToggle rather than inherited from the OS. Kept as a plain string
// injected via dangerouslySetInnerHTML because this must execute
// synchronously in <head>, before any component (including a "use
// client" one) can run.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem("sourcefi_theme");
    var theme = stored === "dark" || stored === "light" ? stored : "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
`;

export default function ThemeScript({ nonce }: { nonce?: string }) {
  // eslint-disable-next-line react/no-danger
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />;
}
