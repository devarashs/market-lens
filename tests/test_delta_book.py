"""DeltaBook emit ordering (partial sort) and the emit throttle."""

import time

from market_lens.venues import BOOK_EMIT_LEVELS, DeltaBook


def test_emit_orders_bids_desc_asks_asc():
    book = DeltaBook()
    book.snapshot([[100, 1], [102, 2], [101, 3]], [[105, 1], [103, 2], [104, 3]])
    out = book.emit()
    assert [p for p, _ in out["bids"]] == [102.0, 101.0, 100.0]
    assert [p for p, _ in out["asks"]] == [103.0, 104.0, 105.0]


def test_emit_caps_levels_keeping_best():
    book = DeltaBook()
    book.snapshot([[float(i), 1.0] for i in range(BOOK_EMIT_LEVELS + 200)],
                  [[float(10_000 + i), 1.0] for i in range(BOOK_EMIT_LEVELS + 200)])
    out = book.emit()
    assert len(out["bids"]) == BOOK_EMIT_LEVELS
    assert out["bids"][0][0] == float(BOOK_EMIT_LEVELS + 199)  # best bid kept
    assert len(out["asks"]) == BOOK_EMIT_LEVELS
    assert out["asks"][0][0] == 10_000.0                        # best ask kept


def test_maybe_emit_throttles_then_reopens():
    book = DeltaBook()
    book.snapshot([[100, 1]], [[101, 1]])
    first = book.maybe_emit()
    assert first is not None
    assert book.maybe_emit() is None          # inside the interval: suppressed
    book._last_emit = time.monotonic() - 1.0  # age the throttle
    assert book.maybe_emit() is not None
