// worker/index.ts
//
// Bundled by next-pwa's customWorkerSrc mechanism (see next.config.mjs's
// PluginOptions.customWorkerSrc, default "worker") into its own
// worker-<hash>.js and importScripts()'d into the generated
// public/sw.js, runs in the SAME service worker as the existing
// precache/offline-fallback logic, just adding push + notificationclick
// on top. Disabled in dev along with the rest of the PWA (see
// next.config.mjs), verify against a production build, same as every
// other service-worker behavior in this app.
//
// PAYLOAD SECURITY (feedback-layer rule, critical): the push payload is
// UNTRUSTED input by the time it reaches a service worker, anything
// could theoretically deliver a malformed or crafted payload to this
// handler. parsePushPayload only reads known string/number fields with
// explicit type checks and length caps; nothing here is ever templated
// into HTML or innerHTML, showNotification()'s title/body go straight to
// a native OS notification API, not the DOM, so there's no injection
// surface even before this validation, but the validation still happens
// so a malformed payload fails closed (shows nothing) instead of being
// guessed at.
/// <reference lib="webworker" />

export {}; // isolatedModules needs this file to be a module even with no other exports

declare const self: ServiceWorkerGlobalScope;

interface SafePushPayload {
  title: string;
  body: string;
  tag: string;
  deepLink: string;
}

function parsePushPayload(raw: unknown): SafePushPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const title = typeof data.title === "string" ? data.title.slice(0, 120) : null;
  const body = typeof data.body === "string" ? data.body.slice(0, 200) : null;
  if (!title || !body) return null;

  const tag = typeof data.tag === "string" && data.tag ? data.tag.slice(0, 100) : "sourcefi-notification";
  // Only ever a same-origin path, never follow a payload-supplied
  // absolute/external URL out of the service worker.
  const deepLink = typeof data.deepLink === "string" && data.deepLink.startsWith("/") ? data.deepLink : "/";

  return { title, body, tag, deepLink };
}

self.addEventListener("push", (event: PushEvent) => {
  let parsed: SafePushPayload | null = null;
  try {
    parsed = event.data ? parsePushPayload(event.data.json()) : null;
  } catch {
    parsed = null; // malformed JSON, fail closed, show nothing rather than guess
  }
  if (!parsed) return;

  event.waitUntil(
    self.registration.showNotification(parsed.title, {
      body: parsed.body,
      tag: parsed.tag, // a push sharing this tag REPLACES the prior one instead of stacking (feedback-layer rule)
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { deepLink: parsed.deepLink },
    })
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { deepLink?: unknown } | undefined;
  const deepLink = typeof data?.deepLink === "string" && data.deepLink.startsWith("/") ? data.deepLink : "/";

  event.waitUntil(
    (async () => {
      // Focus an existing window if one's already open, never spawn a
      // duplicate tab, and navigate IT to the deep link, since whatever
      // window is open might be showing something else entirely.
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          const windowClient = client as WindowClient;
          try {
            await windowClient.navigate(deepLink);
          } catch {
            // Some browsers restrict navigate() on a background client in
            // certain states, focusing it below still gets the user to
            // the app, just not necessarily this exact deep link.
          }
          await windowClient.focus();
          return;
        }
      }
      await self.clients.openWindow(deepLink);
    })()
  );
});
