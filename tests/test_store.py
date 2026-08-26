"""LensStore: round-trips, ordering, range boundaries, pruning, CSV import."""

import csv

import pytest

from market_lens.store import DEPTH_ARCHIVE_BINS_PER_SIDE, LensStore


@pytest.fixture()
def store(tmp_path):
    handle = LensStore(tmp_path / "lens.db")
    yield handle
    handle.close()


def make_trade(ts=1000, side="buy", price=79_000.0, size=1.5, notional=118_500.0):
    return {"ts": ts, "side": side, "price": price, "size": size,
            "notional": notional}


# ------------------------------------------------------------------- trades


def test_trade_round_trip_preserves_shape(store):
    store.insert_trade("BTC", "binance", make_trade(notional=118_500.123))
    [row] = store.recent_trades("BTC", limit=10)
    assert row == {"ts": 1000, "venue": "binance", "side": "buy",
                   "price": 79_000.0, "size": 1.5, "notional": 118_500.12}


def test_recent_trades_empty_store(store):
    assert store.recent_trades("BTC", limit=10) == []


def test_recent_trades_oldest_first_and_limited(store):
    for ts in (300, 100, 200, 400):
        store.insert_trade("BTC", "binance", make_trade(ts=ts))
    rows = store.recent_trades("BTC", limit=3)
    # Limit keeps the NEWEST 3, returned oldest-first for the seed merge.
    assert [row["ts"] for row in rows] == [200, 300, 400]


def test_recent_trades_filters_by_symbol(store):
    store.insert_trade("BTC", "binance", make_trade(ts=1))
    store.insert_trade("ETH", "okx", make_trade(ts=2))
    assert [row["ts"] for row in store.recent_trades("ETH", limit=10)] == [2]


def test_insert_trade_rejects_bad_side(store):
    with pytest.raises(Exception):
        store.insert_trade("BTC", "binance", make_trade(side="yolo"))


# -------------------------------------------------------------------- depth


def make_profile(bids=2, asks=2):
    return {
        "bids": [[79_000.0 - 10 * i, 1_000_000.0 + i] for i in range(bids)],
        "asks": [[79_010.0 + 10 * i, 2_000_000.0 + i] for i in range(asks)],
    }


def test_depth_snapshot_round_trip(store):
    store.insert_depth_snapshot("BTC", 5000, make_profile())
    rows = store.depth_range("BTC", 0, 10_000)
    assert len(rows) == 4
    assert (5000, "bid", 79_000.0, 1_000_000.0) in rows
    assert (5000, "ask", 79_020.0, 2_000_001.0) in rows


def test_depth_snapshot_caps_bins_per_side(store):
    wide = make_profile(bids=DEPTH_ARCHIVE_BINS_PER_SIDE + 30,
                        asks=DEPTH_ARCHIVE_BINS_PER_SIDE + 30)
    store.insert_depth_snapshot("BTC", 5000, wide)
    rows = store.depth_range("BTC", 0, 10_000)
    assert len(rows) == 2 * DEPTH_ARCHIVE_BINS_PER_SIDE


def test_depth_range_boundaries_inclusive(store):
    for ts in (100, 200, 300):
        store.insert_depth_snapshot("BTC", ts, make_profile(bids=1, asks=0))
    inside = store.depth_range("BTC", 100, 200)
    assert [row[0] for row in inside] == [100, 200]
    assert store.depth_range("BTC", 301, 400) == []


def test_depth_snapshot_empty_profile_writes_nothing(store):
    store.insert_depth_snapshot("BTC", 5000, {"bids": [], "asks": []})
    assert store.counts()["depth_snapshots"] == 0


# ---------------------------------------------------------------- retention


def test_prune_before_removes_old_keeps_new(store):
    store.insert_trade("BTC", "binance", make_trade(ts=100))
    store.insert_trade("BTC", "binance", make_trade(ts=900))
    store.insert_depth_snapshot("BTC", 100, make_profile(bids=1, asks=1))
    store.insert_depth_snapshot("BTC", 900, make_profile(bids=1, asks=1))
    deleted = store.prune_before(500)
    # Tables joined this dict as the schema grew: "liquidations" with the
    # liq map, then "oi_observations"/"flow_minutes" with the persistence
    # audit — prune_before deliberately walks every table.
    assert deleted == {"trades": 1, "depth_snapshots": 2, "liquidations": 0,
                       "oi_observations": 0, "flow_minutes": 0,
                       "positioning": 0}
    assert [row["ts"] for row in store.recent_trades("BTC", limit=10)] == [900]
    assert [row[0] for row in store.depth_range("BTC", 0, 10_000)] == [900, 900]


DAY_MS = 86_400_000


def test_apply_retention_is_per_table(store):
    now = 30 * DAY_MS
    store.insert_trade("BTC", "binance", make_trade(ts=now - 20 * DAY_MS))
    store.insert_depth_snapshot("BTC", now - 20 * DAY_MS, make_profile(bids=1, asks=0))
    store.insert_liquidation("BTC", "binance-fut", {
        "ts": now - 20 * DAY_MS, "side": "long", "price": 1.0, "size": 1.0,
        "notional": 1.0})
    deleted = store.apply_retention(
        {"depth_snapshots": 14, "trades": 90, "liquidations": None}, now)
    # Depth aged out; trades are inside their window; liquidations are
    # never pruned, so the policy does not even name a cutoff for them.
    assert deleted == {"depth_snapshots": 1, "trades": 0}
    assert store.counts()["liquidations"] == 1
    assert store.counts()["trades"] == 1


def test_apply_retention_rejects_unknown_table(store):
    with pytest.raises(KeyError):
        store.apply_retention({"tradez": 7}, 0)


# ------------------------------------------------------------ derived flow


def test_flow_minute_round_trip_and_ordering(store):
    store.insert_flow_minute("BTC", 120_000, {
        "binance": {79_000.0: [5_000.0, 1_000.0], 79_010.0: [0.0, 2_500.567]}})
    store.insert_flow_minute("BTC", 60_000, {"okx": {79_000.0: [100.0, 0.0]}})
    store.insert_flow_minute("ETH", 60_000, {"binance": {4_000.0: [7.0, 8.0]}})
    rows = store.flow_minutes_since("BTC", 0)
    assert [row[0] for row in rows] == [60_000, 120_000, 120_000]
    assert (120_000, "binance", 79_010.0, 0.0, 2_500.57) in rows
    assert store.flow_minutes_since("BTC", 120_000) == [
        (120_000, "binance", 79_000.0, 5_000.0, 1_000.0),
        (120_000, "binance", 79_010.0, 0.0, 2_500.57),
    ]


def test_flow_minute_empty_bins_writes_nothing(store):
    store.insert_flow_minute("BTC", 60_000, {})
    store.insert_flow_minute("BTC", 60_000, {"binance": {}})
    assert store.counts()["flow_minutes"] == 0


def test_cvd_series_sums_per_minute_across_venues(store):
    store.insert_flow_minute("BTC", 60_000, {
        "binance": {79_000.0: [5_000.0, 1_000.0]},
        "okx": {79_010.0: [500.0, 2_000.0]},
    })
    store.insert_flow_minute("BTC", 120_000, {"binance": {79_000.0: [0.0, 300.0]}})
    # Minute 60: (5000-1000) + (500-2000) = 2500. Minute 120: -300.
    assert store.cvd_series("BTC", 0) == [(60, 2_500.0), (120, -300.0)]


def test_cvd_series_filters_by_venue(store):
    store.insert_flow_minute("BTC", 60_000, {
        "binance": {79_000.0: [5_000.0, 1_000.0]},
        "okx": {79_010.0: [500.0, 2_000.0]},
    })
    assert store.cvd_series("BTC", 0, ["binance"]) == [(60, 4_000.0)]
    assert store.cvd_series("BTC", 0, ["okx"]) == [(60, -1_500.0)]
    assert store.cvd_series("BTC", 0, ["binance", "okx"]) == [(60, 2_500.0)]
    assert store.cvd_series("BTC", 0, ["nope"]) == []


def test_cvd_series_honours_the_start_bound(store):
    store.insert_flow_minute("BTC", 60_000, {"binance": {79_000.0: [1.0, 0.0]}})
    store.insert_flow_minute("BTC", 120_000, {"binance": {79_000.0: [2.0, 0.0]}})
    assert store.cvd_series("BTC", 120_000) == [(120, 2.0)]


def test_venue_column_is_added_to_a_pre_existing_table(tmp_path):
    """The archive predates venue attribution; opening an old database must
    migrate it rather than fail or silently ignore the column."""
    import sqlite3
    path = tmp_path / "old.db"
    legacy = sqlite3.connect(path)
    legacy.execute(
        "CREATE TABLE flow_minutes (ts INTEGER NOT NULL, symbol TEXT NOT NULL,"
        " price_bin REAL NOT NULL, buy_usd REAL NOT NULL, sell_usd REAL NOT NULL)")
    legacy.execute("INSERT INTO flow_minutes VALUES (60000, 'BTC', 79000.0, 9.0, 1.0)")
    legacy.commit()
    legacy.close()

    store = LensStore(path)
    try:
        # The old row survives, unattributed, and still counts unfiltered.
        assert store.cvd_series("BTC", 0) == [(60, 8.0)]
        # It is invisible to a filtered total: we do not know its venue, and
        # assigning it to one would be a guess.
        assert store.cvd_series("BTC", 0, ["binance"]) == []
        store.insert_flow_minute("BTC", 120_000, {"binance": {79_000.0: [3.0, 0.0]}})
        assert store.cvd_series("BTC", 0, ["binance"]) == [(120, 3.0)]
    finally:
        store.close()


# ---------------------------------------------------------- positioning


def test_positioning_round_trip_normalises_to_net_percent(store):
    from market_lens.positioning import PositioningPoint
    store.insert_positioning("BTC", "top-positions", [
        PositioningPoint(60_000, 0.6, 0.4),
        PositioningPoint(120_000, 0.45, 0.55),
    ])
    store.insert_positioning("BTC", "bitfinex-margin", [
        PositioningPoint(60_000, 90_000.0, 10_000.0)])
    series = store.positioning_series("BTC", 0)
    assert series["top-positions"] == [[60, 20.0], [120, -10.0]]
    assert series["bitfinex-margin"] == [[60, 80.0]]


def test_positioning_refetch_upserts_instead_of_duplicating(store):
    """Both APIs serve a trailing window, so every pass re-sends points we
    already hold."""
    from market_lens.positioning import PositioningPoint
    first = store.insert_positioning("BTC", "top-positions",
                                     [PositioningPoint(60_000, 0.6, 0.4)])
    again = store.insert_positioning("BTC", "top-positions",
                                     [PositioningPoint(60_000, 0.7, 0.3)])
    assert (first, again) == (1, 0)
    assert store.positioning_series("BTC", 0)["top-positions"] == [[60, 40.0]]


def test_positioning_filters_by_symbol_and_start(store):
    from market_lens.positioning import PositioningPoint
    store.insert_positioning("BTC", "top-positions", [PositioningPoint(60_000, 1, 0)])
    store.insert_positioning("ETH", "top-positions", [PositioningPoint(60_000, 0, 1)])
    assert store.positioning_series("ETH", 0)["top-positions"] == [[60, -100.0]]
    assert store.positioning_series("BTC", 120_000) == {}


def test_positioning_empty_points_is_a_no_op(store):
    assert store.insert_positioning("BTC", "top-positions", []) == 0


# ---------------------------------------------------- OI observations (liq map)


def test_oi_observation_round_trip(store):
    store.insert_oi_observation("BTC", 1000, 79_000.0, 1e9, -250_000.0)
    store.insert_oi_observation("BTC", 500, 78_900.0, 9e8, 100_000.0)
    store.insert_oi_observation("ETH", 1000, 4_000.0, 5e8, 0.0)
    assert store.oi_observations_since("BTC", 0) == [
        (500, 78_900.0, 9e8, 100_000.0),
        (1000, 79_000.0, 1e9, -250_000.0),
    ]
    assert store.oi_observations_since("BTC", 600) == [
        (1000, 79_000.0, 1e9, -250_000.0)]


# ------------------------------------------------------------- liquidations


def test_liquidation_round_trip(store):
    store.insert_liquidation("BTC", "binance-fut", {
        "ts": 1000, "side": "long", "price": 79_000.0, "size": 2.0,
        "notional": 158_000.004})
    [row] = store.recent_liquidations("BTC", limit=10)
    assert row == {"ts": 1000, "venue": "binance-fut", "side": "long",
                   "price": 79_000.0, "size": 2.0, "notional": 158_000.0}
    assert store.recent_liquidations("ETH", limit=10) == []


def test_liquidation_rejects_buy_sell_sides(store):
    with pytest.raises(Exception):
        store.insert_liquidation("BTC", "binance-fut", {
            "ts": 1, "side": "sell", "price": 1.0, "size": 1.0, "notional": 1.0})


# -------------------------------------------------------------- persistence


def test_data_survives_reopen(tmp_path):
    path = tmp_path / "lens.db"
    first = LensStore(path)
    first.insert_trade("BTC", "binance", make_trade())
    first.close()
    second = LensStore(path)
    try:
        assert second.counts()["trades"] == 1
    finally:
        second.close()


# --------------------------------------------------------------- CSV import


def write_csv(path, header, rows):
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


TRADES_HEADER = ["ts", "venue", "side", "price", "size", "notional"]
DEPTH_HEADER = ["ts", "side", "price_bin", "notional_usd"]


def test_import_csv_archive(store, tmp_path):
    write_csv(tmp_path / "BTC_trades.csv", TRADES_HEADER, [
        [1000, "hyperliquid", "buy", 79_000.0, 1.5, 118_500.0],
        [2000, "binance", "sell", 79_100.0, 2.0, 158_200.0],
    ])
    write_csv(tmp_path / "BTC_depth.csv", DEPTH_HEADER, [
        [1000, "bid", 79_000.0, 2_910_548.44],
    ])
    imported = store.import_csv_archive(tmp_path)
    assert imported == {"trades": 2, "depth_snapshots": 1, "skipped_rows": 0}
    assert [row["venue"] for row in store.recent_trades("BTC", limit=10)] == \
        ["hyperliquid", "binance"]
    assert store.depth_range("BTC", 0, 10_000) == [(1000, "bid", 79_000.0,
                                                    2_910_548.44)]


def test_import_skips_symbols_already_present(store, tmp_path):
    write_csv(tmp_path / "BTC_trades.csv", TRADES_HEADER, [
        [1000, "binance", "buy", 79_000.0, 1.5, 118_500.0],
    ])
    first = store.import_csv_archive(tmp_path)
    second = store.import_csv_archive(tmp_path)
    assert first["trades"] == 1
    assert second["trades"] == 0
    assert store.counts()["trades"] == 1


def test_import_skips_torn_rows_not_the_migration(store, tmp_path):
    write_csv(tmp_path / "BTC_trades.csv", TRADES_HEADER, [
        [1000, "binance", "buy", 79_000.0, 1.5, 118_500.0],
        [2000, "binance", "sell", "79 100.5x", 2.0, 158_200.0],  # corrupt price
        [3000, "binance"],                                        # torn tail
    ])
    imported = store.import_csv_archive(tmp_path)
    assert imported["trades"] == 1
    assert imported["skipped_rows"] == 2


def test_import_empty_directory(store, tmp_path):
    assert store.import_csv_archive(tmp_path) == \
        {"trades": 0, "depth_snapshots": 0, "skipped_rows": 0}
