"""SymbolAccumulators: the per-symbol derived state that must survive a
restart, and the venue filter's reach into it."""

from market_lens.server import SymbolAccumulators, _kline_delta_usd


def make(price_bin: float = 10.0) -> SymbolAccumulators:
    return SymbolAccumulators(price_bin)


def trade(ts_ms: int, side: str, price: float, notional: float) -> dict:
    return {"ts": ts_ms, "side": side, "price": price,
            "size": notional / price, "notional": notional}


# ------------------------------------------------------------ write buffer


def test_trades_buffer_into_their_minute_and_venue():
    acc = make()
    acc.on_trade("BTC", trade(60_000, "buy", 79_000.0, 5_000.0), "binance")
    acc.on_trade("BTC", trade(90_000, "sell", 79_004.0, 2_000.0), "binance")
    acc.on_trade("BTC", trade(90_000, "buy", 79_004.0, 700.0), "okx")
    assert dict(acc.flow_pending[60]["binance"]) == {79_000.0: [5_000.0, 2_000.0]}
    assert dict(acc.flow_pending[60]["okx"]) == {79_000.0: [700.0, 0.0]}


def test_drain_leaves_the_open_minute_buffered():
    """The current minute is still accumulating; archiving it now would
    write it twice — once partial, once complete."""
    acc = make()
    acc.on_trade("BTC", trade(60_000, "buy", 79_000.0, 5_000.0), "binance")
    acc.on_trade("BTC", trade(120_000, "buy", 79_000.0, 1_000.0), "binance")
    drained = acc.drain_completed_flow(current_minute=120)
    assert [minute for minute, _ in drained] == [60]
    assert list(acc.flow_pending) == [120]
    # Drained minutes are gone, so a second sweep cannot double-write them.
    assert acc.drain_completed_flow(current_minute=120) == []


def test_drain_returns_minutes_in_order():
    acc = make()
    for minute in (180, 60, 120):
        acc.on_trade("BTC", trade(minute * 1000, "buy", 79_000.0, 1_000.0), "binance")
    drained = acc.drain_completed_flow(current_minute=240)
    assert [minute for minute, _ in drained] == [60, 120, 180]


# -------------------------------------------------------------- fold-back


def test_seed_flow_restores_cvd_and_profile():
    """What the archive folds back must equal what live trading built —
    the whole restart guarantee for the CVD pane and the profile."""
    live = make()
    live.on_trade("BTC", trade(60_000, "buy", 79_000.0, 5_000.0), "binance")
    live.on_trade("BTC", trade(90_000, "sell", 79_500.0, 2_000.0), "okx")
    live.on_trade("BTC", trade(120_000, "buy", 79_000.0, 1_000.0), "binance")

    # Exactly the rows flow_archive_loop would have written.
    restarted = make()
    restarted.seed_flow([
        (60_000, "binance", 79_000.0, 5_000.0, 0.0),
        (60_000, "okx", 79_500.0, 0.0, 2_000.0),
        (120_000, "binance", 79_000.0, 1_000.0, 0.0),
    ])

    assert restarted.cvd_points() == live.cvd_points()
    assert restarted.profile_rows() == live.profile_rows()
    assert restarted.vwap() == live.vwap()


def test_seed_flow_restores_venue_attribution_too():
    acc = make()
    acc.seed_flow([
        (60_000, "binance", 79_000.0, 5_000.0, 0.0),
        (60_000, "okx", 79_000.0, 1_000.0, 0.0),
    ])
    assert acc.profile_rows(venues=["okx"]) == [[79_000.0, 1_000.0, 0.0]]


def test_seed_flow_then_live_trades_accumulate_together():
    acc = make()
    acc.seed_flow([(60_000, "binance", 79_000.0, 5_000.0, 1_000.0)])
    acc.on_trade("BTC", trade(120_000, "buy", 79_000.0, 3_000.0), "binance")
    [row] = acc.profile_rows()
    assert row == [79_000.0, 8_000.0, 1_000.0]
    # CVD is cumulative across the seam: +4,000 seeded, +3,000 live.
    assert acc.cvd_points()[-1][1] == 7_000.0


def test_seed_flow_on_empty_archive_is_a_no_op():
    acc = make()
    acc.seed_flow([])
    assert acc.cvd_points() == [] and acc.profile_rows() == []
    assert acc.vwap() is None


# ------------------------------------------------------------ venue filter


def populated() -> SymbolAccumulators:
    acc = make()
    acc.on_trade("BTC", trade(60_000, "buy", 79_000.0, 10_000.0), "binance")
    acc.on_trade("BTC", trade(60_000, "sell", 79_000.0, 4_000.0), "binance")
    acc.on_trade("BTC", trade(60_000, "buy", 79_200.0, 1_000.0), "okx")
    acc.on_trade("BTC", trade(60_000, "sell", 79_200.0, 3_000.0), "kraken")
    return acc


def test_profile_unfiltered_merges_every_venue():
    rows = populated().profile_rows()
    assert rows == [[79_000.0, 10_000.0, 4_000.0], [79_200.0, 1_000.0, 3_000.0]]


def test_profile_filtered_to_one_venue():
    assert populated().profile_rows(venues=["okx"]) == [[79_200.0, 1_000.0, 0.0]]


def test_profile_filtered_to_several_venues():
    rows = populated().profile_rows(venues=["okx", "kraken"])
    assert rows == [[79_200.0, 1_000.0, 3_000.0]]


def test_pressure_respects_the_filter():
    acc = populated()
    assert acc.pressure_totals() == {"buy": 11_000.0, "sell": 7_000.0}
    assert acc.pressure_totals(["binance"]) == {"buy": 10_000.0, "sell": 4_000.0}
    assert acc.pressure_totals(["kraken"]) == {"buy": 0.0, "sell": 3_000.0}


def test_vwap_respects_the_filter():
    acc = populated()
    assert acc.vwap() != acc.vwap(["okx"])
    assert acc.vwap(["okx"]) == 79_200.0  # okx traded at one price only


def test_filtering_to_an_unknown_venue_yields_nothing():
    acc = populated()
    assert acc.profile_rows(venues=["nope"]) == []
    assert acc.pressure_totals(["nope"]) == {"buy": 0.0, "sell": 0.0}
    assert acc.vwap(["nope"]) is None


def test_taker_delta_nets_buys_against_sells_in_the_window():
    """The OI poll's side-attribution input. It had this logic inline and
    unpacked the pressure tuple positionally, which broke silently when
    the venue field was added — hence a tested method."""
    import time as clock
    acc = populated()
    now = clock.time()
    assert acc.taker_delta(300, now) == 4_000.0        # 11k buy - 7k sell
    assert acc.taker_delta(300, now, ["binance"]) == 6_000.0
    assert acc.taker_delta(300, now, ["kraken"]) == -3_000.0


def test_taker_delta_excludes_prints_outside_the_window():
    import time as clock
    acc = populated()
    # Every print above was stamped "now"; a window ending before them
    # sees nothing.
    assert acc.taker_delta(300, clock.time() + 600) == 0.0


def test_pending_cvd_minutes_respects_the_filter():
    """The write buffer tops up a filtered series for minutes the archive
    has not seen yet."""
    acc = populated()
    assert acc.pending_cvd_minutes(None)[60] == 4_000.0   # 11k buy - 7k sell
    assert acc.pending_cvd_minutes(["binance"])[60] == 6_000.0
    assert acc.pending_cvd_minutes(["kraken"])[60] == -3_000.0


# --------------------------------------------------------------- CVD series


def test_cvd_keeps_the_whole_history_not_the_last_12h():
    """The old cap returned 720 minutes however much was held, which read
    as CVD being built from almost no data."""
    acc = make()
    acc.seed_flow([(minute * 60_000, "binance", 79_000.0, 100.0, 0.0)
                   for minute in range(3_000)])
    points = acc.cvd_points()
    assert points[0][0] == 0                       # reaches the oldest minute
    assert points[-1][0] == 2_999 * 60             # and the newest
    assert points[-1][1] == 300_000.0              # 3,000 x +100 buy


def test_thinning_preserves_the_level_exactly():
    """Striding drops vertices, never contributions: a thinned series must
    sit at the same value as the dense one wherever both have a point."""
    acc = make()
    acc.seed_flow([(minute * 60_000, "binance", 79_000.0, float(minute), 0.0)
                   for minute in range(5_000)])
    dense = {ts: value for ts, value in acc.cvd_points(max_points=10_000)}
    thin = acc.cvd_points(max_points=100)
    assert len(thin) <= 101
    assert len(dense) == 5_000
    for ts, value in thin:
        assert dense[ts] == value
    assert thin[-1][1] == dense[4_999 * 60]  # the final level always survives


def test_cvd_on_a_single_minute():
    acc = make()
    acc.seed_flow([(60_000, "binance", 79_000.0, 500.0, 200.0)])
    assert acc.cvd_points() == [[60, 300.0]]


# ------------------------------------------------------------ kline backfill


def test_kline_delta_splits_taker_flow():
    """Binance gives quote volume and the taker-BUY share; the sell side is
    the remainder, so delta = 2*buy - total."""
    row = [0, "0", "0", "0", "0", "0", 0, "1000.0", 0, "0", "750.0"]
    assert _kline_delta_usd(row) == 500.0        # 750 bought, 250 sold
    row[10] = "250.0"
    assert _kline_delta_usd(row) == -500.0       # mirrored
    row[10] = "500.0"
    assert _kline_delta_usd(row) == 0.0          # balanced
