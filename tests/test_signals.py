"""Reader-logic tests: the scores must decompose the way the docs claim."""

import time

from market_lens.signals import book_signal, combined_signal, tape_signal

NOW = time.time()


def make_pressure(buy_usd, sell_usd, big_buy=0.0, big_sell=0.0, chunk=20_000):
    """Background flow as many SMALL prints (below any big threshold used in
    these tests), with explicit whale prints on top — first version lumped
    the background into single rows that were themselves threshold-sized,
    which the code correctly counted as whale flow."""
    rows = []
    for side, total in (("buy", buy_usd), ("sell", sell_usd)):
        rows += [(NOW - 120, side, chunk)] * int(total / chunk)
    if big_buy:
        rows.append((NOW - 60, "buy", big_buy))
    if big_sell:
        rows.append((NOW - 60, "sell", big_sell))
    return rows


def test_tape_balanced_is_neutral():
    signal = tape_signal(make_pressure(500_000, 500_000), 100_000, {}, now=NOW)
    assert abs(signal["score"]) < 15


def test_tape_buy_heavy_is_positive_and_decomposes():
    signal = tape_signal(make_pressure(900_000, 100_000, big_buy=200_000),
                         100_000, {}, now=NOW)
    assert signal["score"] > 40
    assert signal["parts"]["flow"] > 0.5
    assert signal["parts"]["big"] == 1.0  # only big print was a buy


def test_tape_big_prints_can_disagree_with_flow():
    # Retail-sized buying, one whale dumping: big part must go negative.
    signal = tape_signal(make_pressure(600_000, 300_000, big_sell=250_000),
                         200_000, {}, now=NOW)
    assert signal["parts"]["big"] == -1.0


def make_ring(price, columns=30, usd=2_000_000):
    return [[0, [[price, usd]], []] for _ in range(columns)]


def test_book_imbalance_drives_sign_without_walls():
    up = book_signal(0.8, {"bids": [], "asks": []}, 100.0, [], 1.0)
    down = book_signal(0.2, {"bids": [], "asks": []}, 100.0, [], 1.0)
    assert up["score"] > 30 and down["score"] < -30


def test_book_persistent_bid_wall_adds_support():
    walls = {"bids": [[99.5, 2_000_000, {}]], "asks": []}
    persistent = book_signal(0.5, walls, 100.0, make_ring(99.5), 1.0)
    fresh = book_signal(0.5, walls, 100.0, [], 1.0)  # empty ring: no history
    assert persistent["score"] > fresh["score"]
    assert persistent["strongest"]["bids"]["persistence"] == 1.0


def test_combined_flags_absorption_over_alignment():
    tape = {"score": 60.0, "parts": {}, "volume5m": 1e6}
    book = {"score": 10.0, "parts": {},
            "strongest": {"asks": {"price": 100.3, "usd": 3_000_000,
                                   "distPct": 0.3, "persistence": 0.8},
                          "bids": None}}
    combined = combined_signal(tape, book)
    assert "absorption" in combined["verdict"]


def test_combined_aligned_up():
    tape = {"score": 50.0, "parts": {}, "volume5m": 1e6}
    book = {"score": 40.0, "parts": {}, "strongest": {"asks": None, "bids": None}}
    combined = combined_signal(tape, book)
    assert "path of least resistance is up" in combined["verdict"]
    assert combined["score"] > 40
