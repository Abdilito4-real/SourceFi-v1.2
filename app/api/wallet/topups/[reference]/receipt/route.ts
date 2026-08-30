// app/api/wallet/topups/[reference]/receipt/route.ts
//
// Self-only — a buyer's own confirmed top-up, looked up by its
// provider_reference. lib/receiptService.ts's getTopupReceipt already
// scopes the query to userId, this route just supplies it from the
// session, never a client-supplied id.
import { requireRole } from "../../../../../../lib/authz";
import { getUserScopedOrFallbackClient } from "../../../../../../lib/supabaseUserClient";
import { getTopupReceipt, ReceiptNotFoundError } from "../../../../../../lib/receiptService";
import { renderReceiptPdf } from "../../../../../../lib/receiptPdf";

export async function GET(request: Request, { params }: { params: Promise<{ reference: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const { reference } = await params;
  const { searchParams } = new URL(request.url);

  // RLS pilot (0021_rls_expand_pilot.sql's wallet_transactions_select_own,
  // already existed via migration 0020, just newly wired to a route
  // here): a genuine self-only authenticated-role read.
  const supabase = await getUserScopedOrFallbackClient(auth.user.id);

  try {
    const receipt = await getTopupReceipt(supabase, auth.user.id, reference);
    if (searchParams.get("format") === "pdf") {
      const pdf = await renderReceiptPdf(receipt);
      return new Response(new Uint8Array(pdf), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="topup-${reference}-receipt.pdf"` },
      });
    }
    return Response.json({ receipt });
  } catch (err) {
    if (err instanceof ReceiptNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
