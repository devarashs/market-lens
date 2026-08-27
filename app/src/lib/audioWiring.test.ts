/* End-to-end check of the note scheduler against a fake AudioContext.

   `scheduleStarts` is unit-tested on its own; this covers the wiring that
   actually broke — a whole batch handed to `scheduleBatch` must reach the
   oscillators as SPACED start times rather than one chord at
   `currentTime`, which is what the old per-print loop produced. */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Recorder { starts: number[] }

function fakeAudio(recorder: Recorder, now = 10) {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  class FakeContext {
    currentTime = now;
    state = "running";
    destination = {};
    resume = vi.fn();
    createGain() {
      return { gain: param(), connect: (next: unknown) => next };
    }
    createDynamicsCompressor() {
      return {
        threshold: param(), knee: param(), ratio: param(),
        attack: param(), release: param(),
        connect: (next: unknown) => next,
      };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: param(),
        connect: (next: unknown) => next,
        start: (at: number) => recorder.starts.push(at),
        stop: vi.fn(),
      };
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("document", { visibilityState: "visible" });
}

async function freshAudio() {
  vi.resetModules();
  return import("./audio");
}

describe("scheduleBatch wiring", () => {
  let recorder: Recorder;

  beforeEach(() => {
    recorder = { starts: [] };
    fakeAudio(recorder);
  });

  it("does not fire a batch as one chord", async () => {
    const { scheduleBatch, soundParams, SCHEDULE } = await freshAudio();
    // Nine prints in the same millisecond — one coalesced server message.
    scheduleBatch(Array.from({ length: 9 }, () => ({
      params: soundParams("buy", 1), ts: 1_000,
    })));
    expect(recorder.starts).toHaveLength(9);
    expect(new Set(recorder.starts).size).toBe(9);   // not all at currentTime
    const sorted = [...recorder.starts].sort((a, b) => a - b);
    for (const [i, at] of sorted.slice(1).entries()) {
      expect(at - sorted[i]).toBeGreaterThanOrEqual(SCHEDULE.minGap - 1e-9);
    }
  });

  it("preserves the real spacing of prints inside a burst", async () => {
    const { scheduleBatch, soundParams } = await freshAudio();
    scheduleBatch([0, 250, 500].map((offset) => ({
      params: soundParams("sell", 1), ts: 1_000 + offset,
    })));
    const [a, b, c] = recorder.starts;
    expect(b - a).toBeCloseTo(0.25, 6);
    expect(c - b).toBeCloseTo(0.25, 6);
  });

  it("keeps later batches from landing on top of earlier ones", async () => {
    const { scheduleBatch, soundParams, SCHEDULE } = await freshAudio();
    scheduleBatch([{ params: soundParams("buy", 1), ts: 0 }]);
    scheduleBatch([{ params: soundParams("buy", 1), ts: 0 }]);
    expect(recorder.starts[1] - recorder.starts[0])
      .toBeGreaterThanOrEqual(SCHEDULE.minGap - 1e-9);
  });

  it("stays silent in a hidden tab", async () => {
    vi.stubGlobal("document", { visibilityState: "hidden" });
    const { scheduleBatch, soundParams } = await freshAudio();
    scheduleBatch([{ params: soundParams("buy", 1), ts: 0 }]);
    expect(recorder.starts).toHaveLength(0);
  });

  it("does nothing on an empty batch", async () => {
    const { scheduleBatch } = await freshAudio();
    scheduleBatch([]);
    expect(recorder.starts).toHaveLength(0);
  });

  it("survives an AudioContext that cannot be created", async () => {
    vi.stubGlobal("AudioContext", function Blocked() {
      throw new Error("blocked by autoplay policy");
    });
    const { scheduleBatch, soundParams } = await freshAudio();
    expect(() => scheduleBatch([{ params: soundParams("buy", 1), ts: 0 }]))
      .not.toThrow();
  });
});
