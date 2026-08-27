"""Per-symbol reference statistics for the info panel.

Most of this is computed from candles we already fetch, which matters for
two reasons: it works identically for all 51 symbols — including the
equity and commodity perps, which no crypto data provider covers — and it
adds no dependency that can rot.

What we cannot compute, we do not invent. Market cap needs a circulating
supply, so it comes from CoinGecko for the coins and is simply absent for
the equity perps: a perp on Nvidia has no issuer, no float and no supply,
and the underlying company's market cap is a fact about a different
instrument on a different exchange. The panel says so rather than showing
a plausible number.

Pure module — arithmetic and shaping only, so every edge is testable.
"""

from __future__ import annotations

import math

# Our symbol key -> CoinGecko id. Verified to resolve, 2026-08-27.
COINGECKO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "BNB": "binancecoin",
    "DOGE": "dogecoin", "HYPE": "hyperliquid", "XRP": "ripple", "ZEC": "zcash",
    "XMR": "monero", "LINK": "chainlink", "AAVE": "aave", "SUI": "sui",
    "TAO": "bittensor", "ENA": "ethena", "PUMP": "pump-fun",
    "FARTCOIN": "fartcoin", "LTC": "litecoin", "ADA": "cardano",
    "AVAX": "avalanche-2", "TRUMP": "official-trump", "NEAR": "near",
    "XPL": "plasma", "MON": "monad",
}

# Return windows, in days. 1h is handled separately from hourly candles.
RETURN_WINDOWS = (("24h", 1), ("7d", 7), ("30d", 30), ("90d", 90), ("1y", 365))
TRADING_DAYS_PER_YEAR = 365  # crypto trades every day; equity perps here do too


def _close(candle: dict) -> float:
    return float(candle["c"])


def pct_change(start: float, end: float) -> float | None:
    """Percentage move, or None when the base is unusable."""
    if not start or start <= 0:
        return None
    return (end / start - 1) * 100


def returns(daily: list[dict], hourly: list[dict] | None = None) -> dict[str, float | None]:
    """Return over each window, from daily closes.

    A window longer than the available history yields None rather than a
    return measured from whatever the oldest candle happens to be —
    Hyperliquid's equity dexes are months old, and reporting their
    "1 year" from an 8-month base would silently mean something else.
    """
    out: dict[str, float | None] = {}
    if hourly and len(hourly) >= 2:
        out["1h"] = pct_change(_close(hourly[-2]), _close(hourly[-1]))
    else:
        out["1h"] = None
    if not daily:
        return {**out, **{label: None for label, _ in RETURN_WINDOWS}}
    latest = _close(daily[-1])
    for label, days in RETURN_WINDOWS:
        # `days` candles back, needing one extra so the base is a real
        # earlier close rather than today's open.
        if len(daily) <= days:
            out[label] = None
            continue
        out[label] = pct_change(_close(daily[-1 - days]), latest)
    return out


def volumes(daily: list[dict]) -> dict[str, float | None]:
    """Quote-volume totals and averages, in USD."""
    if not daily:
        return {"24h": None, "avg7d": None, "avg30d": None, "total30d": None}

    def quote_volume(candle: dict) -> float:
        # Binance reports quote volume directly; Hyperliquid reports base
        # volume, so it is valued at the period's close. Preferring the
        # exact figure where it exists beats normalising both to the
        # approximation.
        if candle.get("q") is not None:
            return float(candle["q"])
        return float(candle.get("v") or 0) * _close(candle)

    values = [quote_volume(candle) for candle in daily]
    last30 = values[-30:]
    return {
        "24h": values[-1],
        "avg7d": sum(values[-7:]) / len(values[-7:]),
        "avg30d": sum(last30) / len(last30),
        "total30d": sum(last30),
    }


def extremes(daily: list[dict]) -> dict[str, float | None]:
    """High/low over the available history, and where price sits in it."""
    if not daily:
        return {"high": None, "low": None, "days": 0, "fromHigh": None,
                "rangePosition": None}
    highs = [float(candle["h"]) for candle in daily]
    lows = [float(candle["l"]) for candle in daily]
    high, low = max(highs), min(lows)
    latest = _close(daily[-1])
    span = high - low
    return {
        "high": high,
        "low": low,
        "days": len(daily),
        "fromHigh": pct_change(high, latest),
        # 0 = at the period low, 100 = at its high.
        "rangePosition": None if span <= 0 else (latest - low) / span * 100,
    }


def realised_volatility(daily: list[dict], window: int = 30) -> float | None:
    """Annualised standard deviation of daily log returns, in percent.

    The number that says how much room to give a stop — a 30% name and a
    130% name are not the same trade at the same size.
    """
    closes = [_close(candle) for candle in daily][-(window + 1):]
    if len(closes) < 3:
        return None
    steps = []
    for previous, current in zip(closes, closes[1:]):
        if previous > 0 and current > 0:
            steps.append(math.log(current / previous))
    if len(steps) < 2:
        return None
    mean = sum(steps) / len(steps)
    variance = sum((step - mean) ** 2 for step in steps) / (len(steps) - 1)
    return math.sqrt(variance) * math.sqrt(TRADING_DAYS_PER_YEAR) * 100


def market_data(entry: dict | None) -> dict | None:
    """Shape a CoinGecko row into what the panel shows, or None."""
    if not entry:
        return None
    return {
        "name": entry.get("name"),
        "marketCap": entry.get("market_cap"),
        "rank": entry.get("market_cap_rank"),
        "fdv": entry.get("fully_diluted_valuation"),
        "circulating": entry.get("circulating_supply"),
        "maxSupply": entry.get("max_supply"),
        "spotVolume24h": entry.get("total_volume"),
        "ath": entry.get("ath"),
        "athChangePct": entry.get("ath_change_percentage"),
        "athDate": entry.get("ath_date"),
        "atl": entry.get("atl"),
        "atlChangePct": entry.get("atl_change_percentage"),
    }


def build(symbol: str, asset_class: str, daily: list[dict],
          hourly: list[dict] | None, coingecko: dict | None,
          metrics: dict | None, extras: dict | None = None) -> dict:
    """Assemble the payload the modal renders."""
    return {
        "symbol": symbol,
        "assetClass": asset_class,
        "returns": returns(daily, hourly),
        "volumes": volumes(daily),
        "extremes": extremes(daily),
        "volatility30d": realised_volatility(daily),
        "market": market_data(coingecko),
        # Absent market data is a fact about the instrument, not a gap to
        # paper over: the equity perps have no issuer or float behind them.
        "marketDataAvailable": coingecko is not None,
        "derivatives": {
            "openInterestUsd": (metrics or {}).get("oiUsd"),
            "funding": (metrics or {}).get("funding"),
            "fundingHl": (metrics or {}).get("fundingHl"),
            "last": (metrics or {}).get("last"),
            "change24h": (metrics or {}).get("change24h"),
        },
        **(extras or {}),
    }
