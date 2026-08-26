/* The single client-state authority. React components subscribe through
   hooks with narrow selectors; the chart and overlay canvases subscribe
   transiently (subscribeWithSelector / getState) so 2.5Hz depth pushes
   never force React renders of the heavy surfaces. */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import { liquidationParams, playSound, soundParams } from "../lib/audio";
import {
  BASE_THRESHOLDS,
  MA_DEFS,
  MAX_TRADES,
  NO_SECONDS,
  type ChartStyle,
  type Symbol,
  type Timeframe,
} from "../lib/config";
import type {
  Candle,
  ConnectionStatus,
  DepthMessage,
  HeatCol,
  LiqBand,
  LiqEvent,
  MetricsMap,
  ServerMessage,
  Trade,
} from "../lib/types";

export interface LayerFlags {
  liqs: boolean;
  liqmap: boolean;
  heat: boolean;
  profile: boolean;
  walls: boolean;
  trades: boolean;
  depth: boolean;
  candles: boolean;
  cvd: boolean;
  vwap: boolean;
  levels: boolean;
}

/** What the crosshair readout line shows for the hovered price bin. */
export interface ReadoutData {
  price: number;
  bidUsd: number | null;
  askUsd: number | null;
  tradedUsd: number | null;
  buySharePct: number | null;
}

interface LensState {
  symbol: Symbol;
  timeframe: Timeframe;
  chartStyle: ChartStyle;
  thresholdMult: number;
  connection: ConnectionStatus;
  depth: DepthMessage | null;
  heat: HeatCol[];
  trades: Trade[];
  liqs: LiqEvent[];
  liqMap: LiqBand[];
  cvd: [number, number][];
  metrics: MetricsMap;
  candleRows: Candle[];
  activeVenues: string[] | null; // null = all venues
  binMults: Record<string, number>; // per-symbol price-grouping multiplier
  layers: LayerFlags;
  maVisible: Record<string, boolean>;
  beepEnabled: boolean;
  readout: ReadoutData | null;

  applyMessage(message: ServerMessage): void;
  selectSymbol(symbol: Symbol): void;
  setTimeframe(timeframe: Timeframe): void;
  setChartStyle(style: ChartStyle): void;
  setThresholdMult(mult: number): void;
  setActiveVenues(venues: string[] | null): void;
  setBinMult(symbol: Symbol, mult: number): void;
  setLayer(layer: keyof LayerFlags, on: boolean): void;
  setMaVisible(id: string, on: boolean): void;
  setBeepEnabled(on: boolean): void;
  setConnection(status: ConnectionStatus): void;
  setCandleRows(rows: Candle[]): void;
  setReadout(readout: ReadoutData | null): void;
}

export function currentThreshold(state: Pick<LensState, "symbol" | "thresholdMult">): number {
  return BASE_THRESHOLDS[state.symbol] * state.thresholdMult;
}

/** Coerce an unknown timeframe for a symbol: HL-only symbols have no 1s. */
export function legalTimeframe(symbol: Symbol, timeframe: Timeframe): Timeframe {
  return timeframe === "1s" && NO_SECONDS.includes(symbol) ? "1m" : timeframe;
}

// ---------------------------------------------------------------- prefs
// Persisted UI preferences (not market data). New storage key: the legacy
// client keyed prefs by DOM ids, which no longer exist.
const PREFS_KEY = "lens-prefs-v2";

interface StoredPrefs {
  chartStyle: ChartStyle;
  thresholdMult: number;
  binMults: Record<string, number>;
  layers: LayerFlags;
  maVisible: Record<string, boolean>;
  beepEnabled: boolean;
}

const DEFAULT_LAYERS: LayerFlags = {
  heat: true, profile: true, walls: true, trades: true, depth: true,
  candles: true, cvd: true, vwap: true, levels: true,
  liqs: true, liqmap: true,
};

function loadPrefs(): Partial<StoredPrefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function savePrefs(state: LensState): void {
  const prefs: StoredPrefs = {
    chartStyle: state.chartStyle,
    thresholdMult: state.thresholdMult,
    binMults: state.binMults,
    layers: state.layers,
    maVisible: state.maVisible,
    beepEnabled: state.beepEnabled,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full/blocked: prefs just don't persist this session.
  }
}

// ----------------------------------------------------------------- store

const stored = loadPrefs();

export const useLensStore = create<LensState>()(
  subscribeWithSelector((set, get) => ({
    symbol: "BTC",
    timeframe: "1m",
    chartStyle: stored.chartStyle ?? "candles",
    thresholdMult: stored.thresholdMult ?? 0.5,
    connection: "connecting",
    depth: null,
    heat: [],
    trades: [],
    liqs: [],
    liqMap: [],
    cvd: [],
    metrics: {},
    candleRows: [],
    activeVenues: null,
    binMults: stored.binMults ?? {},
    layers: { ...DEFAULT_LAYERS, ...stored.layers },
    maVisible: Object.fromEntries(
      MA_DEFS.map((def) => [def.id, stored.maVisible?.[def.id] ?? false]),
    ),
    beepEnabled: stored.beepEnabled ?? false,
    readout: null,

    applyMessage(message) {
      if (message.type === "metrics") {
        set({ metrics: message.data });
        return;
      }
      if (message.symbol !== get().symbol) return; // late frames for the old symbol
      switch (message.type) {
        case "depth":
          set({ depth: message });
          break;
        case "trade": {
          const state = get();
          const trades = [...state.trades, message];
          if (trades.length > MAX_TRADES) trades.shift();
          set({ trades });
          // Same gates as the tape list: you hear what you would see —
          // threshold AND the venue filter.
          const threshold = currentThreshold(state);
          const venueOn = state.activeVenues === null
            || state.activeVenues.includes(message.venue);
          if (state.beepEnabled && venueOn && message.notional >= threshold) {
            playSound(soundParams(message.side, message.notional / threshold));
          }
          break;
        }
        case "tapeHistory":
          set({ trades: message.trades ?? [] });
          break;
        case "heat":
          set({ heat: message.cols });
          break;
        case "heatcol": {
          const heat = [...get().heat, message.col];
          if (heat.length > 400) heat.shift();
          set({ heat });
          break;
        }
        case "cvd":
          set({ cvd: message.points });
          break;
        case "liq": {
          const state = get();
          const liqs = [...state.liqs, message];
          if (liqs.length > 500) liqs.shift();
          set({ liqs });
          const threshold = currentThreshold(state);
          if (state.beepEnabled && message.notional >= threshold) {
            playSound(liquidationParams(message.side, message.notional / threshold));
          }
          break;
        }
        case "liqHistory":
          set({ liqs: message.events ?? [] });
          break;
        case "liqmap":
          set({ liqMap: message.bands ?? [] });
          break;
      }
    },

    selectSymbol(symbol) {
      if (symbol === get().symbol) return;
      set({
        symbol,
        timeframe: legalTimeframe(symbol, get().timeframe),
        // Everything below is the OLD symbol's data — a blank chart that
        // fills is honest; stale BTC walls on an ETH chart are not.
        depth: null, heat: [], trades: [], liqs: [], liqMap: [], cvd: [],
        readout: null, activeVenues: null, candleRows: [],
      });
    },

    setTimeframe(timeframe) {
      const legal = legalTimeframe(get().symbol, timeframe);
      if (legal === get().timeframe) return;
      // Merge-based candle updates make stale rows poisonous across a
      // timeframe switch — clear so the next poll starts clean.
      set({ timeframe: legal, candleRows: [] });
    },

    setChartStyle(style) {
      set({ chartStyle: style });
      savePrefs(get());
    },
    setThresholdMult(mult) {
      set({ thresholdMult: mult });
      savePrefs(get());
    },
    setActiveVenues(venues) {
      set({ activeVenues: venues });
    },
    setBinMult(symbol, mult) {
      set({ binMults: { ...get().binMults, [symbol]: mult } });
      savePrefs(get());
    },
    setLayer(layer, on) {
      set({ layers: { ...get().layers, [layer]: on } });
      savePrefs(get());
    },
    setMaVisible(id, on) {
      set({ maVisible: { ...get().maVisible, [id]: on } });
      savePrefs(get());
    },
    setBeepEnabled(on) {
      set({ beepEnabled: on });
      savePrefs(get());
    },
    setConnection(status) {
      set({ connection: status });
    },
    setCandleRows(rows) {
      set({ candleRows: rows });
    },
    setReadout(readout) {
      set({ readout });
    },
  })),
);
