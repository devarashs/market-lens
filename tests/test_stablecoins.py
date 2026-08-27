"""Stablecoin supply summary: parsing, change windows, percentile."""

from market_lens.stablecoins import (
    parse_supply_series, pct_change_days, percentile_of_last, summarise,
)


def rows(values, start=1_700_000_000):
    return [{"date": str(start + i * 86400),
             "totalCirculatingUSD": {"peggedUSD": v, "peggedEUR": 1.0}}
            for i, v in enumerate(values)]


def test_parses_only_usd_pegged_and_sorts():
    series = parse_supply_series(rows([100.0, 110.0]))
    assert [value for _, value in series] == [100.0, 110.0]


def test_skips_malformed_rows_without_dropping_the_rest():
    bad = rows([100.0, 110.0])
    bad.insert(1, {"date": "x", "totalCirculatingUSD": {"peggedUSD": 5}})
    bad.insert(2, {"totalCirculatingUSD": {}})
    assert len(parse_supply_series(bad)) == 2


def test_empty_input():
    assert parse_supply_series([]) == []
    assert parse_supply_series(None) == []


def test_pct_change_over_a_window():
    series = [(i, 100.0 + i) for i in range(20)]
    assert pct_change_days(series, 7) == (119 / 112 - 1) * 100


def test_pct_change_needs_enough_history():
    assert pct_change_days([(0, 100.0)], 7) is None


def test_pct_change_guards_a_zero_base():
    assert pct_change_days([(i, 0.0) for i in range(10)], 7) is None


def test_percentile_locates_the_newest_value():
    assert percentile_of_last(list(range(100))) == 100.0      # highest ever
    assert percentile_of_last([99.0] * 99 + [50.0]) == 0.0    # lowest ever
    assert percentile_of_last([]) is None


def test_summarise_shape():
    out = summarise(parse_supply_series(rows([100.0 + i for i in range(200)])))
    assert out["available"] is True
    assert out["supplyUsd"] == 299.0
    assert out["change7dPct"] is not None
    assert 0 <= out["percentileOfYear"] <= 100
    assert len(out["history"]) == 120


def test_summarise_on_no_data():
    assert summarise([]) == {"available": False}
