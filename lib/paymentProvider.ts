// lib/paymentProvider.ts
//
// The one place a route handler gets a PaymentBoundary instance from —
// never `new StubPaymentProvider(...)` inline in a route, and never a
// Yellow Card/Circle SDK import in a route either. Swapping in a real
// provider later means changing this file only.
//
// IMPORTANT: StubPaymentProvider's "confirmation" is simulated via an
// in-process setTimeout callback (see lib/paymentBoundary.ts) — that
// only works because this is a long-running `next dev`/`next start`
// Node process holding a module-level singleton in memory. A real
// provider integration does NOT get to assume that: Circle/Yellow Card
// confirmations arrive later, out of process, via a webhook endpoint or
// a poll job — see design doc Section D.5 (poll recommended for this
// stage). This file is explicitly a dev/demo stand-in, not a template
// for how the real integration should be wired.
import { getSupabaseServerClient } from "./supabaseServer";
import { handlePaymentStatusEvent } from "./orderService";
import { StubPaymentProvider, type PaymentBoundary, type PaymentStatusEvent } from "./paymentBoundary";

let singleton: PaymentBoundary | null = null;

export function getPaymentProvider(): PaymentBoundary {
  if (!singleton) {
    singleton = new StubPaymentProvider(async (event: PaymentStatusEvent) => {
      try {
        const supabase = getSupabaseServerClient();
        await handlePaymentStatusEvent(supabase, event);
      } catch (err) {
        // A failure here means an order can get stuck mid-processing with
        // no automatic recovery — exactly the "what if our DB write fails
        // after the provider succeeded" failure scenario the design doc
        // flags (Section H) as needing a real reconciliation job (Open
        // Question 7), not solved by this stub. Logged loudly rather than
        // swallowed so it's visible in dev instead of silently stuck.
        console.error("Payment status event handling failed:", event, err);
      }
    });
  }
  return singleton;
}
