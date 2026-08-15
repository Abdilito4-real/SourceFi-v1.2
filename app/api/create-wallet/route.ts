import { getSupabaseServerClient } from "../../../lib/supabaseServer";
// The original JS called crypto.randomUUID() relying on the Node 19+ global
// (unlike app/api/escrow/route.ts, which already imports it explicitly) —
// fragile depending on the Node version, and already flagged as such in
// the Stage 1 audit. Importing explicitly here removes that dependency on
// ambient globals rather than carrying the inconsistency forward.
import crypto from "crypto";

const CIRCLE_BASE_URL = "https://api.circle.com";
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, email, deviceId, userToken } = body;

    const supabase = getSupabaseServerClient();
    const cleanEmail = email ? email.trim().toLowerCase() : null;

    // --- ACTION A: Request temporary tokens and trigger Mailtrap OTP ---
    if (action === "requestEmailOtp") {
      if (!cleanEmail || !deviceId) {
        return Response.json({ error: "Missing email or deviceId" }, { status: 400 });
      }

      // --- Security Guard Checks ---
      if (body.mode === "signin") {
        const { data: existingUser } = await supabase
          .from("users")
          .select("*")
          .eq("email", cleanEmail)
          .maybeSingle();

        if (!existingUser) {
          return Response.json({ error: "This email is not registered yet. Please click the Sign Up tab to create an account." }, { status: 400 });
        }
      } else if (body.mode === "signup") {
        const { data: emailCheck } = await supabase
          .from("users")
          .select("*")
          .eq("email", cleanEmail)
          .maybeSingle();

        if (emailCheck) {
          return Response.json({ error: "This email is already registered. Please use the Sign In tab." }, { status: 400 });
        }

        if (body.username) {
          const { data: usernameCheck } = await supabase
            .from("users")
            .select("*")
            .eq("username", body.username.trim())
            .maybeSingle();

          if (usernameCheck) {
            return Response.json({ error: "This username is already taken. Please choose another one." }, { status: 400 });
          }
        }
      }

      const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/users/email/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CIRCLE_API_KEY}`
        },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          deviceId,
          email: cleanEmail
        })
      });

      const data = await response.json();
      if (!response.ok) {
        return Response.json(
          { error: data.error || data.message || "Failed to trigger email OTP" },
          { status: response.status }
        );
      }

      return Response.json({ success: true, ...data.data });
    }

    // --- ACTION B: Initialize User and check for existing wallets ---
    if (action === "initializeUser") {
      if (!userToken) {
        return Response.json({ error: "Missing userToken" }, { status: 400 });
      }

      let wallets: Array<{ address: string; id: string; walletSetId?: string }> = [];
      let attempts = 0;

      while (attempts < 3) {
        const walletRes = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/wallets`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${CIRCLE_API_KEY}`,
            "X-User-Token": userToken
          }
        });

        if (walletRes.ok) {
          const walletData = await walletRes.json();
          if (walletData.data?.wallets?.length > 0) {
            wallets = walletData.data.wallets;
            break;
          }
        }

        attempts++;
        if (attempts < 3) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      if (wallets.length > 0) {
        const wallet = wallets[0]!;
        const updates: { email: string | null; wallet_address: string; wallet_id: string; wallet_set_id: string | null; username?: string } = {
          email: cleanEmail,
          wallet_address: wallet.address,
          wallet_id: wallet.id,
          wallet_set_id: wallet.walletSetId || null
        };
        if (body.username) {
          updates.username = body.username.trim();
        }

        if (cleanEmail) {
          await supabase.from("users").upsert(updates, { onConflict: "email" });
        }

        const { data: userRecord } = await supabase
          .from("users")
          .select("username")
          .eq("email", cleanEmail)
          .maybeSingle();

        return Response.json({
          success: true,
          initialized: true,
          walletAddress: wallet.address,
          walletId: wallet.id,
          username: userRecord?.username || null
        });
      }

      const initRes = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/user/initialize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${CIRCLE_API_KEY}`,
          "X-User-Token": userToken
        },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          blockchains: ["ARC-TESTNET"],
          accountType: "EOA"
        })
      });

      const initData = await initRes.json();
      if (!initRes.ok) {
        return Response.json(
          { error: initData.error || initData.message || "Failed to initialize user session" },
          { status: initRes.status }
        );
      }

      return Response.json({
        success: true,
        initialized: false,
        challengeId: initData.data?.challengeId
      });
    }

    // --- ACTION C: Query Live On-Chain USDC Wallet Balance ---
    if (action === "fetchBalance") {
      if (!cleanEmail) {
        return Response.json({ error: "Email is required" }, { status: 400 });
      }

      const { data: userRecord } = await supabase
        .from("users")
        .select("wallet_id")
        .eq("email", cleanEmail)
        .maybeSingle();

      if (!userRecord?.wallet_id) {
        return Response.json({ success: true, balance: "0.00" });
      }

      const balanceRes = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/wallets/${userRecord.wallet_id}/balances`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${CIRCLE_API_KEY}`
        }
      });

      if (!balanceRes.ok) {
        return Response.json({ success: true, balance: "0.00" });
      }

      const balanceData = await balanceRes.json();
      const tokenBalances = balanceData.data?.tokenBalances || [];
      const usdcBalance = tokenBalances.find((b: { token?: { symbol?: string } }) => b.token?.symbol === "USDC");
      const balanceAmount = usdcBalance ? usdcBalance.amount : (tokenBalances[0]?.amount || "0.00");

      return Response.json({
        success: true,
        balance: parseFloat(balanceAmount).toFixed(2)
      });
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("User-Controlled Wallet Error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
