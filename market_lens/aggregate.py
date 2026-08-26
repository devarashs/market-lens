"""Order-book aggregation: many venues' books → one binned depth profile.

Pure functions, no I/O — the part of the collector where correctness is
subtle enough to deserve unit tests (tests/test_aggregate.py).

Sizes are converted to notional (price × size) before summing, so BTC depth
and DOGE depth read in the same unit (USD) and venues are directly
comparable/addable.
"""

from __future__ import annotations

import math


def bin_price(price: float, bin_size: float) -> float:
    """Snap a price onto its bin's lower edge (one consistent rule for both
    sides — what matters is that identical prices land in identical bins)."""
    return round(math.floor(price / bin_size) * bin_size, 10)


def aggregate_books(
    books: list[dict], bin_size: float, bins_per_side: int
) -> dict:
    """Merge venue books into binned bid/ask notional profiles.

    Each input book: {"bids": [[price, size], ...], "asks": [[price, size], ...]}.
    Returns {"bids": [[bin, usd], ...] high→low, "asks": [[bin, usd], ...]
    low→high, "mid": float|None}, trimmed to `bins_per_side` nearest the mid.
    Crossed remnants (a venue's stale bid above another's ask) are kept as-is:
    this is a visualization of claims, not a matching engine.
    """
    bid_bins: dict[float, float] = {}
    ask_bins: dict[float, float] = {}
    best_bid, best_ask = None, None
    for book in books:
        for price, size in book.get("bids", []):
            bid_bins[bin_price(price, bin_size)] = (
                bid_bins.get(bin_price(price, bin_size), 0.0) + price * size
            )
            best_bid = price if best_bid is None else max(best_bid, price)
        for price, size in book.get("asks", []):
            ask_bins[bin_price(price, bin_size)] = (
                ask_bins.get(bin_price(price, bin_size), 0.0) + price * size
            )
            best_ask = price if best_ask is None else min(best_ask, price)

    mid = None
    if best_bid is not None and best_ask is not None:
        mid = (best_bid + best_ask) / 2

    bids = sorted(bid_bins.items(), key=lambda kv: -kv[0])[:bins_per_side]
    asks = sorted(ask_bins.items(), key=lambda kv: kv[0])[:bins_per_side]
    return {"bids": [[p, round(v, 2)] for p, v in bids],
            "asks": [[p, round(v, 2)] for p, v in asks],
            "mid": mid}


def book_imbalance(profile: dict, top_n: int = 15) -> float | None:
    """Share of near-mid resting notional sitting on the bid side (0..1).

    Uses the `top_n` bins nearest the touch on each side — the zone where
    imbalance plausibly pressures price. None when either side is empty.
    """
    bid_usd = sum(v for _, v in profile["bids"][:top_n])
    ask_usd = sum(v for _, v in profile["asks"][:top_n])
    total = bid_usd + ask_usd
    return None if total == 0 else bid_usd / total


def top_walls(profile: dict, count: int = 4) -> dict:
    """The largest resting levels per side — the 'magnets' worth watching."""
    return {
        "bids": sorted(profile["bids"], key=lambda pv: -pv[1])[:count],
        "asks": sorted(profile["asks"], key=lambda pv: -pv[1])[:count],
    }


def heat_columns_from_archive(rows: list[tuple]) -> list[list]:
    """Rebuild heat-ring columns from archived depth rows.

    `rows`: (ts_ms, side, price_bin, notional_usd) time-ordered, as
    LensStore.depth_range returns them. One archive snapshot (identical
    ts) becomes one ring column [ts_seconds, bids, asks]. Archive cadence
    is 30s vs the live ring's 10s and 25 bins vs 40 — a slightly coarser
    but honest reconstruction; live columns replace it within the hour.
    """
    columns: list[list] = []
    for ts_ms, side, price_bin, notional_usd in rows:
        ts_s = int(ts_ms / 1000)
        if not columns or columns[-1][0] != ts_s:
            columns.append([ts_s, [], []])
        columns[-1][1 if side == "bid" else 2].append([price_bin, notional_usd])
    return columns
