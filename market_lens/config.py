"""Market Lens configuration: symbols, venues, bins, thresholds.

Every symbol maps to the venues that trade it and the parameters that make
its numbers comparable: a price bin for depth aggregation and a notional
threshold for what counts as a "big" trade on the tape.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
# The built React app (app/ is the source; `cd app && npm run build`
# produces dist/). The server serves static files only — no Node in prod.
WEB_DIR = REPO_ROOT / "app" / "dist"
RECORD_DIR = REPO_ROOT / "data_recorded"

HTTP_PORT = 8899
# Aggregated book push rate. 1s (was 0.4s): the tape streams per-trade on
# its own messages so nothing felt slows, and the depth aggregation under
# this tick is the collector's dominant cost on the 1-vCPU VPS.
DEPTH_BROADCAST_SECONDS = 1.0
DEPTH_RECORD_SECONDS = 30         # book snapshot persistence cadence
# Display window: bins kept nearest the mid, per side. 150 × $10 BTC bins
# ≈ ±1.9% — the visible depth band. Venue caps beyond our control: Binance
# 1000 levels polled, OKX 400, Bybit spot 200, Hyperliquid ~20 aggregated.
DEPTH_BINS_PER_SIDE = 150


@dataclass(frozen=True)
class SymbolSpec:
    key: str                 # UI/API name
    binance: str | None      # Binance spot stream symbol (None = not listed)
    hyperliquid: str | None  # Hyperliquid coin name ("xyz:NVDA" on a builder dex)
    price_bin: float         # depth aggregation bin size (quote units)
    big_trade_usd: float     # tape/marker threshold (notional USD)
    bybit: str | None = None     # Bybit spot symbol
    okx: str | None = None       # OKX spot instId
    # USD-quoted venues (no USDT books worth using): joins the aggregate
    # with the ~2bp USDT-peg smear every cross-venue aggregator accepts.
    coinbase: str | None = None  # Coinbase product_id
    kraken: str | None = None    # Kraken WS v2 symbol
    # Grouping for the symbol picker: crypto | stock | index | commodity.
    asset_class: str = "crypto"
    # CORE symbols get the full treatment — every venue's book, the deep
    # Binance poll, a continuously maintained heat ring, and depth
    # archiving. EXTENDED symbols are Hyperliquid-only and do their book
    # work solely while someone is watching them. Without that split, 40+
    # symbols would multiply the collector's idle cost by the symbol count
    # and blow Binance's request-weight budget (see docs: 1000-level polls
    # cost 50 weight each, and the ceiling is 6000/min).
    core: bool = False


def dex_of(spec: SymbolSpec) -> str | None:
    """The Hyperliquid builder-dex a symbol lives on, or None for the main
    perp dex. Equity/commodity perps are namespaced `dex:SYMBOL`."""
    if spec.hyperliquid and ":" in spec.hyperliquid:
        return spec.hyperliquid.split(":", 1)[0]
    return None


SYMBOLS: dict[str, SymbolSpec] = {
    spec.key: spec
    for spec in (
        SymbolSpec("BTC", "btcusdt", "BTC", price_bin=10.0, big_trade_usd=100_000,
                   bybit="BTCUSDT", okx="BTC-USDT",
                   coinbase="BTC-USD", kraken="BTC/USD", core=True),
        SymbolSpec("ETH", "ethusdt", "ETH", price_bin=1.0, big_trade_usd=50_000,
                   bybit="ETHUSDT", okx="ETH-USDT",
                   coinbase="ETH-USD", kraken="ETH/USD", core=True),
        SymbolSpec("SOL", "solusdt", "SOL", price_bin=0.05, big_trade_usd=25_000,
                   bybit="SOLUSDT", okx="SOL-USDT",
                   coinbase="SOL-USD", kraken="SOL/USD", core=True),
        # BNB trades on neither Coinbase nor Kraken (Binance's own token).
        SymbolSpec("BNB", "bnbusdt", "BNB", price_bin=0.2, big_trade_usd=25_000,
                   bybit="BNBUSDT", okx="BNB-USDT", core=True),
        SymbolSpec("DOGE", "dogeusdt", "DOGE", price_bin=0.0005, big_trade_usd=25_000,
                   bybit="DOGEUSDT", okx="DOGE-USDT",
                   coinbase="DOGE-USD", kraken="DOGE/USD", core=True),
        SymbolSpec("HYPE", None, "HYPE", price_bin=0.01, big_trade_usd=10_000, core=True),

        # ---------------------------------------------------- extended: crypto
        # Hyperliquid's main perp dex. Deliberately NOT mapped to Binance:
        # a 1000-level poll per symbol every 5s would breach the weight
        # budget long before the CPU noticed. HL's own book and tape are
        # the view here.
        SymbolSpec("XRP", None, "XRP", price_bin=0.0005, big_trade_usd=50_000),
        SymbolSpec("ZEC", None, "ZEC", price_bin=0.5, big_trade_usd=50_000),
        SymbolSpec("XMR", None, "XMR", price_bin=0.2, big_trade_usd=10_000),
        SymbolSpec("LINK", None, "LINK", price_bin=0.005, big_trade_usd=10_000),
        SymbolSpec("AAVE", None, "AAVE", price_bin=0.05, big_trade_usd=10_000),
        SymbolSpec("SUI", None, "SUI", price_bin=0.0005, big_trade_usd=10_000),
        SymbolSpec("TAO", None, "TAO", price_bin=0.1, big_trade_usd=10_000),
        SymbolSpec("ENA", None, "ENA", price_bin=0.00005, big_trade_usd=25_000),
        SymbolSpec("PUMP", None, "PUMP", price_bin=0.000002, big_trade_usd=50_000),
        SymbolSpec("FARTCOIN", None, "FARTCOIN", price_bin=0.00005, big_trade_usd=25_000),
        SymbolSpec("LTC", None, "LTC", price_bin=0.02, big_trade_usd=5_000),
        SymbolSpec("ADA", None, "ADA", price_bin=0.0001, big_trade_usd=10_000),
        SymbolSpec("AVAX", None, "AVAX", price_bin=0.005, big_trade_usd=5_000),
        SymbolSpec("TRUMP", None, "TRUMP", price_bin=0.001, big_trade_usd=10_000),
        SymbolSpec("NEAR", None, "NEAR", price_bin=0.0005, big_trade_usd=10_000),
        SymbolSpec("XPL", None, "XPL", price_bin=0.00005, big_trade_usd=10_000),
        # Monad, added 2026-08-27. price_bin is HL's own tick (measured
        # 1e-6 off the live book, not assumed).
        #
        # The threshold looks tiny next to its peers because HL's MON flow
        # genuinely is: measured on the deployed collector, 70s of
        # forwarded prints had a median of $119 and a max of $357. The
        # usual $10K would leave the tape permanently empty. $500 was the
        # first guess and still showed only 1.7 prints/min at the default
        # 0.5x slider — sized against a raw venue sample that included the
        # sub-$50 prints the server never forwards. $200 puts the default
        # at $100, roughly 5 prints/min, with the slider spanning
        # $20 to $800 around it.
        #
        # MON also trades on Binance perp, Bybit, OKX, Coinbase and Kraken
        # with far larger clips — see the extended-symbol note above for
        # why this stays Hyperliquid-only.
        SymbolSpec("MON", None, "MON", price_bin=0.000001, big_trade_usd=200),

        # ------------------------------- extended: equities, indices, commodities
        # Hyperliquid builder dexes (HIP-3) list perps on real-world assets,
        # namespaced `dex:SYMBOL`. Of the ten deployed dexes only `xyz` has
        # real flow ($2.1B/24h vs $0 on most of the others, measured
        # 2026-08-26), so everything here comes from it. Symbols the
        # ticker-recognition test would expect but that barely trade there
        # — NFLX, GME, ARM, ASML, VIX, DXY, all under $1.5M/24h — are left
        # out on purpose: an empty book is worse than an absent symbol.
        SymbolSpec("NVDA", None, "xyz:NVDA", price_bin=0.1, big_trade_usd=25_000,
                   asset_class="stock"),
        SymbolSpec("TSLA", None, "xyz:TSLA", price_bin=0.2, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("AAPL", None, "xyz:AAPL", price_bin=0.2, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("MSFT", None, "xyz:MSFT", price_bin=0.2, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("GOOGL", None, "xyz:GOOGL", price_bin=0.2, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("AMZN", None, "xyz:AMZN", price_bin=0.1, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("META", None, "xyz:META", price_bin=0.2, big_trade_usd=25_000,
                   asset_class="stock"),
        SymbolSpec("AMD", None, "xyz:AMD", price_bin=0.2, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("AVGO", None, "xyz:AVGO", price_bin=0.2, big_trade_usd=5_000,
                   asset_class="stock"),
        SymbolSpec("MU", None, "xyz:MU", price_bin=0.5, big_trade_usd=25_000,
                   asset_class="stock"),
        SymbolSpec("INTC", None, "xyz:INTC", price_bin=0.05, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("MRVL", None, "xyz:MRVL", price_bin=0.1, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("COIN", None, "xyz:COIN", price_bin=0.05, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("MSTR", None, "xyz:MSTR", price_bin=0.05, big_trade_usd=10_000,
                   asset_class="stock"),
        SymbolSpec("CRCL", None, "xyz:CRCL", price_bin=0.05, big_trade_usd=50_000,
                   asset_class="stock"),
        SymbolSpec("PLTR", None, "xyz:PLTR", price_bin=0.05, big_trade_usd=5_000,
                   asset_class="stock"),
        SymbolSpec("HOOD", None, "xyz:HOOD", price_bin=0.05, big_trade_usd=10_000,
                   asset_class="stock"),
        # Korean/Asian semis carry the most flow on this dex, ahead of the
        # US megacaps — SK Hynix and SanDisk out-trade NVDA there.
        SymbolSpec("SKHX", None, "xyz:SKHX", price_bin=0.5, big_trade_usd=50_000,
                   asset_class="stock"),
        SymbolSpec("SNDK", None, "xyz:SNDK", price_bin=0.5, big_trade_usd=50_000,
                   asset_class="stock"),
        SymbolSpec("SMSN", None, "xyz:SMSN", price_bin=0.05, big_trade_usd=25_000,
                   asset_class="stock"),
        SymbolSpec("SPCX", None, "xyz:SPCX", price_bin=0.05, big_trade_usd=50_000,
                   asset_class="stock"),
        SymbolSpec("UNITREE", None, "xyz:UNITREE", price_bin=0.05, big_trade_usd=25_000,
                   asset_class="stock"),
        SymbolSpec("SP500", None, "xyz:SP500", price_bin=5.0, big_trade_usd=50_000,
                   asset_class="index"),
        SymbolSpec("XYZ100", None, "xyz:XYZ100", price_bin=10.0, big_trade_usd=50_000,
                   asset_class="index"),
        SymbolSpec("SOXL", None, "xyz:SOXL", price_bin=0.05, big_trade_usd=10_000,
                   asset_class="index"),
        SymbolSpec("GOLD", None, "xyz:GOLD", price_bin=2.0, big_trade_usd=25_000,
                   asset_class="commodity"),
        SymbolSpec("SILVER", None, "xyz:SILVER", price_bin=0.02, big_trade_usd=25_000,
                   asset_class="commodity"),
        SymbolSpec("CL", None, "xyz:CL", price_bin=0.05, big_trade_usd=50_000,
                   asset_class="commodity"),
        SymbolSpec("BRENTOIL", None, "xyz:BRENTOIL", price_bin=0.05, big_trade_usd=50_000,
                   asset_class="commodity"),
    )
}

CORE_SYMBOLS: tuple[str, ...] = tuple(k for k, s in SYMBOLS.items() if s.core)
# Builder dexes we must poll for metrics, derived rather than restated.
HL_DEXES: tuple[str, ...] = tuple(sorted(
    {d for d in (dex_of(s) for s in SYMBOLS.values()) if d}))

# Archive retention, in days per table (None = keep forever). Policy lives
# here, not in the store, which only supplies the mechanism. Depth snapshots
# are the file's bulk and age out first; forced-liquidation prints are kept
# forever because no venue serves that history back.
RETENTION_DAYS: dict[str, int | None] = {
    "depth_snapshots": 14,
    "trades": 90,
    "flow_minutes": 90,
    "oi_observations": 90,
    "liquidations": None,
}
RETENTION_SWEEP_SECONDS = 6 * 3600

BINANCE_WS = "wss://stream.binance.com:9443/stream"
BINANCE_REST = "https://api.binance.com"
BINANCE_REST_FALLBACK = "https://data-api.binance.vision"
HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws"
HYPERLIQUID_REST = "https://api.hyperliquid.xyz"
BYBIT_WS = "wss://stream.bybit.com/v5/public/spot"
OKX_WS = "wss://ws.okx.com:8443/ws/v5/public"
COINBASE_WS = "wss://ws-feed.exchange.coinbase.com"
KRAKEN_WS = "wss://ws.kraken.com/v2"
