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
    assert deleted == {"trades": 1, "depth_snapshots": 2}
    assert [row["ts"] for row in store.recent_trades("BTC", limit=10)] == [900]
    assert [row[0] for row in store.depth_range("BTC", 0, 10_000)] == [900, 900]


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
