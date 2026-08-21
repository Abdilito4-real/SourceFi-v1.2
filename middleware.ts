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
// meet.jit.si, or 8x8.vc once lib/jaasAuth.ts's env vars are set, both
// domains stay allowlisted regardless of which one a given request
// actually uses, keeping this list config-independent), Unsplash
// (next.config.mjs's own remotePatterns), and the Arc testnet RPC
// (lib/wagmi-config.ts). style-src keeps 'unsafe-inline' on Privy's own
// explicit recommendation, Tailwind/Privy's embedded UI needs it; this
// is a documented vendor requirement, not a fallback taken out of
// laziness. Re-test this CSP whenever the Privy SDK is upgraded, their
// own guide says exactly that.
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

// Server-to-server webhook POSTs (Part 2 of the production-hardening
// pass, app/api/webhooks/circle/route.ts) have no browser Origin/Referer
// by nature, they're not a browser request at all, and the CSRF check
// below would wrongly block every real Circle notification. Excluded
// here, exactly as this file's own prior note anticipated, gated
// instead by that route's own signature verification
// (verifyWebhookSignature, X-Circle-Signature/X-Circle-Key-Id), a
// stronger authentication than Origin-checking could ever provide for a
// non-browser caller. The cron route (app/api/cron/*) needs no such
// exclusion, it's GET-only, outside UNSAFE_METHODS entirely.
const CSRF_EXEMPT_PATHS = new Set(["/api/webhooks/circle", "/api/webhooks/yellowcard"]);

export function middleware(request: NextRequest) {
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    !CSRF_EXEMPT_PATHS.has(request.nextUrl.pathname) &&
    UNSAFE_METHODS.has(request.method) &&
    !isTrustedOrigin(request)
  ) {
    return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // Next.js dev-mode Fast Refresh (react-refresh-utils/runtime.js) applies
  // hot-reloaded modules via eval(), which a strict script-src blocks,
  // breaking HMR (page loads, edits silently stop showing up until a hard
  // refresh). 'unsafe-eval' is added ONLY outside production so this never
  // weakens the CSP real users get; the production build doesn't use
  // eval-based HMR at all, so nothing here needs it.
  const scriptSrc =
    process.env.NODE_ENV === "production"
      ? `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://meet.jit.si https://8x8.vc`
      : `script-src 'self' 'unsafe-eval' 'nonce-${nonce}' https://challenges.cloudflare.com https://meet.jit.si https://8x8.vc`;

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://images.unsplash.com https://meet.jit.si https://8x8.vc",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://meet.jit.si https://8x8.vc",
    "frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com https://meet.jit.si https://8x8.vc",
    // stun:/turn:/turns: are their own CSP schemes, distinct from
    // https:/wss:, an https-only entry does NOT cover them. Without
    // these, signaling (a WebSocket, already allowed above) succeeds,
    // the room shows "joined" and the call timer counts, but actual
    // audio/video never arrives for anyone whose network needs a TURN
    // relay to punch through NAT/firewalls (mobile carrier networks are
    // exactly this case), a blank tile and no sound despite a "connected"
    // call. Scheme-only sources (no host) are the standard, documented
    // way to allow WebRTC media relay under CSP, since a call provider's
    // TURN fleet is typically many regional hosts, not one fixed domain.
    "connect-src 'self' https://auth.privy.io wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://explorer-api.walletconnect.com https://rpc.testnet.arc.network wss://meet.jit.si https://meet.jit.si wss://8x8.vc https://8x8.vc wss://*.8x8.vc https://*.8x8.vc stun: turn: turns:",
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
  // camera/microphone must explicitly allowlist the Jitsi origins, not
  // just (self): the call renders inside a CROSS-ORIGIN iframe
  // (meet.jit.si, or 8x8.vc once JaaS is configured), and (self) alone
  // does not delegate camera/mic to any iframe regardless of what the
  // user allows in their own browser's permission prompt. Without this,
  // getUserMedia() fails inside the iframe with a permissions-policy
  // violation before it ever reaches the OS permission check, the call
  // still "connects" (signaling isn't gated by this) but stays blank
  // and silent.
  response.headers.set(
    "Permissions-Policy",
    'camera=(self "https://meet.jit.si" "https://8x8.vc"), microphone=(self "https://meet.jit.si" "https://8x8.vc"), geolocation=(), interest-cohort=()'
  );
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
