"""One broken client must never take the broadcast loops down.

The bug, live on 2026-08-28: both loops checked `ws.closed` and then
awaited `send_str`. A socket can close DURING that await, and the
resulting error escaped `while True`, killing the task permanently — for
every other client too. Trades kept arriving and the archive kept filling;
only the tape stopped, and nothing said why.

The trade loop ticks ten times a second against the depth loop's once, so
it wins that race far more often, which is why the tape died first.
"""

from __future__ import annotations

import asyncio

import pytest

from market_lens import server


class Socket:
    """A client that can fail the way real ones do."""

    def __init__(self, *, closed: bool = False, raises: Exception | None = None):
        self.closed = closed
        self.raises = raises
        self.sent: list[str] = []

    async def send_str(self, message: str) -> None:
        if self.raises is not None:
            raise self.raises
        self.sent.append(message)


@pytest.fixture(autouse=True)
def clean_clients():
    saved = dict(server.STATE.clients)
    server.STATE.clients.clear()
    yield
    server.STATE.clients.clear()
    server.STATE.clients.update(saved)


def send(ws) -> bool:
    server.STATE.clients[ws] = {"symbol": "BTC", "venues": None}
    return asyncio.run(server.send_or_drop(ws, "payload"))


def test_a_healthy_client_receives_it():
    ws = Socket()
    assert send(ws) is True
    assert ws.sent == ["payload"]


def test_a_socket_that_dies_mid_send_does_not_raise():
    """The exact race: open at the check, broken at the await."""
    ws = Socket(raises=ConnectionResetError("peer went away"))
    assert send(ws) is False


def test_any_send_failure_is_contained():
    for failure in (ConnectionResetError(), RuntimeError("closing"),
                    OSError("broken pipe"), asyncio.TimeoutError()):
        assert send(Socket(raises=failure)) is False


def test_an_already_closed_socket_is_skipped_without_sending():
    ws = Socket(closed=True)
    assert send(ws) is False
    assert ws.sent == []


def test_a_failed_client_is_dropped_so_it_cannot_fail_forever():
    """Otherwise the same dead socket costs an exception on every tick."""
    ws = Socket(raises=ConnectionResetError())
    send(ws)
    assert ws not in server.STATE.clients


def test_a_healthy_client_is_kept():
    ws = Socket()
    send(ws)
    assert ws in server.STATE.clients


def test_one_broken_client_does_not_stop_the_others():
    """The property that actually matters: the broadcast continues past a
    failure rather than the loop ending."""
    good_a, bad, good_b = Socket(), Socket(raises=ConnectionResetError()), Socket()
    for ws in (good_a, bad, good_b):
        server.STATE.clients[ws] = {"symbol": "BTC", "venues": None}

    async def broadcast():
        for ws in (good_a, bad, good_b):
            await server.send_or_drop(ws, "tick")

    asyncio.run(broadcast())
    assert good_a.sent == ["tick"]
    assert good_b.sent == ["tick"]
    assert bad not in server.STATE.clients


def test_supervise_restarts_a_loop_that_dies():
    """A loop that raises used to vanish into a Task nobody inspects."""
    attempts = []

    async def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("boom")
        # Third attempt: block so the supervisor has something to sit on.
        await asyncio.sleep(3600)

    async def drive():
        task = asyncio.create_task(server.supervise(flaky, "flaky"))
        # Restart backoff is 2s; give it room for two failures.
        await asyncio.sleep(4.5)
        task.cancel()

    server.STATE.loop_restarts.pop("flaky", None)
    asyncio.run(drive())
    assert len(attempts) >= 3, "supervisor did not restart the loop"
    assert server.STATE.loop_restarts["flaky"] >= 2
