"""SymbolAccumulators: the per-symbol derived state that must survive a
restart — the flow write buffer and the archive fold-back."""

from market_lens.server import SymbolAccumulators, _kline_delta_usd


def make(price_bin: float = 10.0) -> SymbolAccumulators:
    return SymbolAccumulators(price_bin)


def trade(ts_ms: int, side: str, price: float, notional: float) -> dict:
    return {"ts": ts_ms, "side": side, "price": price,
            "size": notional / price, "notional": notional}


# ------------------------------------------------------------ write buffer


def test_trades_buffer_into_their_minute_bucket():
    acc = make()
    acc.on_trade("BTC", trade(60_000, "buy", 79_000.0, 5_000.0))
    acc.on_trade("BTC", trade(90_000, "sell", 79_004.0, 2_000.0))  # same minute+bin
    acc.on_trade("BTC", trade(120_000, "buy", 79_000.0, 1_000.0))  # next minute
    assert dict(acc.flow_pending[60]) == {79_000.0: [5_000.0, 2_000.0]}
    assert dict(acc.flow_pending[120]) == {79_000.0: [1_000.0, 0.0]}


def test_drain_leaves_the_open_minute_buffered():
    """The current minute is still accumulating; archiving it now would
    write it twice — once partial, once complete."""
    acc = make()
    acc.on_trade("BTC", trade(60_000, "buy", 79_000.0, 5_000.0))
    acc.on_trade("BTC", trade(120_000, "buy", 79_000.0, 1_000.0))
    drained = acc.drain_completed_flow(current_minute=120)
    assert [minute for minute, _ in drained] == [60]
    assert list(acc.flow_pending) == [120]
    # Drained minutes are gone, so a second sweep cannot double-write them.
    assert acc.drain_completed_flow(current_minute=120) == []


def test_drain_returns_minutes_in_order():
    acc = make()
    for minute in (180, 60, 120):
        acc.on_trade("BTC", trade(minute * 1000, "buy", 79_000.0, 1_000.0))
    drained = acc.drain_completed_flow(current_minute=240)
    assert [minute for minute, _ in drained] == [60, 120, 180]


# -------------------------------------------------------------- fold-back


def test_seed_flow_restores_cvd_and_profile():
    """What the archive folds back must equal what live trading built —
    this is the whole restart guarantee for the CVD pane and the profile."""
    live = make()
    live.on_trade("BTC", trade(60_000, "buy", 79_000.0, 5_000.0))
    live.on_trade("BTC", trade(90_000, "sell", 79_500.0, 2_000.0))
    live.on_trade("BTC", trade(120_000, "buy", 79_000.0, 1_000.0))

    # Exactly the rows flow_archive_loop would have written.
    restarted = make()
    restarted.seed_flow([
        (60_000, 79_000.0, 5_000.0, 0.0),
        (60_000, 79_500.0, 0.0, 2_000.0),
        (120_000, 79_000.0, 1_000.0, 0.0),
    ])

    assert restarted.cvd_points() == live.cvd_points()
    assert restarted.profile_rows() == live.profile_rows()
    assert restarted.vwap() == live.vwap()


def test_seed_flow_then_live_trades_accumulate_together():
    acc = make()
    acc.seed_flow([(60_000, 79_000.0, 5_000.0, 1_000.0)])
    acc.on_trade("BTC", trade(120_000, "buy", 79_000.0, 3_000.0))
    [row] = acc.profile_rows()
    assert row == [79_000.0, 8_000.0, 1_000.0]
    # CVD is cumulative across the seam: +4,000 seeded, +3,000 live.
    assert acc.cvd_points()[-1][1] == 7_000.0


# --------------------------------------------------------------- CVD series


def test_cvd_keeps_the_whole_history_not_the_last_12h():
    """The old cap returned 720 minutes however much was held, which read
    as CVD being built from almost no data."""
    acc = make()
    acc.seed_flow([(minute * 60_000, 79_000.0, 100.0, 0.0)
                   for minute in range(3_000)])
    points = acc.cvd_points()
    assert points[0][0] == 0                       # reaches the oldest minute
    assert points[-1][0] == 2_999 * 60             # and the newest
    assert points[-1][1] == 300_000.0              # 3,000 x +100 buy


def test_thinning_preserves_the_level_exactly():
    """Striding drops vertices, never contributions: a thinned series must
    sit at the same value as the dense one wherever both have a point."""
    acc = make()
    acc.seed_flow([(minute * 60_000, 79_000.0, float(minute), 0.0)
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
    acc.seed_flow([(60_000, 79_000.0, 500.0, 200.0)])
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


def test_seed_flow_on_empty_archive_is_a_no_op():
    acc = make()
    acc.seed_flow([])
    assert acc.cvd_points() == [] and acc.profile_rows() == []
    assert acc.vwap() is None
