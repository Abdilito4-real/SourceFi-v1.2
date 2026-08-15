// components/JitsiMeetRoom.tsx
import React from "react";

export default function JitsiMeetRoom({ requestCode }: { requestCode: string }) {
  return (
    <div className="mt-3 flex h-[280px] w-full flex-col overflow-hidden rounded-xl border border-border bg-black">
      <div className="flex items-center gap-1.5 bg-surface px-3 py-2 font-mono text-[11.5px] text-text-primary">
        <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-accent" />
        Secure Video Workspace Active (GPS & Media Enabled)
      </div>
      <iframe
        title={`SourceFi verification call for ${requestCode}`}
        allow="camera; microphone; fullscreen; display-capture; autoplay; geolocation"
        src={`https://meet.jit.si/SourceFi_${requestCode}#config.prejoinPageEnabled=false&interfaceConfig.TOOLBAR_BUTTONS=["microphone","camera","fullscreen","hangup","chat"]`}
        className="w-full flex-1 border-0"
      />
    </div>
  );
}
