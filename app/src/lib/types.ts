/* Wire types for the collector's WebSocket protocol and /klines REST.
   The server (market_lens/server.py docstring) is the contract; these
   types are the client's copy of it. */

export interface Candle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Trade {
  ts: number; // epoch ms
  venue: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notional: number;
}

/** [price_bin, notional_usd] */
export type DepthLevel = [number, number];

/** [price, usd, {venue: usd}] — a top wall with per-venue attribution. */
export type AttributedWall = [number, number, Record<string, number>];

/** [ts_seconds, bids, asks] — one heat-ring column. */
export type HeatCol = [number, DepthLevel[], DepthLevel[]];

export interface SignalReading {
  score: number;
  parts?: Record<string, unknown>;
}

export interface CombinedSignal extends SignalReading {
  verdict: string;
}

export interface DepthMessage {
  type: "depth";
  symbol: string;
  venues: string[];
  activeVenues: string[];
  bin: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  mid: number | null;
  imbalance: number | null;
  walls: { bids: AttributedWall[]; asks: AttributedWall[] };
  best: Record<string, { bid: number | null; ask: number | null }>;
  vwap: number | null;
  pressure: { buy: number; sell: number };
  profile: [number, number, number][]; // [price, buyUsd, sellUsd]
  signals: { tape: SignalReading; book: SignalReading; combined: CombinedSignal };
}

export interface SymbolMetrics {
  last?: number;
  change24h?: number;
  funding?: number;
  fundingHl?: number;
  nextFunding?: number; // epoch ms
  oiUsd?: number;
}

export type MetricsMap = Record<string, SymbolMetrics>;

export type ServerMessage =
  | DepthMessage
  | ({ type: "trade"; symbol: string } & Trade)
  | { type: "tapeHistory"; symbol: string; trades: Trade[] }
  | { type: "heat"; symbol: string; cols: HeatCol[] }
  | { type: "heatcol"; symbol: string; col: HeatCol }
  | { type: "cvd"; symbol: string; points: [number, number][] }
  | { type: "metrics"; data: MetricsMap };

export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "stale";
