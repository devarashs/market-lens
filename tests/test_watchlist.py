"""Rolling 24h per-market flow: bucketing, forgetting, and the delta ratio."""

import pytest

from market_lens.watchlist import (
    BUCKET_SECONDS, BUCKETS_IN_WINDOW, bucket_of, build, delta_percent,
    market_row, prune, totals, window_start,
)

HOUR = 3_600_000
MS = 1000


def test_bucket_of_snaps_down_to_the_bucket_start():
    assert bucket_of(0) == 0
    assert bucket_of(299_000) == 0
    assert bucket_of(300_000) == 300
    assert bucket_of(301_000) == 300


def test_window_holds_a_full_day_of_buckets():
    now = 1_000_000_000_000
    span = bucket_of(now) - window_start(now)
    assert span == (BUCKETS_IN_WINDOW - 1) * BUCKET_SECONDS
    assert BUCKETS_IN_WINDOW * BUCKET_SECONDS == 24 * 3600


def test_prune_forgets_only_what_aged_out():
    buckets = {100: [1.0, 1.0], 400: [2.0, 2.0], 700: [3.0, 3.0]}
    prune(buckets, 400)
    assert sorted(buckets) == [400, 700]


def test_totals_ignore_buckets_outside_the_window():
    buckets = {100: [5.0, 0.0], 400: [1.0, 2.0], 700: [3.0, 4.0]}
    assert totals(buckets, 400) == (4.0, 6.0)


def test_totals_of_an_empty_market_are_zero():
    assert totals({}, 0) == (0.0, 0.0)


class TestDeltaPercent:
    def test_all_buying_is_a_hundred_percent(self):
        assert delta_percent(100.0, 0.0) == 100

    def test_all_selling_is_minus_a_hundred(self):
        assert delta_percent(0.0, 100.0) == -100

    def test_balanced_flow_is_zero(self):
        assert delta_percent(50.0, 50.0) == 0

    def test_it_is_a_ratio_not_an_amount(self):
        """The trap in sorting by delta: a thin one-sided market outranks a
        huge one with far more net buying in dollars."""
        thin = delta_percent(20_000, 1_000)        # $21k traded
        deep = delta_percent(102_500_000, 80_500_000)  # $183M traded, $22M net
        assert thin > deep
        assert round(deep) == 12

    def test_no_volume_is_unknown_rather_than_balanced(self):
        assert delta_percent(0.0, 0.0) is None
        assert delta_percent(-1.0, 0.0) is None


def test_market_row_carries_both_the_amount_and_the_ratio():
    row = market_row("BTC", "okx-fut", 300.0, 100.0, 80_000.0, -0.6)
    assert row["volume"] == 400
    assert row["delta"] == 200
    assert row["deltaPct"] == 50
    assert row["symbol"] == "BTC" and row["venue"] == "okx-fut"
    assert row["price"] == 80_000.0 and row["change"] == -0.6


class TestBuild:
    def now(self):
        return 1_800_000_000_000

    def test_lists_one_row_per_market_sorted_by_volume(self):
        start = bucket_of(self.now())
        flow = {
            "BTC": {"okx-fut": {start: [100.0, 50.0]},
                    "binance": {start: [900.0, 100.0]}},
            "SOL": {"hyperliquid": {start: [10.0, 10.0]}},
        }
        rows = build(flow, {"BTC": {"binance": 80_000.0}}, {"BTC": 1.5}, self.now())
        assert [(r["symbol"], r["venue"]) for r in rows] == [
            ("BTC", "binance"), ("BTC", "okx-fut"), ("SOL", "hyperliquid")]
        assert rows[0]["volume"] == 1000
        assert rows[0]["price"] == 80_000.0
        assert rows[0]["change"] == 1.5

    def test_drops_markets_that_did_not_trade_in_the_window(self):
        """With 52 symbols across 9 venues most pairs do not exist; listing
        them as empty rows would bury the ones that do."""
        stale = window_start(self.now()) - BUCKET_SECONDS
        flow = {"BTC": {"kraken": {stale: [500.0, 500.0]},
                        "binance": {bucket_of(self.now()): [1.0, 1.0]}}}
        rows = build(flow, {}, {}, self.now())
        assert [r["venue"] for r in rows] == ["binance"]

    def test_build_prunes_aged_buckets_so_they_stop_costing_memory(self):
        stale = window_start(self.now()) - BUCKET_SECONDS
        buckets = {stale: [1.0, 1.0], bucket_of(self.now()): [2.0, 2.0]}
        build({"BTC": {"binance": buckets}}, {}, {}, self.now())
        assert stale not in buckets

    def test_missing_price_or_change_is_null_not_invented(self):
        flow = {"MON": {"hyperliquid": {bucket_of(self.now()): [5.0, 1.0]}}}
        row = build(flow, {}, {}, self.now())[0]
        assert row["price"] is None and row["change"] is None

    def test_handles_an_empty_collector(self):
        assert build({}, {}, {}, self.now()) == []
