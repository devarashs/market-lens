"""SymbolAccumulators: the per-symbol derived state that must survive a
restart — the flow write buffer and the archive fold-back."""

from market_lens.server import SymbolAccumulators


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


def test_seed_flow_on_empty_archive_is_a_no_op():
    acc = make()
    acc.seed_flow([])
    assert acc.cvd_points() == [] and acc.profile_rows() == []
    assert acc.vwap() is None
