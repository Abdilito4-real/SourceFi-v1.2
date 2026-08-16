// app/api/notification-preferences/route.ts
//
// "Give a preferences screen and honour it server-side, not just in the
// client", this route IS the honouring: lib/notifications/dispatch.ts
// reads these same rows before every push attempt, not just the client
// hiding a toggle. No `security` field anywhere here, on purpose, that
// category is not opt-out (migration 0009's comment).
import { getSupabaseServerClient } from "../../../lib/supabaseServer";
import { requireRole } from "../../../lib/authz";

const TOGGLE_KEYS = ["job_availability", "escrow_payment", "audit_status", "disputes"] as const;

const DEFAULTS = {
  job_availability: true,
  escrow_payment: true,
  audit_status: true,
  disputes: true,
  timezone: "Africa/Lagos",
  quiet_hours_start_local: 21,
  quiet_hours_end_local: 7,
};

export async function GET() {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const supabase = getSupabaseServerClient();
  const { data } = await supabase.from("notification_preferences").select("*").eq("user_id", auth.user.id).maybeSingle();

  return Response.json({ preferences: data ? { ...DEFAULTS, ...data } : { user_id: auth.user.id, ...DEFAULTS } });
}

export async function PATCH(request: Request) {
  const auth = await requireRole(["buyer", "supplier", "admin"]);
  if (auth instanceof Response) return auth;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "Invalid request body." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  for (const key of TOGGLE_KEYS) {
    if (typeof body[key] === "boolean") patch[key] = body[key];
  }
  if (typeof body.timezone === "string" && body.timezone.trim()) {
    try {
      // Cheapest real validation available: ask Intl to format with it
      // throws RangeError on an unrecognized IANA zone name.
      new Intl.DateTimeFormat("en-US", { timeZone: body.timezone }).format(new Date());
      patch.timezone = body.timezone.trim();
    } catch {
      return Response.json({ error: "Unrecognized timezone." }, { status: 400 });
    }
  }
  if (Number.isInteger(body.quietHoursStartLocal) && body.quietHoursStartLocal >= 0 && body.quietHoursStartLocal <= 23) {
    patch.quiet_hours_start_local = body.quietHoursStartLocal;
  }
  if (Number.isInteger(body.quietHoursEndLocal) && body.quietHoursEndLocal >= 0 && body.quietHoursEndLocal <= 23) {
    patch.quiet_hours_end_local = body.quietHoursEndLocal;
  }

  if (Object.keys(patch).length === 0) return Response.json({ error: "Nothing to update." }, { status: 400 });

  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert({ user_id: auth.user.id, ...patch }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) return Response.json({ error: "Failed to update preferences." }, { status: 500 });
  return Response.json({ preferences: { ...DEFAULTS, ...data } });
}
