"use client";

// components/JitsiMeetRoom.tsx
//
// A shared live video room for the buyer and supplier to verify a
// delivery together in real time, before the buyer decides to release
// funds — reused from the pre-pivot field-agent verification flow
// (was orphaned/unused since that flow was retired; this is the same
// component, just re-wired into the new order flow instead of a
// field-agent handshake). Room name is derived from the order code, so
// both parties land in the same room with nothing to coordinate or share
// beyond "open this order."
//
// meet.jit.si is Jitsi's free public server — no API key, no account, no
// per-minute cost. That's the right call for a hackathon timeline; if
// this needs to scale or needs recording/moderation controls later, a
// self-hosted Jitsi instance or a paid provider (Daily, Twilio Video) is
// the natural upgrade, not a decision made here.
import React from "react";

export default function JitsiMeetRoom({ orderCode }: { orderCode: string }) {
  return (
    <div className="mt-3 flex h-[320px] w-full flex-col overflow-hidden rounded-xl border border-border bg-black">
      <div className="flex items-center gap-1.5 bg-surface px-3 py-2 font-mono text-[11.5px] text-text-primary">
        <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-accent" />
        Live verification call — {orderCode}
      </div>
      <iframe
        title={`SourceFi verification call for ${orderCode}`}
        allow="camera; microphone; fullscreen; display-capture; autoplay"
        src={`https://meet.jit.si/SourceFi_${orderCode}#config.prejoinPageEnabled=false&interfaceConfig.TOOLBAR_BUTTONS=["microphone","camera","fullscreen","hangup","chat"]`}
        className="w-full flex-1 border-0"
      />
    </div>
  );
}
