/* Tape audio, aggr.trade-style: the flow as sound, so the tool works with
   your eyes elsewhere. Design goals — musical (pentatonic degrees only, so
   overlapping blips can't be dissonant), informative (size → register:
   bigger prints sit lower and last longer; buys ring brighter than sells),
   and restrained (quiet, silent in hidden tabs).

   SCHEDULING (rewritten 2026-08-27). Prints do not arrive one at a time:
   the server coalesces a burst into one 100ms message and the client
   flushes it in a single frame. The old code then called play() for each
   print in a tight loop, every one starting at `currentTime` — so a burst
   of nine trades fired as ONE CHORD, and a fixed 8-sounds-per-second cap
   silently dropped whatever followed. Arash heard exactly that: batched,
   not flowing.

   Notes are now placed on the WebAudio clock instead. Each print keeps
   its real offset from the first print of its batch, and a minimum gap
   guarantees two prints in the same millisecond become a fast arpeggio
   rather than a chord. A note that would land further ahead than
   `maxAhead` is dropped, so a violent tape thins out instead of lagging
   further and further behind the market.

   Split: `soundParams`, `liquidationParams` and `scheduleStarts` are pure
   and unit-tested; only `playAt`/`scheduleBatch` touch WebAudio. */

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
    // Raised 2026-08-27 ("make the sound more noticeable"). Safe to push
    // because everything now runs through a limiter, so overlapping notes
    // duck instead of clipping.
    gain: Math.min(0.34, 0.08 + Math.sqrt(magnitude) * 0.04),
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
    gain: Math.min(0.42, 0.14 + Math.sqrt(magnitude) * 0.06),
    type: "sawtooth",
  };
}

// ------------------------------------------------------------ scheduling

export const SCHEDULE = {
  /** Start just ahead of the clock so the first note is never late. */
  lookahead: 0.02,
  /** Two prints in the same millisecond become an arpeggio, not a chord. */
  minGap: 0.04,
  /** Beyond this the queue is losing touch with the market: drop instead. */
  maxAhead: 0.6,
} as const;

/** Pure core of the scheduler.

    `offsets` are seconds from the first item of the batch — the real
    spacing of the prints, so a burst keeps its actual rhythm. Returns a
    start time per item (null = dropped, the tape is denser than the ear
    can follow) plus the new busy-until cursor. */
export function scheduleStarts(
  offsets: number[], now: number, busyUntil: number,
): { starts: (number | null)[]; busyUntil: number } {
  const starts: (number | null)[] = [];
  let cursor = busyUntil;
  for (const offset of offsets) {
    const earliest = now + SCHEDULE.lookahead + Math.max(0, offset);
    const at = Math.max(earliest, cursor);
    if (at > now + SCHEDULE.maxAhead) {
      starts.push(null);       // too dense — thin out rather than lag
      continue;
    }
    starts.push(at);
    cursor = at + SCHEDULE.minGap;
  }
  return { starts, busyUntil: cursor };
}

// ------------------------------------------------------------- playback

let audioContext: AudioContext | null = null;
let master: GainNode | null = null;
let busyUntil = 0;

/** Attack ramp. Without it every note starts with a click, which reads as
    harsh rather than loud — the ramp is why this can be louder AND
    smoother at the same time. */
const ATTACK = 0.006;

function chain(): { ctx: AudioContext; out: GainNode } | null {
  try {
    if (!audioContext) {
      audioContext = new AudioContext();
      master = audioContext.createGain();
      master.gain.value = 0.9;
      // Soft limiter: a burst of overlapping notes ducks instead of
      // clipping, so per-note gain can be raised without distortion.
      const limiter = audioContext.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.knee.value = 12;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;
      master.connect(limiter).connect(audioContext.destination);
    }
    // Browsers suspend contexts created before a gesture; resuming is
    // free when it is already running.
    if (audioContext.state === "suspended") void audioContext.resume();
    return { ctx: audioContext, out: master! };
  } catch {
    return null;    // Audio is decoration — never break the tape.
  }
}

/** Play one note at an absolute time on the audio clock (default: now). */
export function playAt(params: SoundParams, at?: number): void {
  if (document.visibilityState === "hidden") return;
  const nodes = chain();
  if (!nodes) return;
  try {
    const { ctx, out } = nodes;
    const start = at ?? ctx.currentTime + SCHEDULE.lookahead;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = params.type;
    oscillator.frequency.setValueAtTime(params.frequency, start);
    if (params.glideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(
        params.glideTo, start + params.duration);
    }
    // exponential ramps cannot touch zero, hence the epsilons.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(params.gain, start + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.001, start + params.duration);
    oscillator.connect(gain).connect(out);
    oscillator.start(start);
    oscillator.stop(start + params.duration);
  } catch {
    // Blocked or exhausted AudioContext: stay silent, keep rendering.
  }
}

/** Spread one arriving batch across the clock, preserving its real rhythm.
    `ts` is the print's exchange timestamp in ms; only differences within
    the batch are used, so a skewed venue clock cannot push notes around. */
export function scheduleBatch(items: { params: SoundParams; ts: number }[]): void {
  if (items.length === 0) return;
  if (document.visibilityState === "hidden") return;
  const nodes = chain();
  if (!nodes) return;
  const now = nodes.ctx.currentTime;
  const first = Math.min(...items.map((item) => item.ts));
  const offsets = items.map((item) => (item.ts - first) / 1000);
  const plan = scheduleStarts(offsets, now, busyUntil);
  busyUntil = plan.busyUntil;
  plan.starts.forEach((at, index) => {
    if (at !== null) playAt(items[index].params, at);
  });
}

/** One-off (liquidations): still queued, so it never lands on top of a
    trade note already scheduled. */
export function playSound(params: SoundParams): void {
  scheduleBatch([{ params, ts: 0 }]);
}
