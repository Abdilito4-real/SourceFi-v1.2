// lib/notifications/dispatch.ts
//
// The one place a push-worthy event turns into (a) an in-app notification
// row, ALWAYS written, this is the part of the system that must stay
// correct even if push never arrives at all, and (b) a best-effort push
// send to every device subscription for that user, gated by their
// category preferences, quiet hours, and a per-user rate limit, plus (c)
// email for events the caller marks `critical` (dispute filed, funds
// released, "Critical financial events additionally go by email").
//
// Never throws: every call site fires this AFTER its own write already
// succeeded, fire-and-forget, a notification failure must never unwind
// or mask the order/dispute/etc. mutation that triggered it.
//
// PAYLOAD SECURITY (feedback-layer rule, critical): title/body here are
// what render on a lock screen. Callers must NEVER pass an amount, wallet
// address, full name, or supplier/buyer identifying detail in either
// "Escrow update, tap to view", not "Ubaidu released ₦1,500,000 to your
// wallet". This module does not (and cannot) sanitize that for a caller;
// every call site in lib/orderService.ts and the admin routes is written
// to already satisfy it, see their own comments at each notifyUser()
// call for why the specific copy there is safe.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushToSubscription, type PushSubscriptionRow } from "./webPush";
import { sendCriticalEmail } from "./emailProvider";

export type NotificationCategory = "job_availability" | "escrow_payment" | "audit_status" | "disputes" | "security";

export interface NotifyInput {
  userId: number;
  category: NotificationCategory;
  eventType: string;
  resourceType?: string | null;
  resourceId?: number | null;
  /** Lock-screen-safe, see this file's top comment. */
  title: string;
  body: string;
  deepLink?: string | null;
  /** Bypasses quiet hours only, never bypasses an opted-out preference or
   * the rate limit. "Critical events (dispute filed, funds released)
   * bypass quiet hours." Also the flag that triggers the email fallback. */
  critical?: boolean;
  /** Collapses/replaces a prior notification with the same tag instead of
   * stacking, both for push (native `tag` option) and for finding "the
   * latest about this" in-app. Defaults to
   * `${category}:${resourceType}:${resourceId}`. */
  tag?: string;
}

const MAX_PUSHES_PER_USER_PER_HOUR = 20;

interface Prefs {
  timezone: string;
  quiet_hours_start_local: number;
  quiet_hours_end_local: number;
  job_availability: boolean;
  escrow_payment: boolean;
  audit_status: boolean;
  disputes: boolean;
}

const DEFAULT_PREFS: Prefs = {
  timezone: "Africa/Lagos",
  quiet_hours_start_local: 21,
  quiet_hours_end_local: 7,
  job_availability: true,
  escrow_payment: true,
  audit_status: true,
  disputes: true,
};

async function loadPrefs(supabase: SupabaseClient, userId: number): Promise<Prefs> {
  const { data } = await supabase.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle();
  // No row yet = every default applies, matches what INSERTing a fresh
  // row with the migration's column defaults would produce, so "no row"
  // and "a row with every default value" behave identically.
  return data ? { ...DEFAULT_PREFS, ...data } : DEFAULT_PREFS;
}

function categoryEnabled(prefs: Prefs, category: NotificationCategory): boolean {
  if (category === "security") return true; // not opt-out, see migration 0009
  return prefs[category] !== false;
}

function withinQuietHours(prefs: Prefs): boolean {
  const { timezone, quiet_hours_start_local: start, quiet_hours_end_local: end } = prefs;
  if (start === end) return false; // zero-width window = quiet hours effectively off

  let localHour: number;
  try {
    localHour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(new Date())
    );
  } catch {
    return false; // unrecognized timezone string, fail OPEN (deliver) rather than silently swallow every push over a bad setting
  }

  if (start < end) return localHour >= start && localHour < end;
  return localHour >= start || localHour < end; // wraps midnight, e.g. 21 -> 7
}

async function underRateLimit(supabase: SupabaseClient, userId: number): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("pushed_at", "is", null)
    .gte("pushed_at", oneHourAgo);
  return (count ?? 0) < MAX_PUSHES_PER_USER_PER_HOUR;
}

export async function notifyUser(supabase: SupabaseClient, input: NotifyInput): Promise<void> {
  try {
    const tag = input.tag ?? `${input.category}:${input.resourceType ?? "none"}:${input.resourceId ?? "none"}`;

    // (a) Always write the in-app row first, this is the part that must
    // stay correct even if every push/email attempt below fails or is
    // deliberately skipped.
    const { data: row, error } = await supabase
      .from("notifications")
      .insert({
        user_id: input.userId,
        category: input.category,
        event_type: input.eventType,
        resource_type: input.resourceType ?? null,
        resource_id: input.resourceId ?? null,
        title: input.title,
        body: input.body,
        deep_link: input.deepLink ?? null,
        tag,
      })
      .select("id")
      .single();
    if (error || !row) {
      console.error("notifyUser: failed to write in-app notification row:", error);
      return;
    }

    const prefs = await loadPrefs(supabase, input.userId);
    if (!categoryEnabled(prefs, input.category)) return;

    if (input.category !== "security") {
      const okRate = await underRateLimit(supabase, input.userId);
      if (!okRate) return;

      if (!input.critical && withinQuietHours(prefs)) return;
    }

    // (b) Push, best-effort, per device subscription.
    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", input.userId);

    if (subs && subs.length > 0) {
      const payload = {
        category: input.category,
        eventType: input.eventType,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        notificationId: row.id as number,
        tag,
        title: input.title,
        body: input.body,
        deepLink: input.deepLink ?? null,
      };

      const deadIds: number[] = [];
      let sentAny = false;
      await Promise.all(
        (subs as PushSubscriptionRow[]).map(async (sub) => {
          const result = await sendPushToSubscription(sub, payload);
          if (result === "gone") deadIds.push(sub.id);
          if (result === "ok") sentAny = true;
        })
      );

      if (deadIds.length > 0) {
        await supabase.from("push_subscriptions").delete().in("id", deadIds);
      }
      if (sentAny) {
        await supabase.from("notifications").update({ pushed_at: new Date().toISOString() }).eq("id", row.id);
      }
    }

    // (c) Email fallback for critical events, independent of whether
    // push was subscribed, enabled, sent, or even attempted. "The system
    // must be correct if push never arrives at all" applies to critical
    // events reaching the user at all, not just the in-app row existing.
    if (input.critical) {
      const { data: user } = await supabase.from("users").select("email").eq("id", input.userId).maybeSingle();
      if (user?.email) {
        await sendCriticalEmail({ to: user.email, subject: input.title, body: input.body, deepLink: input.deepLink ?? null });
      }
    }
  } catch (err) {
    console.error("notifyUser failed:", err);
  }
}

/** Fans a notification out to every current admin, used for disputes
 * where "who should know" is "whoever's on admin duty", not one specific
 * user. Each admin gets their own in-app row, own push gating, own
 * quiet-hours/rate-limit check, this is N independent notifyUser() calls
 * not a single broadcast row. */
export async function notifyAdmins(supabase: SupabaseClient, input: Omit<NotifyInput, "userId">): Promise<void> {
  try {
    const { data: admins } = await supabase.from("users").select("id").eq("role", "admin");
    if (!admins || admins.length === 0) return;
    await Promise.all(admins.map((admin) => notifyUser(supabase, { ...input, userId: admin.id as number })));
  } catch (err) {
    console.error("notifyAdmins failed:", err);
  }
}
