/* Client-side symbol/timeframe registry. Mirrors market_lens/config.py —
   the server is the authority; this copy only drives UI affordances
   (pills, thresholds, the seconds guard). Keep the two in sync when
   adding symbols. */

/** Asset classes, in the order the symbol picker groups them. */
export const ASSET_CLASSES = ["crypto", "stock", "index", "commodity"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  crypto: "Crypto", stock: "Stocks", index: "Indices", commodity: "Commodities",
};

/** The symbol registry, mirroring market_lens/config.py. `seconds` is true
    only for Binance-listed symbols (Hyperliquid's finest candle is 1m).
    tests/test_symbol_registry_sync.py fails if this drifts from the
    server's list — with 50 symbols, hand-syncing two copies would not
    survive contact with reality. */
export const SYMBOL_META = [
  { key: "BTC", cls: "crypto", seconds: true, threshold: 100000 },
  { key: "ETH", cls: "crypto", seconds: true, threshold: 50000 },
  { key: "SOL", cls: "crypto", seconds: true, threshold: 25000 },
  { key: "BNB", cls: "crypto", seconds: true, threshold: 25000 },
  { key: "DOGE", cls: "crypto", seconds: true, threshold: 25000 },
  { key: "HYPE", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "XRP", cls: "crypto", seconds: false, threshold: 50000 },
  { key: "ZEC", cls: "crypto", seconds: false, threshold: 50000 },
  { key: "XMR", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "LINK", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "AAVE", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "SUI", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "TAO", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "ENA", cls: "crypto", seconds: false, threshold: 25000 },
  { key: "PUMP", cls: "crypto", seconds: false, threshold: 50000 },
  { key: "FARTCOIN", cls: "crypto", seconds: false, threshold: 25000 },
  { key: "LTC", cls: "crypto", seconds: false, threshold: 5000 },
  { key: "ADA", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "AVAX", cls: "crypto", seconds: false, threshold: 5000 },
  { key: "TRUMP", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "NEAR", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "XPL", cls: "crypto", seconds: false, threshold: 10000 },
  { key: "NVDA", cls: "stock", seconds: false, threshold: 25000 },
  { key: "TSLA", cls: "stock", seconds: false, threshold: 10000 },
  { key: "AAPL", cls: "stock", seconds: false, threshold: 10000 },
  { key: "MSFT", cls: "stock", seconds: false, threshold: 10000 },
  { key: "GOOGL", cls: "stock", seconds: false, threshold: 10000 },
  { key: "AMZN", cls: "stock", seconds: false, threshold: 10000 },
  { key: "META", cls: "stock", seconds: false, threshold: 25000 },
  { key: "AMD", cls: "stock", seconds: false, threshold: 10000 },
  { key: "AVGO", cls: "stock", seconds: false, threshold: 5000 },
  { key: "MU", cls: "stock", seconds: false, threshold: 25000 },
  { key: "INTC", cls: "stock", seconds: false, threshold: 10000 },
  { key: "MRVL", cls: "stock", seconds: false, threshold: 10000 },
  { key: "COIN", cls: "stock", seconds: false, threshold: 10000 },
  { key: "MSTR", cls: "stock", seconds: false, threshold: 10000 },
  { key: "CRCL", cls: "stock", seconds: false, threshold: 50000 },
  { key: "PLTR", cls: "stock", seconds: false, threshold: 5000 },
  { key: "HOOD", cls: "stock", seconds: false, threshold: 10000 },
  { key: "SKHX", cls: "stock", seconds: false, threshold: 50000 },
  { key: "SNDK", cls: "stock", seconds: false, threshold: 50000 },
  { key: "SMSN", cls: "stock", seconds: false, threshold: 25000 },
  { key: "SPCX", cls: "stock", seconds: false, threshold: 50000 },
  { key: "UNITREE", cls: "stock", seconds: false, threshold: 25000 },
  { key: "SP500", cls: "index", seconds: false, threshold: 50000 },
  { key: "XYZ100", cls: "index", seconds: false, threshold: 50000 },
  { key: "SOXL", cls: "index", seconds: false, threshold: 10000 },
  { key: "GOLD", cls: "commodity", seconds: false, threshold: 25000 },
  { key: "SILVER", cls: "commodity", seconds: false, threshold: 25000 },
  { key: "CL", cls: "commodity", seconds: false, threshold: 50000 },
  { key: "BRENTOIL", cls: "commodity", seconds: false, threshold: 50000 },
] as const;

export type Symbol = (typeof SYMBOL_META)[number]["key"];
export const SYMBOLS: readonly Symbol[] = SYMBOL_META.map((meta) => meta.key);

/** Longer names for search: typing "nvidia" or "apple" should find the
    ticker. Only for symbols whose ticker is not the obvious search term. */
export const SYMBOL_NAMES: Partial<Record<Symbol, string>> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "Binance Coin",
  DOGE: "Dogecoin", HYPE: "Hyperliquid", XRP: "Ripple", ZEC: "Zcash",
  XMR: "Monero", LINK: "Chainlink", SUI: "Sui", TAO: "Bittensor",
  ENA: "Ethena", LTC: "Litecoin", ADA: "Cardano", AVAX: "Avalanche",
  NEAR: "Near", XPL: "Plasma", TRUMP: "Official Trump",
  NVDA: "Nvidia", TSLA: "Tesla", AAPL: "Apple", MSFT: "Microsoft",
  GOOGL: "Google Alphabet", AMZN: "Amazon", META: "Meta Facebook",
  AMD: "Advanced Micro Devices", AVGO: "Broadcom", MU: "Micron",
  INTC: "Intel", MRVL: "Marvell", COIN: "Coinbase", MSTR: "MicroStrategy",
  CRCL: "Circle", PLTR: "Palantir", HOOD: "Robinhood",
  SKHX: "SK Hynix", SNDK: "SanDisk", SMSN: "Samsung", SPCX: "SpaceX",
  UNITREE: "Unitree Robotics", SP500: "S&P 500", XYZ100: "XYZ 100 index",
  SOXL: "Semiconductor bull 3x", GOLD: "Gold", SILVER: "Silver",
  CL: "WTI Crude Oil", BRENTOIL: "Brent Crude Oil",
};

export const TIMEFRAMES = ["1s", "1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Hyperliquid's finest candle is 1m — HL-only symbols cannot show seconds. */
export const NO_SECONDS: readonly Symbol[] =
  SYMBOL_META.filter((meta) => !meta.seconds).map((meta) => meta.key);

export const TF_SECONDS: Record<Timeframe, number> = {
  "1s": 1, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

/** Per-symbol "big trade" notional floor (USD); the slider multiplies it. */
export const BASE_THRESHOLDS = Object.fromEntries(
  SYMBOL_META.map((meta) => [meta.key, meta.threshold]),
) as Record<Symbol, number>;

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
  // Liquidation family: violet — deliberately outside the bid/ask hues so
  // forced flow never reads as ordinary trading.
  liqLongRgb: "196,111,174",   // longs died (forced sells)
  liqShortRgb: "138,122,194",  // shorts died (forced buys)
} as const;

/** Price-grouping multipliers on the symbol's base bin — must mirror the
    server's allowed set (ws_handler). 0.2x reaches exchange tick size. */
export const BIN_MULTS = [0.2, 0.5, 1, 2, 5, 10] as const;

export const MAX_TAPE_ROWS = 120;
export const MAX_TRADES = 600; // in-memory big-trade store (history + live)
