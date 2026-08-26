"""Net long/short positioning — who is leaning which way, and by how much.

Two families of public data, deliberately kept distinct because they mean
different things:

  RATIOS (Binance futures). Shares of accounts or of open notional that
  are long vs short. `global-accounts` counts every account equally, so
  it reads as retail sentiment; `top-accounts` is the top 20% by margin
  balance, still one-account-one-vote; `top-positions` weights by actual
  notional, so it is the closest thing to "where is the money". Binance
  serves ~30 days and no more — recording it is the point.

  POSITION SIZE (Bitfinex margin). Actual borrowed size held long and
  short, in base units. This is the series behind the BTCUSDLONGS /
  BTCUSDSHORTS charts people plot on TradingView, and the only source
  here that reports real position size rather than a proportion.

Everything is normalised to one comparable number:

    net = (long - short) / (long + short) * 100

so +100 means every unit is long, -100 every unit short, and 0 is
balanced. That makes an account-share ratio and a margin book readable on
the same axis — while remaining, always, two different measurements of
two different populations.

Pure module: parsing and arithmetic only, no I/O, so every edge is
testable.
"""

from __future__ import annotations

from dataclasses import dataclass

BINANCE_FUTURES_DATA = "https://fapi.binance.com/futures/data"
BITFINEX_STATS = "https://api-pub.bitfinex.com/v2/stats1"

# metric key -> Binance endpoint path.
BINANCE_METRICS = {
    "global-accounts": "globalLongShortAccountRatio",
    "top-accounts": "topLongShortAccountRatio",
    "top-positions": "topLongShortPositionRatio",
}

# Our symbol key -> Bitfinex margin pair. Only where Bitfinex has a real
# margin book; the rest simply have no such series and say so.
BITFINEX_PAIRS = {
    "BTC": "tBTCUSD",
    "ETH": "tETHUSD",
    "SOL": "tSOLUSD",
    "XRP": "tXRPUSD",
    "DOGE": "tDOGE:USD",
    "LTC": "tLTCUSD",
    "ADA": "tADAUSD",
    "AVAX": "tAVAX:USD",
    "LINK": "tLINK:USD",
    "XMR": "tXMRUSD",
}

METRIC_LABELS = {
    "global-accounts": "Binance all accounts",
    "top-accounts": "Binance top 20% accounts",
    "top-positions": "Binance top 20% positions",
    "bitfinex-margin": "Bitfinex margin book",
}


@dataclass(frozen=True)
class PositioningPoint:
    ts_ms: int
    long_value: float
    short_value: float

    @property
    def net_pct(self) -> float:
        """Net lean, -100 (all short) to +100 (all long)."""
        total = self.long_value + self.short_value
        return 0.0 if total <= 0 else (self.long_value - self.short_value) / total * 100


def net_pct(long_value: float, short_value: float) -> float:
    """(long - short) / (long + short), as a percentage. 0 when empty."""
    total = long_value + short_value
    return 0.0 if total <= 0 else (long_value - short_value) / total * 100


def parse_binance_ratio(rows: list) -> list[PositioningPoint]:
    """Binance long/short rows -> points.

    `longAccount`/`shortAccount` are already shares that sum to 1 (the
    field names say "account" even on the position-weighted endpoint,
    where they are shares of notional).
    """
    points = []
    for row in rows:
        try:
            long_share = float(row["longAccount"])
            short_share = float(row["shortAccount"])
            ts = int(row["timestamp"])
        except (KeyError, TypeError, ValueError):
            continue
        points.append(PositioningPoint(ts, long_share, short_share))
    return points


def parse_bitfinex_sizes(long_rows: list, short_rows: list) -> list[PositioningPoint]:
    """Bitfinex `[[ts, size], ...]` for each side -> points on shared
    timestamps. Sides are fetched separately and can be a sample apart, so
    only timestamps present in both are used rather than interpolating."""
    shorts = {int(row[0]): float(row[1]) for row in short_rows
              if isinstance(row, list) and len(row) >= 2}
    points = []
    for row in long_rows:
        if not isinstance(row, list) or len(row) < 2:
            continue
        ts = int(row[0])
        if ts not in shorts:
            continue
        points.append(PositioningPoint(ts, float(row[1]), shorts[ts]))
    points.sort(key=lambda point: point.ts_ms)
    return points


def thin(points: list[PositioningPoint], max_points: int) -> list[PositioningPoint]:
    """Stride a series down to at most `max_points`, always keeping the
    newest — a level series, unlike a cumulative one, loses nothing but
    resolution when thinned."""
    if max_points <= 0 or len(points) <= max_points:
        return points
    stride = -(-len(points) // max_points)
    kept = points[::stride]
    if kept and points and kept[-1] is not points[-1]:
        kept.append(points[-1])
    return kept
