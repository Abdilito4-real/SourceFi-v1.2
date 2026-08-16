import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// This client uses the SECRET key and must only ever be imported inside
// API routes (server-side code), never in a component that runs in the
// browser. `server-only` (Prompt 4, M2) turns an accidental client import
// into a build-time error instead of a silent bundle leak, the same
// mistake almost happened with lib/orderService.ts in Prompt 3, caught
// only because that file's Node-only `crypto` import broke the build; not
// every server module gets that kind of accidental tripwire.
export function getSupabaseServerClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    // Fails loudly rather than handing createClient an undefined URL, which
    // would otherwise throw a much less useful error deeper inside the
    // Supabase client the first time a query actually runs.
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set them in .env.local."
    );
  }

  return createClient(url, serviceRoleKey);
}
