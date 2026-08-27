"""Stablecoin supply — the market's dry powder.

Total USD-pegged stablecoin circulating supply and how fast it is
changing. Newly minted stablecoins are dollars that have entered crypto
but not yet bought anything; the premise is that they eventually bid.

Tested before being shown (arena: docs/research/stablecoin-flow.md). The
honest summary: the 7-day change carries a faint but real tilt at a
7-day horizon — +1.31% mean on 605 non-overlapping trades, beating random
long entry by 1.12 points, while only 49% long so it is not just riding
the market. Every other horizon died, and a rank correlation of 0.065
explains under half a percent of variance. It is shown as a MEASUREMENT
on probation, not as a signal, and the UI says so.

Source: DefiLlama's stablecoin charts — free, keyless, daily since 2017.

Pure functions here; the poll lives in server.py.
"""

from __future__ import annotations

LLAMA_CHART_URL = "https://stablecoins.llama.fi/stablecoincharts/all"

# The window the arena's test found something at. Anything else shown
# alongside it is context, not the tested reading.
SIGNAL_WINDOW_DAYS = 7
RANK_WINDOW_DAYS = 365


def parse_supply_series(rows: list) -> list[tuple[int, float]]:
    """[(epoch_seconds, total_usd_pegged_supply)], oldest first."""
    out: list[tuple[int, float]] = []
    for row in rows or []:
        circulating = row.get("totalCirculatingUSD") or {}
        pegged = circulating.get("peggedUSD")
        if pegged is None:
            continue
        try:
            out.append((int(row["date"]), float(pegged)))
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda point: point[0])
    return out


def pct_change_days(series: list[tuple[int, float]], days: int) -> float | None:
    """Percentage change over the last `days` samples of a daily series."""
    if len(series) <= days:
        return None
    older = series[-1 - days][1]
    latest = series[-1][1]
    if older <= 0:
        return None
    return (latest / older - 1) * 100


def percentile_of_last(values: list[float]) -> float | None:
    """Where the newest value sits within its own window, 0-100.

    This is the shape the tested rule actually uses: not the raw change,
    but whether today's change is high or low *relative to the trailing
    year*. A number near 100 is the top tercile the rule went long in.
    """
    if len(values) < 30:
        return None
    latest = values[-1]
    below = sum(1 for value in values if value < latest)
    return below / (len(values) - 1) * 100


def summarise(series: list[tuple[int, float]]) -> dict:
    """The payload the UI renders."""
    if not series:
        return {"available": False}
    changes = []
    for index in range(SIGNAL_WINDOW_DAYS, len(series)):
        older = series[index - SIGNAL_WINDOW_DAYS][1]
        if older > 0:
            changes.append((series[index][1] / older - 1) * 100)
    window = changes[-RANK_WINDOW_DAYS:]
    return {
        "available": True,
        "supplyUsd": series[-1][1],
        "asOf": series[-1][0],
        "change7dPct": pct_change_days(series, 7),
        "change30dPct": pct_change_days(series, 30),
        "change90dPct": pct_change_days(series, 90),
        # Where today's 7d change sits in the trailing year — the form the
        # arena's test actually measured.
        "percentileOfYear": percentile_of_last(window),
        # 120 points is enough for a sparkline without bloating the wire.
        "history": [[stamp, round(value, 0)] for stamp, value in series[-120:]],
    }
