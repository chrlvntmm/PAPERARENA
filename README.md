// Lightweight Web Audio API sound effects. No external assets.
// Safely initializes on first user gesture to comply with autoplay policies.

let ctx: AudioContext | null = null;
let unlocked = false;
let isMuted = false;

export function setMuted(v: boolean) {
  isMuted = v;
}

export function getMuted(): boolean {
  return isMuted;
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  unlocked = true;
  // play a silent buffer to fully unlock on iOS/Safari
  try {
    const buf = c.createBuffer(1, 1, 22050);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* noop */
  }
}

export function installAudioUnlock() {
  if (typeof window === "undefined") return;
  const handler = () => {
    unlockAudio();
    window.removeEventListener("pointerdown", handler);
    window.removeEventListener("keydown", handler);
    window.removeEventListener("touchstart", handler);
  };
  window.addEventListener("pointerdown", handler, { once: true });
  window.addEventListener("keydown", handler, { once: true });
  window.addEventListener("touchstart", handler, { once: true });
}

function tone(
  c: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  opts: { type?: OscillatorType; gain?: number; freqEnd?: number } = {},
) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, startAt);
  if (opts.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(0.0001, opts.freqEnd), startAt + duration);
  }
  const peak = opts.gain ?? 0.18;
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(peak, startAt + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(g).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

export function playClickSound() {
  if (isMuted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  tone(c, 800, t, 0.05, { type: "square", gain: 0.08, freqEnd: 200 });
}

export function playLoseSound() {
  if (isMuted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // descending minor sweep + low rumble
  tone(c, 440, t, 0.5, { type: "sawtooth", gain: 0.12, freqEnd: 110 });
  tone(c, 220, t + 0.05, 0.6, { type: "sine", gain: 0.14, freqEnd: 70 });
  tone(c, 330, t + 0.1, 0.45, { type: "triangle", gain: 0.08, freqEnd: 90 });
}

export function playWinSound() {
  if (isMuted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // C major arpeggio C E G C ascending
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    tone(c, f, t + i * 0.09, 0.22, { type: "triangle", gain: 0.16 });
  });
  // sparkle on top
  tone(c, 1568, t + notes.length * 0.09, 0.35, { type: "sine", gain: 0.1 });
}

export function playTerritoryPing() {
  if (isMuted) return;
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  // High-pitched, very short digital chime
  tone(c, 1400, t, 0.08, { type: "sine", gain: 0.06 });
  tone(c, 2800, t, 0.06, { type: "sine", gain: 0.02 });
}
