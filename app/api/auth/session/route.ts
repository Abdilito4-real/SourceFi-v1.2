// app/api/auth/session/route.ts
//
// The one place a Privy access token ever gets exchanged for something
// else. POST verifies the token, links/creates the corresponding users
// row, and mints our own httpOnly session cookie, see lib/session.ts for
// why we run our own session instead of Privy's cookie mode. Every other
// protected route in this app trusts that cookie (via lib/authz.ts), not
// this endpoint's request body.
import { getSupabaseServerClient } from "../../../../lib/supabaseServer";
import { verifyPrivyAccessToken, getVerifiedPrivyProfile } from "../../../../lib/privyServer";
import { setSessionCookie, clearSessionCookie, readSessionFromCookieStore } from "../../../../lib/session";
import { checkRateLimit, recordFailure, recordSuccess, rateLimitKey } from "../../../../lib/rateLimit";
import type { UserRow } from "../../../../lib/types";

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: Request) {
  const ip = clientIp(request);
  const limitKey = rateLimitKey("auth-session", ip);

  const limit = await checkRateLimit(limitKey);
  if (!limit.allowed) {
    return Response.json(
      { error: "Too many attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 30) } }
    );
  }

  const identity = await verifyPrivyAccessToken(request);
  if (!identity) {
    await recordFailure(limitKey);
    return Response.json({ error: "Invalid or expired access token." }, { status: 401 });
  }

  try {
    const supabase = getSupabaseServerClient();

    // 1. Already-linked identity, the common case on every login after
    // the first.
    const { data: existing } = await supabase
      .from("users")
      .select("*")
      .eq("privy_user_id", identity.privyUserId)
      .maybeSingle();

    let user = existing as UserRow | null;

    if (!user) {
      // 2. First time this DID has established a session. Pull the
      // verified email/wallet from Privy itself, never from this
      // request's body, so this linking step can't be used to take over
      // someone else's existing row by just claiming their email.
      const profile = await getVerifiedPrivyProfile(identity.privyUserId);
      const email = profile.email || (profile.walletAddress ? `web3_${profile.walletAddress.toLowerCase()}` : null);

      if (!email) {
        await recordFailure(limitKey);
        return Response.json({ error: "Could not resolve a verified email or wallet for this account." }, { status: 400 });
      }

      const { data: byEmail } = await supabase.from("users").select("*").eq("email", email).maybeSingle();

      if (byEmail && !byEmail.privy_user_id) {
        // Pre-Stage-4 row, never bound to a verified identity, bind it now.
        const { data: linked, error: linkErr } = await supabase
          .from("users")
          .update({ privy_user_id: identity.privyUserId })
          .eq("id", byEmail.id)
          .select("*")
          .single();
        if (linkErr) throw linkErr;
        user = linked as UserRow;
      } else if (byEmail && byEmail.privy_user_id && byEmail.privy_user_id !== identity.privyUserId) {
        // Should be unreachable, Privy guarantees an email can only be
        // linked to one of their users, but never silently proceed if it
        // somehow happens.
        console.error(`Email/DID mismatch on session establishment: ${email}`);
        return Response.json({ error: "Account conflict. Contact support." }, { status: 409 });
      } else {
        const finalUsername = email.startsWith("web3_") ? `web3_${email.slice(5, 11)}` : null;
        const { data: created, error: createErr } = await supabase
          .from("users")
          .insert({
            email,
            username: finalUsername,
            privy_user_id: identity.privyUserId,
            wallet_address: profile.walletAddress,
          })
          .select("*")
          .single();
        if (createErr) throw createErr;
        user = created as UserRow;
      }
    }

    if (!user) {
      await recordFailure(limitKey);
      return Response.json({ error: "Could not establish account." }, { status: 500 });
    }

    await setSessionCookie({ privyUserId: identity.privyUserId, userRowId: user.id, email: user.email });
    await recordSuccess(limitKey);

    return Response.json({
      success: true,
      user: { email: user.email, username: user.username, role: user.role, walletAddress: user.wallet_address ?? null },
    });
  } catch (err) {
    await recordFailure(limitKey);
    console.error("Session establishment failed:", err);
    return Response.json({ error: "Internal server error." }, { status: 500 });
  }
}

export async function DELETE() {
  // Prompt 4, M5: clearing the cookie only removes THIS device's copy
  // the signed JWT itself stays valid until its 12h expiry otherwise.
  // Stamping session_valid_after makes logout actually revoke every
  // outstanding token for this user (all devices), not just this one
  // see lib/authz.ts's requireSession(), which checks this on every
  // request. Best-effort: a failure here still clears the cookie (the
  // device the user is actually looking at ends up logged out either
  // way), it just doesn't invalidate copies elsewhere.
  const session = await readSessionFromCookieStore();
  if (session) {
    try {
      const supabase = getSupabaseServerClient();
      await supabase.from("users").update({ session_valid_after: new Date().toISOString() }).eq("id", session.userRowId);
    } catch (err) {
      console.error("Failed to stamp session_valid_after on logout:", err);
    }
  }

  await clearSessionCookie();
  return Response.json({ success: true });
}
