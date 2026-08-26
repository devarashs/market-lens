"""Net positioning: normalisation, parsing, and the alignment rule."""

from market_lens.positioning import (
    PositioningPoint,
    net_pct,
    parse_binance_ratio,
    parse_bitfinex_sizes,
    thin,
)


# --------------------------------------------------------------- net_pct


def test_net_pct_spans_all_short_to_all_long():
    assert net_pct(1.0, 0.0) == 100.0
    assert net_pct(0.0, 1.0) == -100.0
    assert net_pct(0.5, 0.5) == 0.0


def test_net_pct_is_scale_free():
    """A ratio and a position size must land on the same axis."""
    assert net_pct(0.75, 0.25) == net_pct(90_000.0, 30_000.0) == 50.0


def test_net_pct_on_an_empty_book():
    assert net_pct(0.0, 0.0) == 0.0
    assert net_pct(-1.0, 1.0) == 0.0  # nonsense input, not a crash


def test_point_exposes_net_pct():
    assert PositioningPoint(1000, 3.0, 1.0).net_pct == 50.0


# ------------------------------------------------------ Binance ratio rows


BINANCE_ROWS = [
    {"symbol": "BTCUSDT", "longAccount": "0.6", "shortAccount": "0.4",
     "longShortRatio": "1.5", "timestamp": 1000},
    {"symbol": "BTCUSDT", "longAccount": "0.45", "shortAccount": "0.55",
     "longShortRatio": "0.818", "timestamp": 2000},
]


def test_parses_binance_shares_into_net():
    points = parse_binance_ratio(BINANCE_ROWS)
    assert [round(point.net_pct, 1) for point in points] == [20.0, -10.0]
    assert [point.ts_ms for point in points] == [1000, 2000]


def test_skips_malformed_binance_rows_without_dropping_the_rest():
    rows = [BINANCE_ROWS[0], {"longAccount": "x", "shortAccount": "0.5",
                              "timestamp": 3000}, {}, BINANCE_ROWS[1]]
    assert len(parse_binance_ratio(rows)) == 2


def test_empty_binance_response():
    assert parse_binance_ratio([]) == []


# --------------------------------------------------- Bitfinex margin sizes


def test_parses_bitfinex_sides_on_shared_timestamps():
    longs = [[2000, 90_000.0], [1000, 80_000.0]]
    shorts = [[2000, 10_000.0], [1000, 20_000.0]]
    points = parse_bitfinex_sizes(longs, shorts)
    assert [point.ts_ms for point in points] == [1000, 2000]  # sorted oldest first
    assert points[0].net_pct == 60.0   # 80k vs 20k
    assert points[1].net_pct == 80.0   # 90k vs 10k


def test_unmatched_timestamps_are_dropped_not_interpolated():
    """The two sides are separate requests and can land a sample apart.
    Pairing them by guesswork would invent a reading."""
    longs = [[1000, 80_000.0], [2000, 90_000.0]]
    shorts = [[1000, 20_000.0]]
    points = parse_bitfinex_sizes(longs, shorts)
    assert [point.ts_ms for point in points] == [1000]


def test_bitfinex_ignores_malformed_rows():
    points = parse_bitfinex_sizes([[1000, 5.0], "junk", [7]], [[1000, 5.0]])
    assert len(points) == 1
    assert points[0].net_pct == 0.0  # balanced


def test_bitfinex_with_no_shorts_at_all():
    points = parse_bitfinex_sizes([[1000, 90_000.0]], [[1000, 0.0]])
    assert points[0].net_pct == 100.0


# ------------------------------------------------------------------ thin


def test_thin_leaves_short_series_alone():
    points = [PositioningPoint(index, 1.0, 1.0) for index in range(10)]
    assert thin(points, 100) is points


def test_thin_caps_length_and_keeps_the_newest():
    points = [PositioningPoint(index, 1.0, 1.0) for index in range(1000)]
    kept = thin(points, 100)
    assert len(kept) <= 101
    assert kept[-1].ts_ms == 999
    assert kept[0].ts_ms == 0
