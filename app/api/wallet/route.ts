// app/api/wallet/route.ts
//
// Buyer's platform wallet balance (migration 0020_buyer_wallet.sql).
import { getUserScopedOrFallbackClient } from "../../../lib/supabaseUserClient";
import { requireRole } from "../../../lib/authz";
import { getWalletBalance } from "../../../lib/walletService";

export async function GET() {
  const auth = await requireRole(["buyer"]);
  if (auth instanceof Response) return auth;

  // RLS pilot expansion (0021_rls_expand_pilot.sql): a genuine
  // self-only `authenticated`-role read, backed by
  // buyer_wallets_select_own. getWalletBalance is a pure SELECT (see
  // lib/walletService.ts), safe to hand this instead of the
  // service-role client.
  const supabase = await getUserScopedOrFallbackClient(auth.user.id);
  const { balanceMinor } = await getWalletBalance(supabase, auth.user.id);
  return Response.json({ balanceMinor });
}
