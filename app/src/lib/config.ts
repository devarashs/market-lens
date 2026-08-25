/* Client-side symbol/timeframe registry. Mirrors market_lens/config.py —
   the server is the authority; this copy only drives UI affordances
   (pills, thresholds, the seconds guard). Keep the two in sync when
   adding symbols. */

export const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "HYPE"] as const;
export type Symbol = (typeof SYMBOLS)[number];

export const TIMEFRAMES = ["1s", "1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Hyperliquid's finest candle is 1m — HL-only symbols cannot show seconds. */
export const NO_SECONDS: readonly Symbol[] = ["HYPE"];

export const TF_SECONDS: Record<Timeframe, number> = {
  "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

/** Per-symbol "big trade" notional floor (USD); the slider multiplies it. */
export const BASE_THRESHOLDS: Record<Symbol, number> = {
  BTC: 100_000, ETH: 50_000, SOL: 25_000, BNB: 25_000, DOGE: 25_000, HYPE: 10_000,
};

export const CHART_STYLES = ["candles", "heikin", "bars", "line", "area"] as const;
export type ChartStyle = (typeof CHART_STYLES)[number];

export interface MaDef {
  id: string;
  label: string;
  kind: "sma" | "ema";
  length: number;
  color: string;
}

export const MA_DEFS: readonly MaDef[] = [
  { id: "sma20", label: "S20", kind: "sma", length: 20, color: "#7a9ec2" },
  { id: "sma50", label: "S50", kind: "sma", length: 50, color: "#c2a97a" },
  { id: "sma200", label: "S200", kind: "sma", length: 200, color: "#b07ac2" },
  { id: "ema9", label: "E9", kind: "ema", length: 9, color: "#7ac2b4" },
  { id: "ema21", label: "E21", kind: "ema", length: 21, color: "#c27a7a" },
  { id: "ema50", label: "E50", kind: "ema", length: 50, color: "#9ac27a" },
];

/** Series + overlay palette (matches the CSS tokens in styles.css). */
export const COLORS = {
  up: "#3fa36c",
  down: "#c4564a",
  line: "#7fae93",
  gold: "#c9a35a",
  bidRgb: "63,163,108",
  askRgb: "196,86,74",
} as const;

export const MAX_TAPE_ROWS = 120;
export const MAX_TRADES = 600; // in-memory big-trade store (history + live)
