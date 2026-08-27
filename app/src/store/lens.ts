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
import {
  appendCapped, asLiqItem, asTradeItem, type LiqItem, type TradeItem,
} from "../lib/tape";
import type {
  Candle,
  ConnectionStatus,
  DepthMessage,
  HeatCol,
  LiqBand,
  MetricsMap,
  PositioningSeries,
  ServerMessage,
  Trade,
} from "../lib/types";

export interface LayerFlags {
  liqs: boolean;
  liqmap: boolean;
  positioning: boolean;
  // Liquidation Hunter set (ported from the Pine indicator).
  stopClusters: boolean;
  sweeps: boolean;
  absorption: boolean;
  exhaustion: boolean;
  squeeze: boolean;
  priceExtreme: boolean;
  roundNumbers: boolean;
  volumeNodes: boolean;
  liqGrid: boolean;
  poc: boolean;
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
  trades: TradeItem[];
  liqs: LiqItem[];
  liqMap: LiqBand[];
  cvd: [number, number][];
  positioning: PositioningSeries;
  /** Which positioning metric the chart draws; "" = best available. */
  positioningMetric: string;
  metrics: MetricsMap;
  candleRows: Candle[];
  activeVenues: string[] | null; // null = all venues
  /** Per-symbol price grouping, an absolute bin in quote units. Was a
      multiplier on the symbol's base bin until 2026-08-27, which meant a
      different fraction of price on every symbol. */
  binSizes: Record<string, number>;
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
  setBinSize(symbol: Symbol, bin: number): void;
  setLayer(layer: keyof LayerFlags, on: boolean): void;
  setLayers(next: Partial<LayerFlags>): void;
  setMaVisible(id: string, on: boolean): void;
  setBeepEnabled(on: boolean): void;
  setPositioningMetric(metric: string): void;
  setConnection(status: ConnectionStatus): void;
  setCandleRows(rows: Candle[]): void;
  setReadout(readout: ReadoutData | null): void;
  /** Clear everything the socket streams — called on symbol switch and on
      every socket (re)open, because after a reconnect the seed is the only
      truth and stale rows would otherwise pin the tape (2026-08-26). */
  resetStreams(): void;
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
  binSizes: Record<string, number>;
  layers: LayerFlags;
  maVisible: Record<string, boolean>;
  beepEnabled: boolean;
  positioningMetric: string;
}

const DEFAULT_LAYERS: LayerFlags = {
  heat: true, profile: true, walls: true, trades: true, depth: true,
  candles: true, cvd: true, vwap: true, levels: true,
  liqs: true, liqmap: true, positioning: true,
  // The Hunter layers start OFF: they are a dense set, and turning all of
  // them on at once is how the original ends up unreadable.
  stopClusters: false, sweeps: false, absorption: false, exhaustion: false,
  squeeze: false, priceExtreme: false, roundNumbers: false,
  volumeNodes: false, liqGrid: false, poc: false,
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
    binSizes: state.binSizes,
    layers: state.layers,
    maVisible: state.maVisible,
    beepEnabled: state.beepEnabled,
    positioningMetric: state.positioningMetric,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full/blocked: prefs just don't persist this session.
  }
}

// ------------------------------------------------------- trade buffering
// Prints arrive in clumps. Applying each one to the store meant one React
// render per print; buffering to the next animation frame makes a burst
// cost a single render, and a hidden tab (where rAF is paused) simply
// applies its backlog in one go when it comes back rather than replaying
// hundreds of renders.
const MAX_LIQS = 500;
let pending: Trade[] = [];
let flushHandle: number | null = null;

function flushTrades(): void {
  flushHandle = null;
  const batch = pending;
  pending = [];
  if (batch.length === 0) return;
  const state = useLensStore.getState();
  const fresh = batch.map(asTradeItem);
  useLensStore.setState({
    trades: appendCapped(state.trades, fresh, MAX_TRADES),
  });
  // Sounds follow the same gates as the tape: you hear what you would see.
  if (!state.beepEnabled) return;
  const threshold = currentThreshold(state);
  for (const trade of batch) {
    const venueOn = state.activeVenues === null
      || state.activeVenues.includes(trade.venue);
    if (venueOn && trade.notional >= threshold) {
      playSound(soundParams(trade.side, trade.notional / threshold));
    }
  }
}

function bufferTrade(trade: Trade): void {
  pending.push(trade);
  if (flushHandle !== null) return;
  flushHandle = typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(flushTrades)
    : (setTimeout(flushTrades, 16) as unknown as number);
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
    positioning: {},
    positioningMetric: stored.positioningMetric ?? "",
    metrics: {},
    candleRows: [],
    activeVenues: null,
    binSizes: stored.binSizes ?? {},
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
        case "trade":
          bufferTrade(message);
          break;
        case "trades":
          // Batched by the server: a burst arrives as one message.
          for (const trade of message.trades ?? []) bufferTrade(trade);
          break;
        case "tapeHistory":
          set({ trades: (message.trades ?? []).map(asTradeItem) });
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
          set({ liqs: appendCapped(state.liqs, [asLiqItem(message)], MAX_LIQS) });
          const threshold = currentThreshold(state);
          if (state.beepEnabled && message.notional >= threshold) {
            playSound(liquidationParams(message.side, message.notional / threshold));
          }
          break;
        }
        case "liqHistory":
          set({ liqs: (message.events ?? []).map(asLiqItem) });
          break;
        case "liqmap":
          set({ liqMap: message.bands ?? [] });
          break;
        case "positioning":
          set({ positioning: message.series ?? {} });
          break;
      }
    },

    resetStreams() {
      pending = [];
      set({ depth: null, heat: [], trades: [], liqs: [], liqMap: [],
            cvd: [], positioning: {}, readout: null });
    },

    selectSymbol(symbol) {
      if (symbol === get().symbol) return;
      get().resetStreams();
      // Old-symbol candles and venue filter go too — a blank chart that
      // fills is honest; stale BTC walls on an ETH chart are not.
      set({
        symbol,
        timeframe: legalTimeframe(symbol, get().timeframe),
        activeVenues: null, candleRows: [],
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
    setBinSize(symbol, bin) {
      set({ binSizes: { ...get().binSizes, [symbol]: bin } });
      savePrefs(get());
    },
    setLayer(layer, on) {
      set({ layers: { ...get().layers, [layer]: on } });
      savePrefs(get());
    },
    setLayers(next) {
      set({ layers: { ...get().layers, ...next } });
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
    setPositioningMetric(metric) {
      set({ positioningMetric: metric });
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
