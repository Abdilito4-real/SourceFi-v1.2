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
// per-minute cost, but it gates a brand-new/empty room behind a "log in
// to become a moderator, otherwise wait" screen on its shared multi-
// tenant infrastructure. `callConfig` (see lib/jaasAuth.ts) is the
// upgrade: a signed JWT from 8x8 JaaS removes that gate entirely by
// authenticating this app's own tenant as the moderator, no separate
// login step for either party. Falls back to the plain meet.jit.si
// join, unchanged, whenever callConfig is null (JaaS not configured).
import React, { useEffect, useRef, useState } from "react";
import type { JaasCallConfig } from "../lib/types";

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

const HEARTBEAT_MS = 20_000;

export interface JitsiMeetRoomProps {
  /** The private room name, a crypto.randomUUID(), never the guessable
   * order_code. Only ever supplied to the buyer and assigned supplier
   * (see app/api/orders/[id]/route.ts). */
  roomId: string;
  /** Display-only label shown in the panel header (the order code)
   * never used to construct the actual Jitsi room name. */
  displayLabel: string;
  /** Shown to the OTHER participant inside the call, e.g. "SourceFi
   * Buyer". Passed explicitly so Jitsi never falls back to a cached
   * name from a prior meet.jit.si visit on this browser, or its own
   * "enter your name" prompt, that's the actual "have to log in"
   * friction this removes, prejoinPageEnabled alone doesn't. */
  displayName: string;
  /** Fired once, when a join-to-leave segment ends, with the real
   * elapsed seconds for that segment, the caller is responsible for
   * reporting it to the server (POST /api/orders/[id]/call-progress). */
  onSegmentComplete: (seconds: number) => void;
  /** Fired the instant this party joins/leaves, for the OTHER party's
   * incoming-call prompt (POST /api/orders/[id]/call-presence), not
   * the total-duration bookkeeping onSegmentComplete handles. */
  onJoined?: () => void;
  onLeft?: () => void;
  /** From GET /api/orders/[id], see lib/jaasAuth.ts. Undefined/null uses
   * the free meet.jit.si join this component always had. */
  callConfig?: JaasCallConfig | null;
}

export default function JitsiMeetRoom({ roomId, displayLabel, displayName, onSegmentComplete, onJoined, onLeft, callConfig }: JitsiMeetRoomProps) {
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
      onLeft?.();
    }

    // Captured once per effect run (roomId change), not a dependency:
    // callConfig carries a freshly-minted JWT on every order-detail
    // fetch (this modal polls every ~8s for the incoming-call banner),
    // re-running this effect on every poll would tear down and rebuild
    // the live call constantly. The JWT's 1h expiry comfortably outlives
    // one call session either way.
    const domain = callConfig?.domain ?? JITSI_DOMAIN;
    const scriptSrc = `https://${domain}/external_api.js`;
    const roomName = callConfig?.roomName ?? `SourceFi_${roomId}`;

    function init() {
      if (cancelled || !containerRef.current || !window.JitsiMeetExternalAPI) return;
      // Defensive: if external_api.js loaded but the constructor itself
      // throws (a malformed room name, a Jitsi-side error, a version
      // mismatch), fall back to the same friendly error state as a failed
      // script load, the alternative is an unstyled DOM fragment or raw
      // error text sitting inside the call panel instead of a real call.
      try {
        const api = new window.JitsiMeetExternalAPI!(domain, {
          roomName,
          parentNode: containerRef.current,
          width: "100%",
          height: "100%",
          userInfo: { displayName },
          ...(callConfig ? { jwt: callConfig.jwt } : {}),
          configOverwrite: {
            prejoinPageEnabled: false,
            // Newer Jitsi/JaaS builds moved this under a nested config
            // object, prejoinPageEnabled alone left a "Join meeting"
            // device-check screen showing up in practice. Setting both
            // covers whichever schema this deployment is actually on.
            prejoinConfig: { enabled: false },
            requireDisplayName: false,
            disableDeepLinking: true,
            enableWelcomePage: false,
            disableInviteFunctions: true,
            // prejoinPageEnabled: false skips the screen that would
            // normally let someone choose their mic/camera state before
            // joining, without these, that choice silently falls back to
            // whatever Jitsi/JaaS's own default is, in practice showing
            // up as "granted camera/mic access in the browser, but the
            // call still starts muted and blank" since permission and
            // mute state are two different things. Force both on.
            startWithAudioMuted: false,
            startWithVideoMuted: false,
          },
          interfaceConfigOverwrite: {
            // toggle-camera is Jitsi's built-in front/back camera swap,
            // only actually renders as a button on a device that reports
            // more than one camera (mobile), harmless no-op button-less
            // on desktop.
            TOOLBAR_BUTTONS: ["microphone", "camera", "toggle-camera", "fullscreen", "hangup", "chat"],
          },
        });
        apiRef.current = api;

        api.addEventListener("videoConferenceJoined", () => {
          joinedAtRef.current = Date.now();
          setInCall(true);
          onJoined?.();
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
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${scriptSrc}"]`);
      const script = existing ?? document.createElement("script");
      if (!existing) {
        script.src = scriptSrc;
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

  // Re-stamps presence while actually in-call, so a crashed/killed tab
  // (which never fires videoConferenceLeft) still goes stale server-side
  // within HEARTBEAT_MS + the reader's own staleness window, instead of
  // showing the other party as "in the call" forever.
  useEffect(() => {
    if (!inCall) return;
    const heartbeat = setInterval(() => onJoined?.(), HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
