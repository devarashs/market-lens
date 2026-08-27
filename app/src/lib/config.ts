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
  { key: "MON", cls: "crypto", seconds: false, threshold: 500 },
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
  NEAR: "Near", XPL: "Plasma", TRUMP: "Official Trump", MON: "Monad",
  AAVE: "Aave", PUMP: "Pump.fun", FARTCOIN: "Fartcoin",
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
  { id: "sma20", label: "SMA 20", kind: "sma", length: 20, color: "#7a9ec2" },
  { id: "sma50", label: "SMA 50", kind: "sma", length: 50, color: "#c2a97a" },
  { id: "sma100", label: "SMA 100", kind: "sma", length: 100, color: "#8ec2bd" },
  { id: "sma200", label: "SMA 200", kind: "sma", length: 200, color: "#b07ac2" },
  { id: "ema9", label: "EMA 9", kind: "ema", length: 9, color: "#7ac2b4" },
  { id: "ema21", label: "EMA 21", kind: "ema", length: 21, color: "#c27a7a" },
  { id: "ema50", label: "EMA 50", kind: "ema", length: 50, color: "#9ac27a" },
  { id: "ema100", label: "EMA 100", kind: "ema", length: 100, color: "#c2b17a" },
  { id: "ema200", label: "EMA 200", kind: "ema", length: 200, color: "#c27ab0" },
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

export const MAX_TAPE_ROWS = 120;
export const MAX_TRADES = 600; // in-memory big-trade store (history + live)

/** Positioning metrics, in preference order — money-weighted first, then
    the real margin book, then the account-count sentiment gauges. Mirrors
    market_lens/positioning.py. */
export const POSITIONING_METRICS = [
  "top-positions", "bitfinex-margin", "top-accounts", "global-accounts",
] as const;

export const POSITIONING_LABELS: Record<string, string> = {
  "top-positions": "Binance top 20% positions",
  "bitfinex-margin": "Bitfinex margin book",
  "top-accounts": "Binance top 20% accounts",
  "global-accounts": "Binance all accounts",
};

/** Every toggleable chart layer, for the searchable Layers menu. Grouped
    the way they are read: what price is doing, what is resting in the
    book, what has actually traded, and the Liquidation Hunter set ported
    from the Pine indicator of that name. */
export interface LayerDef {
  key: string;
  label: string;
  group: string;
  hint?: string;
}

export const LAYER_DEFS: readonly LayerDef[] = [
  { key: "candles", label: "Candles", group: "Price" },
  { key: "levels", label: "Day levels", group: "Price",
    hint: "prev high/low/close, today's open" },
  { key: "vwap", label: "VWAP", group: "Price", hint: "session, volume-weighted" },
  { key: "roundNumbers", label: "Round-number magnets", group: "Price",
    hint: "levels a crowd fixates on" },

  { key: "depth", label: "Depth bars", group: "Resting claims",
    hint: "aggregated book at the right edge" },
  { key: "walls", label: "Order lines", group: "Resting claims",
    hint: "top walls, from where they appeared" },
  { key: "heat", label: "Heatmap", group: "Resting claims",
    hint: "the book through time" },
  { key: "liqmap", label: "Liq map (measured)", group: "Resting claims",
    hint: "bands from real open-interest changes" },
  { key: "liqGrid", label: "Liq grid (anchor)", group: "Resting claims",
    hint: "leverage tiers off VWAP — the Pine version" },

  { key: "trades", label: "Trade dashes", group: "Executed facts" },
  { key: "profile", label: "Volume profile", group: "Executed facts" },
  { key: "poc", label: "POC & value area", group: "Executed facts",
    hint: "from our own profile, not a candle proxy" },
  { key: "cvd", label: "CVD", group: "Executed facts",
    hint: "cumulative volume delta" },
  { key: "liqs", label: "Liquidation prints", group: "Executed facts",
    hint: "real forced closes" },
  { key: "positioning", label: "Net long/short", group: "Executed facts" },
  { key: "volumeNodes", label: "Volume nodes", group: "Executed facts",
    hint: "heaviest-traded price levels" },

  { key: "stopClusters", label: "Stop clusters", group: "Liquidation Hunter",
    hint: "where stops rest beyond swings" },
  { key: "sweeps", label: "Stop sweeps", group: "Liquidation Hunter",
    hint: "pierced, then rejected" },
  { key: "absorption", label: "Absorption", group: "Liquidation Hunter",
    hint: "heavy volume, tiny body" },
  { key: "exhaustion", label: "Exhaustion", group: "Liquidation Hunter",
    hint: "new extreme, momentum fading" },
  { key: "squeeze", label: "Squeeze regime", group: "Liquidation Hunter",
    hint: "range compressed, expansion due" },
  { key: "priceExtreme", label: "Extreme deviation", group: "Liquidation Hunter",
    hint: "price >2.5σ from its mean" },
];

/** Tunables for the Liquidation Hunter layers, matching the Pine inputs. */
export const QLH_SETTINGS = {
  pivotLeft: 5,
  pivotRight: 2,
  stopBufferAtr: 0.3,
  maxClusters: 8,
  volumeLookback: 50,
  volumeZThreshold: 2.0,
  absorptionMaxBody: 0.25,
  volumeNodeLookback: 50,
  volumeNodeCount: 3,
  sweepMinWick: 0.55,
  sweepRequireVolume: true,
  bbLength: 20,
  kcLength: 20,
  kcMult: 1.5,
  easyMoveRatio: 1.15,
  rsiLength: 14,
  rocLength: 10,
  priceExtremeSigma: 2.5,
  liqGridTiers: [5, 10, 25, 50, 100] as const,
  liqGridShown: [10, 25, 50] as const,
} as const;
