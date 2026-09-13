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
  eventType: string | null;
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
  // Display-branching only (which OS notification options to use below),
  // never trusted for anything security-relevant, that's already fully
  // decided server-side before this payload was ever sent.
  const eventType = typeof data.eventType === "string" ? data.eventType.slice(0, 100) : null;

  return { title, body, tag, deepLink, eventType };
}

self.addEventListener("push", (event: PushEvent) => {
  let parsed: SafePushPayload | null = null;
  try {
    parsed = event.data ? parsePushPayload(event.data.json()) : null;
  } catch {
    parsed = null; // malformed JSON, fail closed, show nothing rather than guess
  }
  if (!parsed) return;

  // An incoming live call gets the "ring, don't just toast" treatment:
  // stays on screen until dismissed (a normal notification can auto-hide
  // itself after a few seconds, exactly wrong for something time-boxed
  // to the length of a call), a one-tap Join action, and a vibration
  // pattern on devices that support it. Everything else keeps the plain
  // notification it already had.
  const isIncomingCall = parsed.eventType === "verification_call_started";

  event.waitUntil(
    self.registration.showNotification(parsed.title, {
      body: parsed.body,
      tag: parsed.tag, // a push sharing this tag REPLACES the prior one instead of stacking (feedback-layer rule)
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { deepLink: parsed.deepLink },
      ...(isIncomingCall
        ? {
            requireInteraction: true,
            vibrate: [200, 100, 200, 100, 200],
            actions: [{ action: "join", title: "Join call" }],
          }
        : {}),
    })
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  // An integration audit flagged this handler as never branching on
  // event.action at all, so the "Join call" action button (the only
  // action any notification here defines, see the push handler above)
  // was indistinguishable from a plain tap on the notification body.
  // Today they genuinely lead to the same place either way (the deep
  // link already bakes in `call=1` for that notification type, tap
  // target doesn't change it), so this isn't a behavior fix -- but
  // checking explicitly means a future action added without updating
  // this handler fails safely (falls through to nothing) instead of
  // silently being treated as "join" just because it's the only branch
  // that exists.
  if (event.action && event.action !== "join") return;

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
