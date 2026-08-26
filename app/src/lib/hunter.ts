/* One pass over the candle series producing everything the Liquidation
   Hunter layers draw, so the chart's animation frame never recomputes
   pivots, RSI and the squeeze series. */

import { QLH_SETTINGS } from "./config";
import {
  absorptions, exhaustions, priceZScores, roundLevels, squeeze,
  stopClusters, sweeps, volumeNodes, volumeZScores,
  type Absorption, type Exhaustion, type StopCluster, type Sweep,
} from "./qlh";
import type { Candle } from "./types";

export interface HunterFrame {
  clusters: StopCluster[];
  sweeps: Sweep[];
  absorptions: Absorption[];
  exhaustions: Exhaustion[];
  squeezeNow: boolean;
  squeezeFiredAt: number | null;
  easyNow: boolean;
  priceExtreme: boolean;
  roundLevels: number[];
  volumeNodes: number[];
}

export function computeHunter(
  rows: Candle[], settings: typeof QLH_SETTINGS,
): HunterFrame {
  if (rows.length === 0) {
    return { clusters: [], sweeps: [], absorptions: [], exhaustions: [],
             squeezeNow: false, squeezeFiredAt: null, easyNow: false,
             priceExtreme: false, roundLevels: [], volumeNodes: [] };
  }
  const volumeZ = volumeZScores(rows, settings.volumeLookback);
  const clusters = stopClusters(rows, settings.pivotLeft, settings.pivotRight,
                                settings.stopBufferAtr, settings.maxClusters);
  const squeezeStates = squeeze(rows, settings.bbLength, settings.kcLength,
                                settings.kcMult, settings.easyMoveRatio);
  const last = squeezeStates[squeezeStates.length - 1];
  const fired = [...squeezeStates].reverse().find((state) => state.fired);
  const priceZ = priceZScores(rows);
  const latestZ = priceZ[priceZ.length - 1];

  return {
    clusters,
    sweeps: sweeps(rows, clusters, settings.sweepMinWick,
                   settings.sweepRequireVolume, volumeZ),
    absorptions: absorptions(rows, volumeZ, settings.absorptionMaxBody),
    exhaustions: exhaustions(rows, settings.rsiLength, settings.rocLength),
    squeezeNow: last?.on ?? false,
    squeezeFiredAt: fired?.time ?? null,
    easyNow: last?.easy ?? false,
    priceExtreme: latestZ !== null
      && Math.abs(latestZ) > settings.priceExtremeSigma,
    roundLevels: roundLevels(rows[rows.length - 1].close),
    volumeNodes: volumeNodes(rows, settings.volumeNodeLookback,
                             settings.volumeNodeCount),
  };
}

/** POC and value-area edges from OUR executed-volume profile.

    The Pine original bins candles and infers a buy/sell split from where
    each closed in its range. We already publish real executed volume per
    price bin, split by actual aggressor, so the same three lines come out
    of a measurement rather than an inference. */
export function valueAreaFromProfile(
  profile: [number, number, number][], valueAreaPct: number,
): { poc: number | null; vah: number | null; val: number | null } {
  if (profile.length === 0) return { poc: null, vah: null, val: null };
  const rows = [...profile].sort((a, b) => a[0] - b[0]);
  const totals = rows.map(([, buy, sell]) => buy + sell);
  const grandTotal = totals.reduce((sum, value) => sum + value, 0);
  if (grandTotal <= 0) return { poc: null, vah: null, val: null };

  let pocIndex = 0;
  for (let i = 1; i < totals.length; i += 1) {
    if (totals[i] > totals[pocIndex]) pocIndex = i;
  }
  // Expand outward from the POC, always taking the heavier neighbour,
  // until the target share of volume is enclosed.
  const target = grandTotal * (valueAreaPct / 100);
  let low = pocIndex;
  let high = pocIndex;
  let covered = totals[pocIndex];
  while (covered < target && (low > 0 || high < rows.length - 1)) {
    const below = low > 0 ? totals[low - 1] : -1;
    const above = high < rows.length - 1 ? totals[high + 1] : -1;
    if (below < 0 && above < 0) break;
    if (above >= below) { high += 1; covered += above; }
    else { low -= 1; covered += below; }
  }
  return { poc: rows[pocIndex][0], vah: rows[high][0], val: rows[low][0] };
}
