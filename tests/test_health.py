"""Health snapshot: the numbers an operator acts on."""

import time

from market_lens import health


def base(**over):
    args = dict(clients=2, books=40, last_trade_at=time.time(), symbols=52)
    args.update(over)
    return health.snapshot(time.time() - 300, time.time(), **args)


def test_reports_ok_while_trades_are_arriving():
    assert base()["status"] == "ok"


def test_a_process_recording_nothing_is_degraded_not_ok():
    """The failure this endpoint exists to catch: up, serving, and
    capturing no data at all."""
    assert base(last_trade_at=time.time() - 600)["status"] == "degraded"
    assert base(last_trade_at=None)["status"] == "degraded"


def test_trade_age_is_reported_and_never_negative():
    assert base(last_trade_at=time.time() - 5)["lastTradeAgeSeconds"] >= 4
    # A clock that stepped backwards must not produce a negative age.
    assert base(last_trade_at=time.time() + 30)["lastTradeAgeSeconds"] == 0.0
    assert base(last_trade_at=None)["lastTradeAgeSeconds"] is None


def test_counters_pass_through():
    reading = base(clients=7, books=41, symbols=52)
    assert reading["clients"] == 7
    assert reading["booksTracked"] == 41
    assert reading["symbols"] == 52


class TestCpuPercent:
    def test_is_cpu_seconds_over_wall_seconds(self):
        assert health.cpu_percent(30.0, 100.0) == 30.0
        assert health.cpu_percent(100.0, 100.0) == 100.0

    def test_is_unknown_before_the_ratio_means_anything(self):
        assert health.cpu_percent(0.5, 0.4) is None
        assert health.cpu_percent(0.0, 0.0) is None


def test_snapshot_survives_a_zero_uptime():
    reading = health.snapshot(now := time.time(), now, clients=0, books=0,
                              last_trade_at=None, symbols=52)
    assert reading["uptimeSeconds"] == 0.0
    assert reading["cpuPercent"] is None


def test_memory_is_absent_rather_than_wrong_when_unreadable():
    """None beats a guess: a wrong RSS is worse than no RSS."""
    value = health.rss_mb()
    assert value is None or value > 0
