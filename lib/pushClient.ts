"use client";

// lib/pushClient.ts
//
// Thin client-side wrapper around the Push API + this app's subscribe/
// unsubscribe routes. Deliberately does NOT call Notification.requestPermission()
// itself, see components/PushSoftPrompt.tsx for the permission-timing
// rules (never on load, only after a soft prompt the user agreed to,
// never re-prompt after a denial).

export function isPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function getPermissionState(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

// PushManager.subscribe() needs the VAPID public key as a Uint8Array, not
// the base64url string the server hands back, this is the standard
// conversion (MDN's own example), not anything push-specific to this app.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export class PushSetupError extends Error {}

/** Requests the native permission (must be called from a user gesture,
 * per browser rules, the caller, PushSoftPrompt, only calls this after
 * its own soft prompt was accepted), then subscribes and registers with
 * the server. Throws PushSetupError with a message safe to show directly. */
export async function enablePush(): Promise<void> {
  if (!isPushSupported()) throw new PushSetupError("Push notifications aren't supported on this browser.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushSetupError(
      permission === "denied"
        ? "Notifications are blocked for this site. Enable them in your browser's site settings to turn this back on."
        : "Permission wasn't granted."
    );
  }

  const keyRes = await fetch("/api/push/vapid-public-key");
  const keyData = await keyRes.json();
  if (!keyRes.ok || !keyData.publicKey) {
    throw new PushSetupError("Push notifications aren't available right now. Try again later.");
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true, // required by Chrome/Firefox: every push must show a visible notification, never a silent one
    // lib.dom.d.ts's ArrayBufferView<ArrayBuffer> vs our Uint8Array's
    // (possibly-Shared) ArrayBufferLike backing is a real TS pedantry
    // mismatch, not a runtime one, PushManager.subscribe genuinely
    // accepts a Uint8Array here (MDN's own example does exactly this).
    applicationServerKey: urlBase64ToUint8Array(keyData.publicKey) as BufferSource,
  });

  const json = subscription.toJSON();
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent }),
  });
  if (!res.ok) {
    // The browser-side subscription now exists even though the server
    // never learned about it, unsubscribe again rather than leave the
    // device silently "subscribed" to nothing the server will ever push
    // to (a state indistinguishable from "everything's fine" to the
    // user, which is exactly the ambiguity this whole feedback pack
    // exists to avoid).
    await subscription.unsubscribe().catch(() => {});
    throw new PushSetupError("Couldn't finish setting up notifications. Try again.");
  }
}

/** Called when a subscription has gone stale (e.g. the browser expired it
 * mid-session, pushsubscriptionchange, or a 410 the server reported) so
 * the server-side row doesn't linger for a device that no longer has it. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => {});
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
}

export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}
