"""Symbol reference stats: windows, honesty about short history, volatility."""

import math

import pytest

from market_lens.config import SYMBOLS
from market_lens.symbolinfo import (
    COINGECKO_IDS,
    build,
    extremes,
    market_data,
    pct_change,
    realised_volatility,
    returns,
    volumes,
)


def candle(close: float, high: float | None = None, low: float | None = None,
           volume: float = 10.0) -> dict:
    return {"c": str(close), "h": str(high if high is not None else close),
            "l": str(low if low is not None else close), "o": str(close),
            "v": str(volume)}


def series(closes: list[float]) -> list[dict]:
    return [candle(value) for value in closes]


# ---------------------------------------------------------------- pct_change


def test_pct_change_basics():
    assert pct_change(100, 110) == pytest.approx(10.0)
    assert pct_change(100, 50) == pytest.approx(-50.0)
    assert pct_change(0, 50) is None
    assert pct_change(-5, 50) is None


# ------------------------------------------------------------------ returns


def test_returns_measure_from_the_right_candle():
    # 400 days, rising by 1 each day: 100, 101, ... 499.
    daily = series([100 + i for i in range(400)])
    out = returns(daily)
    latest = 499
    assert out["24h"] == pct_change(498, latest)
    assert out["7d"] == pct_change(492, latest)
    assert out["1y"] == pct_change(134, latest)


def test_windows_longer_than_history_are_none_not_approximated():
    """Hyperliquid's equity dexes are months old. Reporting a '1 year'
    return from an eight-month base would quietly mean something else."""
    daily = series([100 + i for i in range(200)])  # ~6.5 months
    out = returns(daily)
    assert out["90d"] is not None
    assert out["1y"] is None


def test_one_hour_return_comes_from_hourly_candles():
    out = returns(series([100, 101]), hourly=series([200, 210]))
    assert out["1h"] == pytest.approx(5.0)


def test_one_hour_is_none_without_hourly_data():
    assert returns(series([100, 101]))["1h"] is None
    assert returns(series([100]), hourly=series([100]))["1h"] is None


def test_returns_on_empty_history():
    out = returns([])
    assert set(out) == {"1h", "24h", "7d", "30d", "90d", "1y"}
    assert all(value is None for value in out.values())


# ------------------------------------------------------------------ volumes


def test_volumes_are_quote_denominated():
    daily = [candle(100, volume=5), candle(200, volume=5)]
    out = volumes(daily)
    assert out["24h"] == 1000.0          # 5 units at 200
    assert out["avg7d"] == 750.0         # (500 + 1000) / 2


def test_volume_averages_use_what_exists():
    daily = [candle(10, volume=1) for _ in range(3)]
    out = volumes(daily)
    assert out["avg7d"] == 10.0 and out["avg30d"] == 10.0
    assert out["total30d"] == 30.0


def test_volumes_on_empty_history():
    assert volumes([])["24h"] is None


# ----------------------------------------------------------------- extremes


def test_extremes_locate_price_within_the_range():
    daily = [candle(50, high=60, low=40), candle(50, high=100, low=20)]
    out = extremes(daily)
    assert out["high"] == 100.0 and out["low"] == 20.0
    assert out["days"] == 2
    assert out["fromHigh"] == -50.0
    assert out["rangePosition"] == 37.5  # 50 sits 37.5% up a 20..100 range


def test_extremes_on_a_flat_series_do_not_divide_by_zero():
    out = extremes([candle(50, high=50, low=50)])
    assert out["rangePosition"] is None


def test_extremes_on_empty_history():
    assert extremes([])["high"] is None


# --------------------------------------------------------------- volatility


def test_volatility_is_zero_for_a_flat_series():
    assert realised_volatility(series([100] * 40)) == 0.0


def test_volatility_scales_with_movement():
    calm = realised_volatility(series([100 + (i % 2) for i in range(40)]))
    wild = realised_volatility(series([100 + (i % 2) * 20 for i in range(40)]))
    assert wild > calm > 0


def test_volatility_needs_enough_candles():
    assert realised_volatility(series([100, 101])) is None
    assert realised_volatility([]) is None


def test_volatility_is_annualised():
    """Daily log-returns alternating +1%/-1% have a daily sigma of ~1%,
    which must scale by sqrt(365) to reach the annual figure."""
    closes, price = [100.0], 100.0
    for step in range(40):
        price *= 1.01 if step % 2 == 0 else 1 / 1.01
        closes.append(price)
    annual = realised_volatility(series(closes), window=40)
    expected = math.log(1.01) * math.sqrt(365) * 100
    assert annual == pytest.approx(expected, rel=0.05)


def test_volatility_of_constant_growth_is_effectively_zero():
    daily = series([100 * (1.01 ** i) for i in range(40)])
    assert realised_volatility(daily) == pytest.approx(0.0, abs=1e-9)


# -------------------------------------------------------------- market data


def test_market_data_shapes_a_coingecko_row():
    out = market_data({"name": "Bitcoin", "market_cap": 1e12, "market_cap_rank": 1,
                       "fully_diluted_valuation": 1.1e12, "circulating_supply": 19e6,
                       "total_volume": 3e10, "ath": 120000,
                       "ath_change_percentage": -35.0})
    assert out["marketCap"] == 1e12 and out["rank"] == 1
    assert out["spotVolume24h"] == 3e10


def test_market_data_absent():
    assert market_data(None) is None


# -------------------------------------------------------------------- build


def test_build_marks_equity_perps_as_having_no_market_data():
    """A perp on Nvidia has no issuer, float or supply — the panel must
    say so rather than borrow the underlying's market cap."""
    payload = build("NVDA", "stock", series([100, 101, 102]), None, None,
                    {"oiUsd": 5_000_000})
    assert payload["marketDataAvailable"] is False
    assert payload["market"] is None
    assert payload["derivatives"]["openInterestUsd"] == 5_000_000
    assert payload["returns"]["24h"] is not None  # still fully computed


def test_build_includes_market_data_for_coins():
    payload = build("BTC", "crypto", series([100, 110]), None,
                    {"market_cap": 1e12, "market_cap_rank": 1}, None)
    assert payload["marketDataAvailable"] is True
    assert payload["market"]["rank"] == 1


def test_every_coingecko_id_maps_to_a_configured_crypto_symbol():
    for key in COINGECKO_IDS:
        assert key in SYMBOLS, f"{key} is not a configured symbol"
        assert SYMBOLS[key].asset_class == "crypto"


def test_every_crypto_symbol_has_a_coingecko_id():
    missing = [key for key, spec in SYMBOLS.items()
               if spec.asset_class == "crypto" and key not in COINGECKO_IDS]
    assert missing == []
