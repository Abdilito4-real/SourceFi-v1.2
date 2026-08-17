// lib/callSound.ts
//
// A short two-tone chime for "the other party just joined the call",
// synthesized with the Web Audio API instead of a bundled audio file,
// one less asset to ship, one less request. Browsers block audio
// without a prior user gesture on the page, this is expected to run
// while the user is actively looking at an order they've already
// interacted with, not on page load, so playing it is best-effort: a
// blocked AudioContext just means silence, never a thrown error the
// caller has to handle.
export function playIncomingCallChime(): void {
  try {
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();

    const playTone = (frequency: number, startAt: number, durationSeconds: number) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // Quick fade in/out avoids an audible click at the start/end of each tone.
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(0.2, startAt + 0.02);
      gain.gain.linearRampToValueAtTime(0, startAt + durationSeconds);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + durationSeconds);
    };

    const now = ctx.currentTime;
    playTone(720, now, 0.16);
    playTone(960, now + 0.18, 0.22);

    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    /* best-effort only, a missed chime is not worth surfacing an error for */
  }
}
