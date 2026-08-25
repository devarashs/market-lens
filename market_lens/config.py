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
DEPTH_BROADCAST_SECONDS = 0.4     # aggregated book push rate to browsers
DEPTH_RECORD_SECONDS = 30         # book snapshot persistence cadence
# Display window: bins kept nearest the mid, per side. 150 × $10 BTC bins
# ≈ ±1.9% — the visible depth band. Venue caps beyond our control: Binance
# 1000 levels polled, OKX 400, Bybit spot 200, Hyperliquid ~20 aggregated.
DEPTH_BINS_PER_SIDE = 150


@dataclass(frozen=True)
class SymbolSpec:
    key: str                 # UI/API name
    binance: str | None      # Binance spot stream symbol (None = not listed)
    hyperliquid: str | None  # Hyperliquid coin name
    price_bin: float         # depth aggregation bin size (quote units)
    big_trade_usd: float     # tape/marker threshold (notional USD)
    bybit: str | None = None     # Bybit spot symbol
    okx: str | None = None       # OKX spot instId


SYMBOLS: dict[str, SymbolSpec] = {
    spec.key: spec
    for spec in (
        SymbolSpec("BTC", "btcusdt", "BTC", price_bin=10.0, big_trade_usd=100_000,
                   bybit="BTCUSDT", okx="BTC-USDT"),
        SymbolSpec("ETH", "ethusdt", "ETH", price_bin=1.0, big_trade_usd=50_000,
                   bybit="ETHUSDT", okx="ETH-USDT"),
        SymbolSpec("SOL", "solusdt", "SOL", price_bin=0.05, big_trade_usd=25_000,
                   bybit="SOLUSDT", okx="SOL-USDT"),
        SymbolSpec("BNB", "bnbusdt", "BNB", price_bin=0.2, big_trade_usd=25_000,
                   bybit="BNBUSDT", okx="BNB-USDT"),
        SymbolSpec("DOGE", "dogeusdt", "DOGE", price_bin=0.0005, big_trade_usd=25_000,
                   bybit="DOGEUSDT", okx="DOGE-USDT"),
        SymbolSpec("HYPE", None, "HYPE", price_bin=0.01, big_trade_usd=10_000),
    )
}

BINANCE_WS = "wss://stream.binance.com:9443/stream"
BINANCE_REST = "https://api.binance.com"
BINANCE_REST_FALLBACK = "https://data-api.binance.vision"
HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws"
HYPERLIQUID_REST = "https://api.hyperliquid.xyz"
BYBIT_WS = "wss://stream.bybit.com/v5/public/spot"
OKX_WS = "wss://ws.okx.com:8443/ws/v5/public"
