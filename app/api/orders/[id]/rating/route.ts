// app/api/orders/[id]/rating/route.ts
//
// Buyer rates a settled order — 1-5, optional comment (design doc
// Section 6). Only usable once, only after settlement. The rating is
// written to the DB immediately (as a cache) but on_chain_confirmed_at
// stays null until the payment layer's on-chain write actually confirms
// — with StubPaymentProvider that's forever, on purpose (Open Question
// 10 — no real contract decided yet), so this rating won't count toward
// the supplier's public aggregate until a real integration exists.
import { getSupabaseServerClient } from "../../../../../lib/supabaseServer";
import { requireRole } from "../../../../../lib/authz";
import { getPaymentProvider } from "../../../../../lib/paymentProvider";
import { submitRating, NotOrderOwnerError, OrderNotFoundError } from "../../../../../lib/orderService";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Invalid order id." }, { status: 400 });

  const body = await request.json().catch(() => null);
  const score = Number(body?.score);
  const comment = typeof body?.comment === "string" ? body.comment.trim().slice(0, 1000) || null : null;

  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return Response.json({ error: "score must be an integer between 1 and 5." }, { status: 400 });
  }

  const supabase = getSupabaseServerClient();

  try {
    const result = await submitRating(supabase, getPaymentProvider(), orderId, auth.user.id, score as 1 | 2 | 3 | 4 | 5, comment);
    return Response.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof OrderNotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof NotOrderOwnerError) return Response.json({ error: err.message }, { status: 403 });
    return Response.json({ error: err instanceof Error ? err.message : "Failed to submit rating." }, { status: 500 });
  }
}
