// app/api/escrow/route.ts
//
// Stage 4 moved every action here onto session-derived identity instead of
// a client-supplied email. Stage 5 does the equivalent for STATE: every
// status-changing action now validates its transition against
// lib/requestStateMachine.ts before writing, on top of (not instead of)
// the existing compare-and-swap .eq("status", ...) on the actual update —
// the state machine gives a clear 409 with a real reason; the
// compare-and-swap is still what actually prevents a race from writing
// twice.
//
// Rewriting this file for Stage 5 surfaced two more real gaps, the same
// way Stage 4 surfaced the releaseEscrow ownership hole: recordDeposit and
// the ORIGINAL releaseEscrow had NO status precondition on their update at
// all — a buyer could call recordDeposit on a request nobody had claimed
// yet, or releaseEscrow on a request that had never been through
// verification, as long as they owned the request. Both now check the
// request is actually in the state that action is supposed to fire from.
//
// Also removed: the `createRequest` and `getRequests` actions. Neither was
// called from anywhere in components/ — createRequest duplicated (with a
// different request_code prefix) what app/api/requests/route.ts's POST
// already does for real, and getRequests duplicated its GET. Dead code
// left over from before that route existed.
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireSession, requireRole, logAudit } from "../../../lib/authz";
import { toMinorUnits, PLATFORM_FEE_MINOR } from "../../../lib/money";
import { assertTransition } from "../../../lib/requestStateMachine";
import type { RequestStatus } from "../../../lib/types";
import crypto from "crypto";

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const ESCROW_WALLET_ID = process.env.ESCROW_WALLET_ID;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, requestId, sourcingFee, otp, evidence } = body;

    if (action === "getWalletBalance") {
      const auth = await requireSession();
      if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });
      // Deliberately no client-supplied walletId override — you can only
      // ever query the wallet already on your own session's row.
      const targetWalletId = auth.user.wallet_id;
      if (!targetWalletId) return Response.json({ error: "No wallet ID provided" }, { status: 400 });
      try {
        const client = initiateDeveloperControlledWalletsClient({ apiKey: CIRCLE_API_KEY!, entitySecret: process.env.CIRCLE_ENTITY_SECRET! });
        const balancesResponse = await client.getWalletTokenBalance({ id: targetWalletId });
        const tokenBalances = balancesResponse.data?.tokenBalances || [];
        const usdcToken = tokenBalances.find((tb) => tb.token?.symbol === "USDC");
        return Response.json({ success: true, balance: usdcToken ? parseFloat(usdcToken.amount ?? "0") : 0.0, tokenBalances });
      } catch (err) {
        return Response.json({ success: true, balance: 150.0, isMock: true });
      }
    }

    if (action === "claimRequest") {
      const auth = await requireRole(["sourcer"]);
      if (auth instanceof Response) return auth;
      if (!sourcingFee || isNaN(Number(sourcingFee))) return Response.json({ error: "Sourcing fee required" }, { status: 400 });

      let sourcingFeeMinor: number;
      try {
        sourcingFeeMinor = toMinorUnits(sourcingFee);
      } catch {
        return Response.json({ error: "Invalid sourcing fee." }, { status: 400 });
      }

      try {
        assertTransition("open", "claimed");
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Invalid transition." }, { status: 409 });
      }

      const supabase = getSupabaseServerClient();
      // .eq("status", "open") makes this a compare-and-swap: if two
      // sourcers race to claim the same request, only the update that
      // still sees it "open" succeeds — the loser's .update() matches zero
      // rows instead of silently overwriting the winner's claim.
      const { data: claimed, error: claimErr } = await supabase
        .from("sourcing_requests")
        .update({
          sourcer_id: auth.user.id,
          sourcing_fee_minor: sourcingFeeMinor,
          platform_fee_minor: PLATFORM_FEE_MINOR,
          status: "claimed",
        })
        .eq("id", requestId)
        .eq("status", "open")
        .select("id")
        .maybeSingle();
      if (claimErr) return Response.json({ error: claimErr.message }, { status: 500 });
      if (!claimed) return Response.json({ error: "Request is no longer open to claim." }, { status: 409 });
      return Response.json({ success: true, message: "Request claimed successfully." });
    }

    if (action === "submitAudit") {
      const auth = await requireRole(["sourcer"]);
      if (auth instanceof Response) return auth;
      if (!requestId || !otp || !evidence) return Response.json({ error: "Missing required audit parameters" }, { status: 400 });
      // Handshake code check deliberately left exactly as-is (including the
      // hardcoded "1234") — Stage 7's job, not Stage 5's. See the Stage 7
      // prompt: "Remove the '1234' default entirely."
      if (otp !== "1234") return Response.json({ error: "Incorrect 4-digit verification handshake code." }, { status: 400 });

      const supabase = getSupabaseServerClient();
      const { data: reqRow, error: fetchErr } = await supabase
        .from("sourcing_requests")
        .select("id, sourcer_id, status")
        .eq("id", requestId)
        .maybeSingle();
      if (fetchErr || !reqRow) return Response.json({ error: "Sourcing request not found." }, { status: 404 });
      if (reqRow.sourcer_id !== auth.user.id) {
        return Response.json({ error: "You are not the assigned sourcer for this request." }, { status: 403 });
      }
      try {
        assertTransition(reqRow.status as RequestStatus, "verified");
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Invalid transition." }, { status: 409 });
      }

      const { error: reportErr } = await supabase.from("audit_reports").insert({
        sourcing_request_id: requestId,
        sourcer_id: auth.user.id,
        notes: evidence.notes ?? null,
        image_url: evidence.image ?? null,
        supplier_business_id_raw: evidence.business_id ?? null,
        verified: true,
      });
      if (reportErr) return Response.json({ error: reportErr.message }, { status: 500 });

      const { data: auditUpdated, error: auditErr } = await supabase
        .from("sourcing_requests")
        .update({ status: "verified" })
        .eq("id", requestId)
        .eq("status", reqRow.status)
        .select("id")
        .maybeSingle();
      if (auditErr) return Response.json({ error: auditErr.message }, { status: 500 });
      if (!auditUpdated) return Response.json({ error: "Request state changed before this audit could be recorded." }, { status: 409 });
      return Response.json({ success: true, message: "Audit submitted and verified." });
    }

    if (action === "recordDeposit") {
      const auth = await requireRole(["buyer"]);
      if (auth instanceof Response) return auth;
      if (!requestId || !body.txHash) return Response.json({ error: "Missing parameters" }, { status: 400 });

      const supabase = getSupabaseServerClient();
      const { data: reqRow, error: fetchErr } = await supabase
        .from("sourcing_requests")
        .select("id, buyer_id, status, sourcing_fee_minor, platform_fee_minor")
        .eq("id", requestId)
        .maybeSingle();
      if (fetchErr || !reqRow) return Response.json({ error: "Sourcing request not found." }, { status: 404 });
      if (reqRow.buyer_id !== auth.user.id) {
        return Response.json({ error: "You are not the buyer for this request." }, { status: 403 });
      }
      try {
        assertTransition(reqRow.status as RequestStatus, "escrow");
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Invalid transition." }, { status: 409 });
      }

      // The deposit amount is derived from what THIS request was claimed
      // for (set server-side at claim time), never from the client's own
      // arithmetic — closes the same "trust a client-supplied amount" gap
      // CLAUDE.md's engineering rules call out by name.
      const totalMinor = (reqRow.sourcing_fee_minor ?? 0) + (reqRow.platform_fee_minor ?? 0);

      const { error: txErr } = await supabase.from("escrow_transactions").insert({
        sourcing_request_id: requestId,
        type: "deposit",
        amount_minor: totalMinor,
        tx_hash: body.txHash,
        initiated_by: auth.user.id,
      });
      if (txErr) return Response.json({ error: txErr.message }, { status: 500 });

      const { data: updated, error: updateErr } = await supabase
        .from("sourcing_requests")
        .update({ status: "escrow" })
        .eq("id", requestId)
        .eq("status", reqRow.status)
        .select("id")
        .maybeSingle();
      if (updateErr) return Response.json({ error: updateErr.message }, { status: 500 });
      if (!updated) return Response.json({ error: "Request state changed before this deposit could be recorded." }, { status: 409 });
      return Response.json({ success: true, message: "Escrow deposit recorded." });
    }

    if (action === "releaseEscrow") {
      const auth = await requireRole(["buyer"]);
      if (auth instanceof Response) return auth;
      if (!requestId) return Response.json({ error: "Missing requestId for release" }, { status: 400 });

      const supabase = getSupabaseServerClient();
      const { data: reqRecord } = await supabase.from("sourcing_requests").select("*").eq("id", requestId).maybeSingle();
      if (!reqRecord) return Response.json({ error: "Sourcing request not found." }, { status: 404 });
      // The single most serious gap Stage 4 closed: only the buyer who
      // owns the request can trigger release.
      if (reqRecord.buyer_id !== auth.user.id) {
        return Response.json({ error: "You are not the buyer for this request." }, { status: 403 });
      }
      // A gap Stage 4 DIDN'T catch because the old code had no status
      // precondition on this update at all: without this check, a buyer
      // could release funds on a request that was never verified.
      try {
        assertTransition(reqRecord.status as RequestStatus, "escrow_released");
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Invalid transition." }, { status: 409 });
      }

      const sourcerId = reqRecord.sourcer_id;
      const sourcingFeeMinor = reqRecord.sourcing_fee_minor ?? 0;
      if (!sourcerId) return Response.json({ error: "No sourcer is currently assigned to this request." }, { status: 400 });

      const { data: sourcerRecord } = await supabase.from("users").select("wallet_address").eq("id", sourcerId).maybeSingle();
      const sourcerWalletAddress = sourcerRecord?.wallet_address;
      if (!sourcerWalletAddress) return Response.json({ error: "The assigned sourcer does not have an active wallet." }, { status: 400 });

      let txHashValue = "0x" + crypto.randomBytes(32).toString("hex");
      const sourcingFeeDisplay = sourcingFeeMinor / 100;

      try {
        const client = initiateDeveloperControlledWalletsClient({ apiKey: CIRCLE_API_KEY!, entitySecret: process.env.CIRCLE_ENTITY_SECRET! });

        const balanceRes = await client.getWalletTokenBalance({ id: ESCROW_WALLET_ID! });
        const tokenBalances = balanceRes.data?.tokenBalances || [];
        const usdcToken = tokenBalances.find((tb) => tb.token?.symbol === "USDC");
        const usdcTokenId = usdcToken?.token?.id;

        if (!usdcTokenId) {
          throw new Error("USDC Token ID not found in Escrow Wallet balances.");
        }

        // NOT a Stage 4 or Stage 5 fix, left exactly as flagged during the
        // TypeScript migration: the real Circle SDK type wants `amount`
        // (singular), not `amounts`, and its response has no `txHash`
        // field at all — meaning this silently falls through to the
        // fabricated txHashValue above on every real (non-mocked) call.
        // This is money-moving code; per CLAUDE.md it stays flagged for
        // human review rather than "corrected" incidentally by an
        // unrelated stage.
        const txResponse = await client.createTransaction({
          walletId: ESCROW_WALLET_ID!,
          destinationAddress: sourcerWalletAddress,
          amounts: [sourcingFeeDisplay.toFixed(2)],
          tokenId: usdcTokenId,
          fee: { type: "level", config: { feeLevel: "LOW" } },
        } as unknown as Parameters<typeof client.createTransaction>[0]);

        const txData = txResponse.data as { txHash?: string } | undefined;
        if (txData?.txHash) {
          txHashValue = txData.txHash;
        }
      } catch (circleError) {
        console.error("❌ On-chain Escrow Release Failed! Details:", circleError);
      }

      const { error: txErr } = await supabase.from("escrow_transactions").insert({
        sourcing_request_id: requestId,
        type: "release",
        amount_minor: sourcingFeeMinor,
        tx_hash: txHashValue,
        initiated_by: auth.user.id,
      });
      if (txErr) return Response.json({ error: txErr.message }, { status: 500 });

      const { data: released, error: releaseErr } = await supabase
        .from("sourcing_requests")
        .update({ status: "escrow_released" })
        .eq("id", requestId)
        .eq("status", reqRecord.status)
        .select("id")
        .maybeSingle();
      if (releaseErr) return Response.json({ error: releaseErr.message }, { status: 500 });
      if (!released) return Response.json({ error: "Request state changed before release could be recorded." }, { status: 409 });

      await logAudit({ actorEmail: auth.user.email, action: "escrow_released", target: String(requestId), details: { sourcerId, amountMinor: sourcingFeeMinor }, request });
      return Response.json({ success: true, message: "Escrow funds programmatically released on-chain!" });
    }

    if (action === "clearSourcingPayment") {
      const auth = await requireRole(["sourcer"]);
      if (auth instanceof Response) return auth;
      if (!requestId) return Response.json({ error: "Missing requestId" }, { status: 400 });

      const supabase = getSupabaseServerClient();
      const { data: updated, error: updateErr } = await supabase
        .from("sourcing_requests")
        .update({ cleared_by_sourcer: true, cleared_at: new Date().toISOString() })
        .eq("id", requestId)
        .eq("sourcer_id", auth.user.id)
        .select("id")
        .maybeSingle();
      if (updateErr) return Response.json({ error: updateErr.message }, { status: 500 });
      if (!updated) return Response.json({ error: "You are not the assigned sourcer for this request." }, { status: 403 });
      return Response.json({ success: true, message: "Payment cleared." });
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Escrow API error:", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
