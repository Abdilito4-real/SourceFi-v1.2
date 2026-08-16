// lib/notifications/emailProvider.ts
//
// Fallback delivery for critical financial events (feedback-layer rule:
// "Critical financial events additionally go by email... The system must
// be correct if push never arrives at all"). Same "real the moment
// credentials exist, stub otherwise" posture as
// lib/paymentProvider.ts/lib/circleEscrowProvider.ts: resolves to a
// console.log stub until RESEND_API_KEY is set, at which point it sends a
// real email via Resend's REST API (plain fetch, no SDK dependency
// needed for one endpoint). No partial state: either the key is present,
// or nothing about this changes.
//
// Same payload-security posture as the push payload (see
// lib/notifications/dispatch.ts): callers pass an already-safe subject/
// body, never a raw amount or wallet address baked in here, this module
// doesn't re-derive or add sensitive detail, it just delivers what it's
// given.
import "server-only";

export interface CriticalEmailInput {
  to: string;
  subject: string;
  body: string;
  deepLink: string | null;
}

export async function sendCriticalEmail(input: CriticalEmailInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFICATIONS_FROM_EMAIL || "SourceFi <notifications@sourcefi.app>";

  if (!apiKey) {
    // Stub: no email provider configured. Logged, not silently dropped.
    console.log(`[email stub, RESEND_API_KEY not set] to=${input.to} subject="${input.subject}" body="${input.body}"`);
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.deepLink ? `${input.body}\n\n${input.deepLink}` : input.body,
      }),
    });
    if (!res.ok) {
      console.error(`Critical-email send failed (${res.status}) for ${input.to}:`, await res.text().catch(() => ""));
    }
  } catch (err) {
    // A failed fallback email must never throw back into the caller, the
    // in-app notification row (the actual source of truth) is already
    // written by the time this runs; losing the email on top of a push
    // that may also have failed is bad, but it must not also break
    // whatever order/dispute action triggered the notification.
    console.error(`Critical-email send threw for ${input.to}:`, err);
  }
}
