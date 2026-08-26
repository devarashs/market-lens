"""Aggregation math — the testable core of the collector."""

from market_lens.aggregate import aggregate_books, bin_price


def test_bin_price_snaps_down_consistently():
    assert bin_price(79_123.4, 10.0) == 79_120.0
    assert bin_price(0.23456, 0.0005) == 0.2345
    assert bin_price(100.0, 10.0) == 100.0


def test_aggregate_merges_venues_into_notional_bins():
    binance = {"bids": [[100.0, 2.0], [99.0, 1.0]], "asks": [[101.0, 1.0]]}
    hyperliquid = {"bids": [[100.4, 1.0]], "asks": [[101.6, 2.0]]}
    profile = aggregate_books([binance, hyperliquid], bin_size=1.0, bins_per_side=10)

    # 100.0×2 (binance) + 100.4×1 (hl) share the 100-bin, in USD notional.
    assert profile["bids"][0] == [100.0, 300.4]
    assert profile["bids"][1] == [99.0, 99.0]
    assert profile["asks"][0] == [101.0, 304.2]  # 101×1 + 101.6×2
    assert profile["mid"] == (100.4 + 101.0) / 2

    # Ordering contracts: bids high→low, asks low→high.
    bid_prices = [p for p, _ in profile["bids"]]
    ask_prices = [p for p, _ in profile["asks"]]
    assert bid_prices == sorted(bid_prices, reverse=True)
    assert ask_prices == sorted(ask_prices)


def test_aggregate_trims_to_bins_per_side():
    book = {"bids": [[100.0 - i, 1.0] for i in range(50)],
            "asks": [[101.0 + i, 1.0] for i in range(50)]}
    profile = aggregate_books([book], bin_size=1.0, bins_per_side=5)
    assert len(profile["bids"]) == 5
    assert len(profile["asks"]) == 5


def test_aggregate_handles_empty_and_one_sided_books():
    assert aggregate_books([], 1.0, 5) == {"bids": [], "asks": [], "mid": None}
    one_sided = aggregate_books([{"bids": [[10.0, 1.0]], "asks": []}], 1.0, 5)
    assert one_sided["mid"] is None
    assert one_sided["bids"] == [[10.0, 10.0]]


# ---------------------------------------------- heat ring archive rebuild


def test_heat_columns_from_archive_groups_by_snapshot():
    from market_lens.aggregate import heat_columns_from_archive
    rows = [
        (10_000, "bid", 79_000.0, 1_000_000.0),
        (10_000, "bid", 78_990.0, 500_000.0),
        (10_000, "ask", 79_010.0, 800_000.0),
        (40_000, "ask", 79_020.0, 900_000.0),
    ]
    columns = heat_columns_from_archive(rows)
    assert len(columns) == 2
    ts, bids, asks = columns[0]
    assert ts == 10 and len(bids) == 2 and asks == [[79_010.0, 800_000.0]]
    assert columns[1] == [40, [], [[79_020.0, 900_000.0]]]


def test_heat_columns_from_archive_empty():
    from market_lens.aggregate import heat_columns_from_archive
    assert heat_columns_from_archive([]) == []
