"""The subscribe seed must send the order book before the history.

The book used to arrive on the next broadcast tick instead of in the seed,
measured at 1102ms after subscribe on BTC (and within 25ms of that on ETH,
SOL and MON) while ~580KB of history landed inside 400ms. The order book
is the smallest frame in the seed and the one being looked at, so it going
last was the whole felt sluggishness of switching symbols.

These lock the ordering rather than the timing: a wall-clock assertion
would be flaky, but "depth is the first frame" is exactly the property
that regressed and it is checkable.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from market_lens import server


class FakeSocket:
    """Records what the seed sends, in order."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed = False

    async def send_str(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


@pytest.fixture
def book_state(monkeypatch):
    """A collector with one venue quoting BTC and nothing else going on."""
    symbol = "BTC"
    mid = 80_000.0
    book = {
        "bids": [[mid - i, 1.0] for i in range(1, 40)],
        "asks": [[mid + i, 1.0] for i in range(1, 40)],
    }
    monkeypatch.setitem(server.STATE.books, (symbol, "binance"), book)
    server.STATE.accumulators[symbol].last_price = mid
    # The heavy history queries are not what these tests are about.
    monkeypatch.setattr(server.STORE, "recent_trades", lambda *a, **k: [])
    monkeypatch.setattr(server.STORE, "recent_liquidations", lambda *a, **k: [])
    monkeypatch.setattr(server.STORE, "positioning_series", lambda *a, **k: {})
    yield symbol
    server.STATE.books.pop((symbol, "binance"), None)


def seed(symbol: str, subscription: dict | None = None) -> list[str]:
    socket = FakeSocket()
    server.STATE.clients[socket] = subscription or {"symbol": symbol, "venues": None}
    try:
        asyncio.run(server.send_symbol_seed(socket, symbol))
    finally:
        server.STATE.clients.pop(socket, None)
    return [frame["type"] for frame in socket.sent]


def test_depth_is_the_very_first_frame(book_state):
    assert seed(book_state)[0] == "depth"


def test_the_history_still_follows(book_state):
    types = seed(book_state)
    for expected in ("tapeHistory", "heat", "cvd", "liqHistory", "liqmap"):
        assert expected in types, f"{expected} missing from the seed"
    assert types.index("depth") < types.index("heat")


def test_a_symbol_with_no_book_yet_still_seeds_its_history(book_state):
    """Depth is best-effort: a symbol nobody has quoted must not lose its
    history frames as well."""
    types = seed("ETH")
    assert "depth" not in types
    assert "tapeHistory" in types


def test_the_seed_honours_the_subscriber_s_venue_filter(book_state):
    """The frame is built from the client's own subscription, so a filter
    set in the same command applies immediately rather than one tick later."""
    types = seed(book_state, {"symbol": book_state, "venues": ["okx"], "bin": None})
    assert "depth" not in types      # okx quotes nothing in this fixture


class TestBuildDepthFrame:
    def test_returns_none_when_no_venue_has_a_book(self):
        assert server.build_depth_frame("ETH", None, None) is None

    def test_builds_a_frame_the_client_can_read(self, book_state):
        frame = json.loads(server.build_depth_frame(book_state, None, None))
        assert frame["type"] == "depth" and frame["symbol"] == book_state
        for key in ("bids", "asks", "mid", "bin", "binLadder", "walls", "signals"):
            assert key in frame, f"{key} missing from the depth frame"

    def test_an_unusable_requested_bin_falls_back(self, book_state):
        frame = json.loads(server.build_depth_frame(book_state, None, 1e9))
        assert frame["bin"] in frame["binLadder"]
