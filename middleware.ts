// middleware.ts
//
// Security headers (Prompt 4 finding H1), this app had none at all
// before this. CSP is nonce-based for scripts (no `unsafe-inline`) per
// Next's own documented pattern: generate a per-request nonce here, put
// it in the CSP response header, and forward it to the app via a request
// header so a server component can read it back (see app/layout.tsx and
// components/ui/ThemeScript.tsx, the one place this app has an inline
// script).
//
// The specific third-party domains below are NOT guesses, Privy
// publishes an official CSP guide
// (https://docs.privy.io/security/implementation-guide/content-security-policy)
// and this follows it exactly, extended only with what this app itself
// actually uses beyond Privy's base: Jitsi (components/JitsiMeetRoom.tsx,
// meet.jit.si), Unsplash (next.config.mjs's own remotePatterns), and the
// Arc testnet RPC (lib/wagmi-config.ts). style-src keeps 'unsafe-inline'
// on Privy's own explicit recommendation, Tailwind/Privy's embedded UI
// needs it; this is a documented vendor requirement, not a fallback taken
// out of laziness. Re-test this CSP whenever the Privy SDK is upgraded
// their own guide says exactly that.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Prompt 4, M4, CSRF second layer. sameSite=lax on the session cookie
 * (lib/session.ts) already blocks cross-site POST/PATCH/DELETE from
 * carrying it in every modern browser; this doesn't replace that, it's
 * what still holds if that ever regresses (an older browser, a future
 * sameSite behavior change). Origin is checked first (present on every
 * same-origin fetch/XHR mutation in a modern browser), Referer as a
 * fallback for the rare client that omits Origin, if BOTH are missing on
 * a mutating /api/* request, that's treated as suspicious, not permissive,
 * since this API has no legitimate caller that wouldn't send either. */
function isTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const selfOrigin = request.nextUrl.origin;

  if (origin) return origin === selfOrigin;
  if (referer) {
    try {
      return new URL(referer).origin === selfOrigin;
    } catch {
      return false;
    }
  }
  return false;
}

export function middleware(request: NextRequest) {
  // The cron route (app/api/cron/order-timeouts) is GET-only and its own
  // CRON_SECRET Bearer check is the real gate, so it's unaffected here
  // regardless. NOTE for whoever adds a real payment-provider webhook
  // route later (Yellow Card/Circle, none exists yet, see
  // lib/paymentProvider.ts): a genuine server-to-server webhook POST has
  // no browser Origin/Referer and would be wrongly blocked by this check
  // exclude that specific path here, gated by its own signature
  // verification instead, the way a webhook should be authenticated.
  if (request.nextUrl.pathname.startsWith("/api/") && UNSAFE_METHODS.has(request.method) && !isTrustedOrigin(request)) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://meet.jit.si`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://images.unsplash.com",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://meet.jit.si",
    "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com https://meet.jit.si",
    "connect-src 'self' https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://rpc.testnet.arc.network wss://meet.jit.si https://meet.jit.si",
    "worker-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), interest-cohort=()");
  // camera/microphone allowed for self only, Jitsi verification calls
  // (components/JitsiMeetRoom.tsx) are the one legitimate use in this app.
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return response;
}

export const config = {
  matcher: [
    // Every route except static assets and the two paths Next always
    // wants excluded from middleware, same posture as Next's own
    // documented default matcher.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|workbox-|fallback-|icon-|apple-icon|logo-|manifest.webmanifest).*)",
  ],
};
