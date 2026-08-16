"use client";

// components/JitsiMeetRoom.tsx
//
// A shared live video room for the buyer and supplier to verify a
// delivery together in real time, before the buyer decides to release
// funds, reused from the pre-pivot field-agent verification flow (was
// orphaned/unused since that flow was retired). Room name is `roomId`
// a server-generated crypto.randomUUID() (migration 0008), fetched only
// from the ownership-checked order-detail route, NOT the order code.
// order_code is a 6-digit, user-visible, guessable string; anyone who
// knew or brute-forced SourceFi_<order_code> could join a "private" call
// directly on meet.jit.si, which has no concept of who our buyer/
// supplier are and enforces nothing on its own. roomId is what actually
// makes this private: both parties land in the same room with nothing
// to coordinate, and nobody else can guess it.
//
// Uses Jitsi's real IFrame External API (external_api.js), not a plain
// <iframe src=...>, specifically so `onSegmentComplete` reports GENUINE
// join-to-leave call time, this call is mandatory before approval
// (lib/orderService.ts's MIN_VERIFICATION_CALL_SECONDS, enforced
// server-side), so "the panel was visible on screen" is not an
// acceptable proxy for "a call actually happened." A raw iframe has no
// way to know that; the External API's videoConferenceJoined /
// videoConferenceLeft events do.
//
// meet.jit.si is Jitsi's free public server, no API key, no account, no
// per-minute cost. Right call for a hackathon timeline; a self-hosted
// instance or a paid provider (Daily, Twilio Video) is the natural
// upgrade if this needs recording/moderation/guaranteed uptime later.
import React, { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, options: Record<string, unknown>) => JitsiMeetAPI;
  }
}

interface JitsiMeetAPI {
  addEventListener: (event: string, handler: (...args: unknown[]) => void) => void;
  dispose: () => void;
}

const JITSI_DOMAIN = "meet.jit.si";
const SCRIPT_SRC = `https://${JITSI_DOMAIN}/external_api.js`;

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface JitsiMeetRoomProps {
  /** The private room name, a crypto.randomUUID(), never the guessable
   * order_code. Only ever supplied to the buyer and assigned supplier
   * (see app/api/orders/[id]/route.ts). */
  roomId: string;
  /** Display-only label shown in the panel header (the order code)
   * never used to construct the actual Jitsi room name. */
  displayLabel: string;
  /** Fired once, when a join-to-leave segment ends, with the real
   * elapsed seconds for that segment, the caller is responsible for
   * reporting it to the server (POST /api/orders/[id]/call-progress). */
  onSegmentComplete: (seconds: number) => void;
}

export default function JitsiMeetRoom({ roomId, displayLabel, onSegmentComplete }: JitsiMeetRoomProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<JitsiMeetAPI | null>(null);
  const joinedAtRef = useRef<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [liveElapsed, setLiveElapsed] = useState(0);

  useEffect(() => {
    let cancelled = false;

    function reportSegmentIfJoined() {
      if (joinedAtRef.current === null) return;
      const seconds = Math.round((Date.now() - joinedAtRef.current) / 1000);
      joinedAtRef.current = null;
      setInCall(false);
      if (seconds > 0) onSegmentComplete(seconds);
    }

    function init() {
      if (cancelled || !containerRef.current || !window.JitsiMeetExternalAPI) return;
      // Defensive: if external_api.js loaded but the constructor itself
      // throws (a malformed room name, a Jitsi-side error, a version
      // mismatch), fall back to the same friendly error state as a failed
      // script load, the alternative is an unstyled DOM fragment or raw
      // error text sitting inside the call panel instead of a real call.
      try {
        const api = new window.JitsiMeetExternalAPI!(JITSI_DOMAIN, {
          roomName: `SourceFi_${roomId}`,
          parentNode: containerRef.current,
          width: "100%",
          height: "100%",
          configOverwrite: { prejoinPageEnabled: false },
          interfaceConfigOverwrite: { TOOLBAR_BUTTONS: ["microphone", "camera", "fullscreen", "hangup", "chat"] },
        });
        apiRef.current = api;

        api.addEventListener("videoConferenceJoined", () => {
          joinedAtRef.current = Date.now();
          setInCall(true);
        });
        api.addEventListener("videoConferenceLeft", reportSegmentIfJoined);
        api.addEventListener("readyToClose", reportSegmentIfJoined);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    }

    if (window.JitsiMeetExternalAPI) {
      init();
    } else {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      const script = existing ?? document.createElement("script");
      if (!existing) {
        script.src = SCRIPT_SRC;
        script.async = true;
        document.body.appendChild(script);
      }
      script.addEventListener("load", init);
      script.addEventListener("error", () => !cancelled && setLoadError(true));
    }

    return () => {
      cancelled = true;
      // A segment still in progress when the component unmounts (buyer
      // closed the modal mid-call) still counts, report it rather than
      // silently dropping that time.
      reportSegmentIfJoined();
      apiRef.current?.dispose();
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // A visible ticking timer while actually in-call, the live version of
  // what onSegmentComplete reports once the segment ends.
  useEffect(() => {
    if (!inCall) {
      setLiveElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      if (joinedAtRef.current !== null) setLiveElapsed(Math.round((Date.now() - joinedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [inCall]);

  return (
    <div className="mt-3 flex h-[320px] w-full flex-col overflow-hidden rounded-xl border border-border bg-black">
      <div className="flex items-center justify-between bg-surface px-3 py-2 font-mono text-[11.5px] text-text-primary">
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${inCall ? "pulse-dot bg-success" : "bg-text-tertiary"}`} />
          {inCall ? `In call: ${formatDuration(liveElapsed)}` : `Verification call: ${displayLabel}`}
        </span>
      </div>
      {loadError ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-white/70">
          Couldn't load the video call. Check your connection and reopen this order to try again.
        </div>
      ) : (
        <div ref={containerRef} className="w-full flex-1" />
      )}
    </div>
  );
}
