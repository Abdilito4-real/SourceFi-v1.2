"use client";

// components/IncomingCallBanner.tsx
//
// The "even in the background" counterpart to OrderDetailsModal.tsx's
// own incoming-call banner: that one only exists while the specific
// order's modal happens to already be open, this one polls across every
// order this account is a party to, so it shows up from the dashboard
// overview, a different section, anywhere in the app, not just the one
// screen someone happened to have open. A push notification (see
// worker/index.ts) is still the real "reaches you with the app fully
// closed" mechanism, this is for "the app's open, but not looking at
// this order right now."
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Video } from "lucide-react";
import Button from "./ui/Button";
import { playIncomingCallChime } from "../lib/callSound";
import type { Role } from "../lib/types";

const POLL_MS = 10_000;

interface IncomingOrder {
  id: number;
  order_code: string;
  title: string;
}

export default function IncomingCallBanner({ role }: { role: Role }) {
  const router = useRouter();
  const [order, setOrder] = useState<IncomingOrder | null>(null);
  const [dismissedOrderId, setDismissedOrderId] = useState<number | null>(null);
  const prevOrderIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (role !== "buyer" && role !== "supplier") return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/orders/incoming-calls");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const next: IncomingOrder | null = data.order ?? null;
        const nextId = next?.id ?? null;
        if (nextId !== null && nextId !== prevOrderIdRef.current) {
          // A genuinely new incoming call (not the same one still
          // ringing from the last poll), announce it once.
          playIncomingCallChime();
        }
        prevOrderIdRef.current = nextId;
        setOrder(next);
      } catch {
        /* best-effort background polling, a network blip just means no banner this tick */
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [role]);

  if (!order || order.id === dismissedOrderId) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-5 z-[1050] mx-auto flex max-w-sm items-center gap-3 rounded-xl border border-accent bg-accent-soft p-4 shadow-lg sm:inset-x-auto sm:right-5"
    >
      <Video size={18} className="pulse-dot shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-accent-text">Incoming verification call</p>
        <p className="mt-0.5 truncate text-xs text-text-secondary">{order.title || order.order_code}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            setDismissedOrderId(order.id);
            router.push(`/${role}?order=${order.id}&call=1`);
          }}
        >
          Join
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissedOrderId(order.id)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
