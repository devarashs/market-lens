"""Venue WebSocket adapters → one normalized event stream.

Each adapter is an async task that connects, subscribes, normalizes, and
pushes events into the shared state via callbacks:

    on_book(venue, symbol_key, {"bids": [[price, size], ...], "asks": ...})
    on_trade(venue, symbol_key, {"price", "size", "side", "notional", "ts"})

Failure isolation: an adapter that errors logs, sleeps, and reconnects —
one venue dying never affects the others. Binance uses partial top-20 book
snapshots (no delta bookkeeping to get wrong); Hyperliquid pushes full book
snapshots natively.
"""

from __future__ import annotations

import asyncio
import json
import time

import websockets

from market_lens.config import BINANCE_WS, BYBIT_WS, HYPERLIQUID_WS, OKX_WS, SYMBOLS

RECONNECT_SECONDS = 5
BOOK_EMIT_LEVELS = 400  # top-N per side handed to the aggregator


class DeltaBook:
    """Maintains one venue book from snapshot + delta messages.

    Sequence-gap detection is deliberately omitted at this stage: a corrupted
    book self-heals on the venue's next snapshot or the adapter's reconnect,
    and this is a visualization, not an execution path.
    """

    def __init__(self) -> None:
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}

    def snapshot(self, bids: list, asks: list) -> None:
        self.bids = {float(p): float(s) for p, s in bids}
        self.asks = {float(p): float(s) for p, s in asks}

    def delta(self, bids: list, asks: list) -> None:
        for side, updates in ((self.bids, bids), (self.asks, asks)):
            for price, size in updates:
                price, size = float(price), float(size)
                if size == 0:
                    side.pop(price, None)
                else:
                    side[price] = size

    def emit(self) -> dict:
        return {
            "bids": sorted(self.bids.items(), key=lambda kv: -kv[0])[:BOOK_EMIT_LEVELS],
            "asks": sorted(self.asks.items(), key=lambda kv: kv[0])[:BOOK_EMIT_LEVELS],
        }


def _log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


async def binance_adapter(on_book, on_trade) -> None:
    """Binance spot trades via WebSocket (aggTrade per symbol).

    The Binance BOOK deliberately comes from the REST full-depth poll in
    server.py instead of the depth20 stream: top-20 levels only ever showed
    near-touch liquidity, and the whole point of the depth overlay is the
    walls sitting further out. Trades stay on the stream (latency matters
    for the tape; 3s-stale walls are fine).
    """
    stream_to_key = {}
    streams = []
    for spec in SYMBOLS.values():
        if spec.binance is None:
            continue
        streams += [f"{spec.binance}@aggTrade"]
        stream_to_key[spec.binance] = spec.key
    url = f"{BINANCE_WS}?streams={'/'.join(streams)}"

    while True:
        try:
            async with websockets.connect(url, ping_interval=20, max_size=2**22) as ws:
                _log("binance: connected")
                async for raw in ws:
                    message = json.loads(raw)
                    stream = message.get("stream", "")
                    data = message.get("data", {})
                    key = stream_to_key.get(stream.split("@")[0])
                    if key is None:
                        continue
                    if "@aggTrade" in stream:
                        price, size = float(data["p"]), float(data["q"])
                        on_trade("binance", key, {
                            "price": price, "size": size,
                            # m=True → buyer was the maker → aggressor SOLD.
                            "side": "sell" if data.get("m") else "buy",
                            "notional": price * size,
                            "ts": int(data.get("T", time.time() * 1000)),
                        })
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"binance: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def hyperliquid_adapter(on_book, on_trade) -> None:
    """Hyperliquid perps: l2Book (full snapshots) + trades per coin."""
    coin_to_key = {spec.hyperliquid: spec.key
                   for spec in SYMBOLS.values() if spec.hyperliquid}

    while True:
        try:
            async with websockets.connect(HYPERLIQUID_WS, ping_interval=20,
                                          max_size=2**22) as ws:
                for coin in coin_to_key:
                    for channel in ("l2Book", "trades"):
                        await ws.send(json.dumps({
                            "method": "subscribe",
                            "subscription": {"type": channel, "coin": coin},
                        }))
                _log("hyperliquid: connected + subscribed")

                async def keepalive() -> None:
                    while True:
                        await asyncio.sleep(45)
                        await ws.send(json.dumps({"method": "ping"}))

                ping_task = asyncio.create_task(keepalive())
                try:
                    async for raw in ws:
                        message = json.loads(raw)
                        channel = message.get("channel")
                        data = message.get("data")
                        if channel == "l2Book" and isinstance(data, dict):
                            key = coin_to_key.get(data.get("coin"))
                            levels = data.get("levels", [[], []])
                            if key:
                                on_book("hyperliquid", key, {
                                    "bids": [[float(l["px"]), float(l["sz"])] for l in levels[0]],
                                    "asks": [[float(l["px"]), float(l["sz"])] for l in levels[1]],
                                })
                        elif channel == "trades" and isinstance(data, list):
                            for trade in data:
                                key = coin_to_key.get(trade.get("coin"))
                                if not key:
                                    continue
                                price, size = float(trade["px"]), float(trade["sz"])
                                on_trade("hyperliquid", key, {
                                    "price": price, "size": size,
                                    # HL taker side: "B" = aggressive buy.
                                    "side": "buy" if trade.get("side") == "B" else "sell",
                                    "notional": price * size,
                                    "ts": int(trade.get("time", time.time() * 1000)),
                                })
                finally:
                    ping_task.cancel()
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"hyperliquid: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def bybit_adapter(on_book, on_trade) -> None:
    """Bybit spot v5: orderbook.200 (snapshot+delta) + publicTrade."""
    symbol_to_key = {spec.bybit: spec.key
                     for spec in SYMBOLS.values() if spec.bybit}
    args = ([f"orderbook.200.{s}" for s in symbol_to_key]
            + [f"publicTrade.{s}" for s in symbol_to_key])
    books: dict[str, DeltaBook] = {s: DeltaBook() for s in symbol_to_key}

    while True:
        try:
            async with websockets.connect(BYBIT_WS, ping_interval=None,
                                          max_size=2**22) as ws:
                await ws.send(json.dumps({"op": "subscribe", "args": args}))
                _log("bybit: connected + subscribed")

                async def keepalive() -> None:
                    while True:
                        await asyncio.sleep(20)
                        await ws.send(json.dumps({"op": "ping"}))

                ping_task = asyncio.create_task(keepalive())
                try:
                    async for raw in ws:
                        message = json.loads(raw)
                        topic = message.get("topic", "")
                        data = message.get("data")
                        if topic.startswith("orderbook."):
                            symbol = topic.rsplit(".", 1)[-1]
                            key = symbol_to_key.get(symbol)
                            if key is None or not isinstance(data, dict):
                                continue
                            book = books[symbol]
                            if message.get("type") == "snapshot":
                                book.snapshot(data.get("b", []), data.get("a", []))
                            else:
                                book.delta(data.get("b", []), data.get("a", []))
                            on_book("bybit", key, book.emit())
                        elif topic.startswith("publicTrade.") and isinstance(data, list):
                            key = symbol_to_key.get(topic.rsplit(".", 1)[-1])
                            if key is None:
                                continue
                            for trade in data:
                                price, size = float(trade["p"]), float(trade["v"])
                                on_trade("bybit", key, {
                                    "price": price, "size": size,
                                    "side": "buy" if trade.get("S") == "Buy" else "sell",
                                    "notional": price * size,
                                    "ts": int(trade.get("T", time.time() * 1000)),
                                })
                finally:
                    ping_task.cancel()
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"bybit: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def okx_adapter(on_book, on_trade) -> None:
    """OKX spot v5: books channel (400 levels, snapshot+update) + trades."""
    inst_to_key = {spec.okx: spec.key for spec in SYMBOLS.values() if spec.okx}
    args = ([{"channel": "books", "instId": inst} for inst in inst_to_key]
            + [{"channel": "trades", "instId": inst} for inst in inst_to_key])
    books: dict[str, DeltaBook] = {inst: DeltaBook() for inst in inst_to_key}

    while True:
        try:
            async with websockets.connect(OKX_WS, ping_interval=None,
                                          max_size=2**22) as ws:
                await ws.send(json.dumps({"op": "subscribe", "args": args}))
                _log("okx: connected + subscribed")

                async def keepalive() -> None:
                    while True:
                        await asyncio.sleep(25)
                        await ws.send("ping")

                ping_task = asyncio.create_task(keepalive())
                try:
                    async for raw in ws:
                        if raw == "pong":
                            continue
                        message = json.loads(raw)
                        channel = message.get("arg", {}).get("channel")
                        inst = message.get("arg", {}).get("instId")
                        data = message.get("data")
                        key = inst_to_key.get(inst)
                        if key is None or not data:
                            continue
                        if channel == "books":
                            entry = data[0]
                            # OKX rows are [px, sz, liquidated, numOrders].
                            bids = [row[:2] for row in entry.get("bids", [])]
                            asks = [row[:2] for row in entry.get("asks", [])]
                            book = books[inst]
                            if message.get("action") == "snapshot":
                                book.snapshot(bids, asks)
                            else:
                                book.delta(bids, asks)
                            on_book("okx", key, book.emit())
                        elif channel == "trades":
                            for trade in data:
                                price, size = float(trade["px"]), float(trade["sz"])
                                on_trade("okx", key, {
                                    "price": price, "size": size,
                                    "side": "buy" if trade.get("side") == "buy" else "sell",
                                    "notional": price * size,
                                    "ts": int(trade.get("ts", time.time() * 1000)),
                                })
                finally:
                    ping_task.cancel()
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"okx: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)
