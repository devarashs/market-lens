"""Rolling 24h flow per MARKET — one row per exchange x symbol.

The chart pages answer "what is this asset doing". This answers "where is
it being done, and by which side" — the aggr.trade Prices pane idea Arash
brought in, with one deliberate difference.

aggr accumulates from zero every time you open the pane (or every period
reset), so its numbers describe your session rather than the market. Here
the window is a fixed rolling 24 hours and it is rebuilt from the archive
on startup, so the same question always gets the same answer and a
restart does not wipe it (Arash: "lets track last 24 hours always, like
save it somewhere").

Buckets, not a running total, because a rolling window has to be able to
FORGET. Five-minute granularity keeps the whole cross-venue picture at
roughly 26k floats — a running sum would be cheaper still but could only
ever grow.

Pure module: no I/O, no clock. The caller passes `now_ms`.
"""

from __future__ import annotations

BUCKET_SECONDS = 300          # 5 minutes: 24h in 288 buckets per market
WINDOW_SECONDS = 24 * 3600
BUCKETS_IN_WINDOW = WINDOW_SECONDS // BUCKET_SECONDS


def bucket_of(ts_ms: int) -> int:
    """The bucket a timestamp belongs to, as epoch seconds at its start."""
    return int(ts_ms // 1000 // BUCKET_SECONDS * BUCKET_SECONDS)


def window_start(now_ms: int) -> int:
    """Oldest bucket still inside the window, as epoch seconds.

    The current bucket is partial, so the window spans 24h plus however
    much of the newest bucket has elapsed. Trimming to exactly 24h would
    mean dropping the bucket a trade just landed in.
    """
    return bucket_of(now_ms) - (BUCKETS_IN_WINDOW - 1) * BUCKET_SECONDS


def prune(buckets: dict[int, list[float]], cutoff: int) -> None:
    """Drop buckets that have aged out. In place: these dicts are held per
    market for the life of the process."""
    for start in [key for key in buckets if key < cutoff]:
        del buckets[start]


def totals(buckets: dict[int, list[float]], cutoff: int) -> tuple[float, float]:
    """(buy_usd, sell_usd) summed over the live part of the window."""
    buy = sell = 0.0
    for start, (b, s) in buckets.items():
        if start >= cutoff:
            buy += b
            sell += s
    return buy, sell


def delta_percent(buy: float, sell: float) -> float | None:
    """Net aggression as a share of the market's own volume, -100..100.

    This is aggr's `avgVolumeDelta` and it is a RATIO, not an amount —
    which is the whole trap of sorting by it. A market that traded $21K
    one-sidedly reads 91% while one that traded $183M with $22M of net
    buying reads 12%, so the ranking surfaces thin books unless a volume
    floor is applied. The page offers that floor and says so; it is not
    applied by default, because a default floor would silently hide
    markets rather than let you choose to.

    None when nothing traded: 0% would claim balance where there is no
    evidence either way.
    """
    volume = buy + sell
    if volume <= 0:
        return None
    return (buy - sell) / volume * 100


def market_row(symbol: str, venue: str, buy: float, sell: float,
               price: float | None, change: float | None) -> dict:
    """One watchlist row, ready to serialise."""
    pct = delta_percent(buy, sell)
    return {
        "symbol": symbol,
        "venue": venue,
        "price": price,
        "change": change,
        "volume": round(buy + sell, 2),
        "delta": round(buy - sell, 2),
        # Rounded here rather than in delta_percent so the ratio stays
        # exact for callers that sort on it.
        "deltaPct": None if pct is None else round(pct, 2),
    }


def build(flow: dict[str, dict[str, dict[int, list[float]]]],
          prices: dict[str, dict[str, float]],
          changes: dict[str, float | None],
          now_ms: int) -> list[dict]:
    """Every market with volume in the window, newest data first.

    `flow` is {symbol: {venue: {bucket_start: [buy, sell]}}}, `prices` the
    last trade seen per {symbol: {venue: price}}, `changes` the 24h move
    per symbol. Markets that traded nothing in the window are dropped
    rather than listed as empty rows — with 52 symbols across 9 venues,
    most pairs do not exist at all.
    """
    cutoff = window_start(now_ms)
    rows = []
    for symbol, venues in flow.items():
        for venue, buckets in venues.items():
            prune(buckets, cutoff)
            buy, sell = totals(buckets, cutoff)
            if buy + sell <= 0:
                continue
            rows.append(market_row(
                symbol, venue, buy, sell,
                (prices.get(symbol) or {}).get(venue),
                changes.get(symbol)))
    rows.sort(key=lambda row: -row["volume"])
    return rows
