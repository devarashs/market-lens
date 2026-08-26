/* Tape audio, aggr.trade-style: the flow as sound, so the tool works with
   your eyes elsewhere. Design goals — musical (pentatonic degrees only, so
   overlapping blips can't be dissonant), informative (size → register:
   bigger prints sit lower and last longer; buys ring brighter than sells),
   and restrained (rate-limited, quiet, silent in hidden tabs).

   Split: `soundParams` is pure and unit-tested; `play*` touch WebAudio. */

export interface SoundParams {
  frequency: number;   // Hz
  duration: number;    // seconds
  gain: number;        // 0..1 master-relative
  type: OscillatorType;
  /** Optional pitch glide target (liquidations wail; trades don't). */
  glideTo?: number;
}

/* A-minor pentatonic degrees (semitone offsets) — any subset sounds fine
   together, which is the whole trick. */
const PENTATONIC = [0, 3, 5, 7, 10];

function noteHz(baseHz: number, degreesDown: number): number {
  const octaves = Math.floor(degreesDown / PENTATONIC.length);
  const step = PENTATONIC[degreesDown % PENTATONIC.length];
  return baseHz / 2 ** octaves / 2 ** (step / 12);
}

/** magnitude = notional / current threshold (≥1 by the caller's gate).
    Bigger → lower note, longer ring, more gain. Buys ring a sine an octave
    above sells' triangle — instantly tellable apart at any size. */
export function soundParams(side: "buy" | "sell", magnitude: number): SoundParams {
  const degreesDown = Math.min(9, Math.floor(Math.log2(Math.max(magnitude, 1)) * 2));
  const base = side === "buy" ? 880 : 440;
  return {
    frequency: noteHz(base, degreesDown),
    duration: Math.min(0.5, 0.09 + Math.sqrt(magnitude) * 0.06),
    gain: Math.min(0.16, 0.035 + Math.sqrt(magnitude) * 0.02),
    type: side === "buy" ? "sine" : "triangle",
  };
}

/** Liquidations wail instead of ring: longs dying glide DOWN, shorts dying
    glide UP — direction of the forced flow, audible. Sawtooth so it cuts
    through the tape blips. */
export function liquidationParams(side: "long" | "short", magnitude: number): SoundParams {
  const start = side === "long" ? 660 : 330;
  return {
    frequency: start,
    glideTo: side === "long" ? start / 2 : start * 2,
    duration: Math.min(0.7, 0.25 + Math.sqrt(magnitude) * 0.08),
    gain: Math.min(0.2, 0.06 + Math.sqrt(magnitude) * 0.03),
    type: "sawtooth",
  };
}

// ------------------------------------------------------------- playback

let audioContext: AudioContext | null = null;
let playedInWindow = 0;
let windowStartedAt = 0;
const MAX_SOUNDS_PER_SECOND = 8; // a violent tape becomes texture, not noise

function allowed(now: number): boolean {
  if (now - windowStartedAt > 1000) {
    windowStartedAt = now;
    playedInWindow = 0;
  }
  return ++playedInWindow <= MAX_SOUNDS_PER_SECOND;
}

export function playSound(params: SoundParams): void {
  if (document.visibilityState === "hidden") return;
  if (!allowed(performance.now())) return;
  try {
    audioContext = audioContext ?? new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;
    oscillator.type = params.type;
    oscillator.frequency.setValueAtTime(params.frequency, now);
    if (params.glideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(
        params.glideTo, now + params.duration);
    }
    gain.gain.setValueAtTime(params.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + params.duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + params.duration);
  } catch {
    // Audio is decoration — a blocked AudioContext must never break the tape.
  }
}
