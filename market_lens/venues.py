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
import heapq
import json

from market_lens import fastjson
import time

import websockets

from market_lens.config import (
    BINANCE_WS,
    BYBIT_WS,
    COINBASE_WS,
    HYPERLIQUID_WS,
    KRAKEN_WS,
    OKX_WS,
    SYMBOLS,
)

RECONNECT_SECONDS = 5
BOOK_EMIT_LEVELS = 400  # top-N per side handed to the aggregator
# Emitting costs a partial sort of the book; consumers read at the 0.4s
# broadcast cadence, so per-delta emits were pure waste — and on the
# 1-vCPU VPS, Coinbase's full-book feed (10k+ levels, many deltas/sec)
# pinned the core doing exactly that (py-spy, 2026-08-26).
EMIT_MIN_INTERVAL_SECONDS = 0.25


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
        # Partial sort: top-N of a 20k-level book is O(n log N), not
        # O(n log n) — the difference between 3ms and 40ms on one vCPU.
        return {
            "bids": heapq.nlargest(BOOK_EMIT_LEVELS, self.bids.items(),
                                   key=lambda kv: kv[0]),
            "asks": heapq.nsmallest(BOOK_EMIT_LEVELS, self.asks.items(),
                                    key=lambda kv: kv[0]),
        }

    def maybe_emit(self) -> dict | None:
        """Rate-limited emit for per-delta adapters: the book dict is
        always current, but a sorted snapshot is produced at most every
        EMIT_MIN_INTERVAL_SECONDS. None = updated, nothing to publish."""
        now = time.monotonic()
        last = getattr(self, "_last_emit", 0.0)
        if now - last < EMIT_MIN_INTERVAL_SECONDS:
            return None
        self._last_emit = now
        return self.emit()


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
                    message = fastjson.loads(raw)
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


async def binance_liquidation_adapter(on_liquidation) -> None:
    """Binance USDT-perp forced liquidations (<symbol>@forceOrder).

    The one public stream that broadcasts REAL liquidations as they
    happen. The forced order's side is the CLOSING side, so S=SELL means
    a long died. Normalized callback:
        on_liquidation(venue, symbol_key, {"ts", "side", "price", "size",
                                           "notional"})
    with side ∈ {"long", "short"} = who got liquidated. Same
    failure-isolation contract as every other adapter.
    """
    stream_to_key = {spec.binance: spec.key
                     for spec in SYMBOLS.values() if spec.binance}
    streams = [f"{name}@forceOrder" for name in stream_to_key]
    url = f"wss://fstream.binance.com/stream?streams={'/'.join(streams)}"

    while True:
        try:
            async with websockets.connect(url, ping_interval=20, max_size=2**20) as ws:
                _log("binance-futures: liquidation stream connected")
                async for raw in ws:
                    message = fastjson.loads(raw)
                    key = stream_to_key.get(message.get("stream", "").split("@")[0])
                    order = message.get("data", {}).get("o", {})
                    if key is None or not order:
                        continue
                    price = float(order.get("ap") or order.get("p") or 0)
                    size = float(order.get("q", 0))
                    if price <= 0 or size <= 0:
                        continue
                    on_liquidation("binance-fut", key, {
                        "ts": int(order.get("T", time.time() * 1000)),
                        "side": "long" if order.get("S") == "SELL" else "short",
                        "price": price,
                        "size": size,
                        "notional": price * size,
                    })
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"binance-futures: {error.__class__.__name__}: {error} — "
                 f"reconnecting in {RECONNECT_SECONDS}s")
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
                        await ws.send(fastjson.dumps_str({
                            "method": "subscribe",
                            "subscription": {"type": channel, "coin": coin},
                        }))
                _log("hyperliquid: connected + subscribed")

                async def keepalive() -> None:
                    while True:
                        await asyncio.sleep(45)
                        await ws.send(fastjson.dumps_str({"method": "ping"}))

                ping_task = asyncio.create_task(keepalive())
                try:
                    async for raw in ws:
                        message = fastjson.loads(raw)
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
    await _bybit_engine(on_book, on_trade, BYBIT_WS, "bybit")


async def bybit_futures_adapter(on_book, on_trade) -> None:
    """Bybit USDT-perps: same v5 protocol on the linear endpoint — the
    leveraged flow beside the spot book, as its own venue."""
    await _bybit_engine(on_book, on_trade,
                        "wss://stream.bybit.com/v5/public/linear", "bybit-fut")


async def _bybit_engine(on_book, on_trade, url: str, venue: str) -> None:
    symbol_to_key = {spec.bybit: spec.key
                     for spec in SYMBOLS.values() if spec.bybit}
    args = ([f"orderbook.200.{s}" for s in symbol_to_key]
            + [f"publicTrade.{s}" for s in symbol_to_key])
    books: dict[str, DeltaBook] = {s: DeltaBook() for s in symbol_to_key}

    while True:
        try:
            async with websockets.connect(url, ping_interval=None,
                                          max_size=2**22) as ws:
                await ws.send(fastjson.dumps_str({"op": "subscribe", "args": args}))
                _log(f"{venue}: connected + subscribed")

                async def keepalive() -> None:
                    while True:
                        await asyncio.sleep(20)
                        await ws.send(fastjson.dumps_str({"op": "ping"}))

                ping_task = asyncio.create_task(keepalive())
                try:
                    async for raw in ws:
                        message = fastjson.loads(raw)
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
                            payload = book.maybe_emit()
                            if payload is not None:
                                on_book(venue, key, payload)
                        elif topic.startswith("publicTrade.") and isinstance(data, list):
                            key = symbol_to_key.get(topic.rsplit(".", 1)[-1])
                            if key is None:
                                continue
                            for trade in data:
                                price, size = float(trade["p"]), float(trade["v"])
                                on_trade(venue, key, {
                                    "price": price, "size": size,
                                    "side": "buy" if trade.get("S") == "Buy" else "sell",
                                    "notional": price * size,
                                    "ts": int(trade.get("T", time.time() * 1000)),
                                })
                finally:
                    ping_task.cancel()
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"{venue}: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def okx_adapter(on_book, on_trade) -> None:
    """OKX spot v5: books channel (400 levels, snapshot+update) + trades."""
    await _okx_engine(on_book, on_trade,
                      {spec.okx: spec.key for spec in SYMBOLS.values() if spec.okx},
                      "okx")


OKX_INSTRUMENTS_URL = "https://www.okx.com/api/v5/public/instruments?instType=SWAP"


async def _okx_contract_values(instruments: list[str]) -> dict[str, float]:
    """Base units per contract (`ctVal`) for OKX swaps.

    OKX quotes swap sizes in CONTRACTS, not base currency, and the
    multiplier differs per instrument: one BTC-USDT-SWAP contract is
    0.01 BTC, ETH 0.1, SOL 1, DOGE 1000. Taking `sz` for base units
    overstated BTC and BNB by 100x and ETH by 10x, and understated DOGE
    by 1000x — which reached the tape as tens of thousands of phantom
    whale prints and reached the depth aggregate as an OKX wall dwarfing
    every real one. Found 2026-08-26, when calibrating the CVD backfill
    put our aggregate at 777x Binance spot for BTC but 12x for SOL — the
    one symbol whose ctVal happens to be exactly 1.
    """
    import aiohttp

    async with aiohttp.ClientSession() as session:
        async with session.get(OKX_INSTRUMENTS_URL, timeout=20) as response:
            payload = await response.json()
    return parse_contract_values(payload, instruments)


def parse_contract_values(payload: dict, instruments: list[str]) -> dict[str, float]:
    """Pull `ctVal x ctMult` per instrument out of an OKX instruments
    response, insisting that every instrument we asked about is present."""
    wanted = set(instruments)
    values = {row["instId"]: float(row["ctVal"]) * float(row.get("ctMult") or 1)
              for row in payload.get("data", [])
              if row.get("instId") in wanted}
    missing = [inst for inst in instruments if inst not in values]
    if missing:
        # Raising is the point: the caller retries, and a wrong multiplier
        # is far worse than a venue that is briefly absent.
        raise RuntimeError(f"ctVal missing for {missing}")
    return values


async def okx_futures_adapter(on_book, on_trade) -> None:
    """OKX USDT perpetual swaps: same channels, -SWAP instIds, own venue.

    Sizes arrive in contracts and are converted to base units before
    anything leaves this adapter — see `_okx_contract_values`.
    """
    inst_to_key = {f"{spec.okx}-SWAP": spec.key
                   for spec in SYMBOLS.values() if spec.okx}
    while True:
        try:
            multipliers = await _okx_contract_values(list(inst_to_key))
            break
        except Exception as error:  # noqa: BLE001 — no data beats wrong data
            _log(f"okx-fut: contract values unavailable "
                 f"({error.__class__.__name__}: {error}) — retrying in "
                 f"{RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)
    _log(f"okx-fut: contract sizes {multipliers}")
    await _okx_engine(on_book, on_trade, inst_to_key, "okx-fut",
                      size_multipliers=multipliers)


def _scale_levels(rows: list, multiplier: float) -> list:
    """[px, sz, ...] rows with size converted from contracts to base units."""
    if multiplier == 1.0:
        return [row[:2] for row in rows]
    return [[row[0], float(row[1]) * multiplier] for row in rows]


async def _okx_engine(on_book, on_trade, inst_to_key: dict, venue: str,
                      size_multipliers: dict[str, float] | None = None) -> None:
    args = ([{"channel": "books", "instId": inst} for inst in inst_to_key]
            + [{"channel": "trades", "instId": inst} for inst in inst_to_key])
    books: dict[str, DeltaBook] = {inst: DeltaBook() for inst in inst_to_key}

    while True:
        try:
            async with websockets.connect(OKX_WS, ping_interval=None,
                                          max_size=2**22) as ws:
                await ws.send(fastjson.dumps_str({"op": "subscribe", "args": args}))
                _log(f"{venue}: connected + subscribed")

                async def keepalive() -> None:
                    while True:
                        await asyncio.sleep(25)
                        await ws.send("ping")

                ping_task = asyncio.create_task(keepalive())
                try:
                    async for raw in ws:
                        if raw == "pong":
                            continue
                        message = fastjson.loads(raw)
                        channel = message.get("arg", {}).get("channel")
                        inst = message.get("arg", {}).get("instId")
                        data = message.get("data")
                        key = inst_to_key.get(inst)
                        if key is None or not data:
                            continue
                        multiplier = (size_multipliers or {}).get(inst, 1.0)
                        if channel == "books":
                            entry = data[0]
                            # OKX rows are [px, sz, liquidated, numOrders];
                            # on swaps `sz` counts contracts, not coins.
                            bids = _scale_levels(entry.get("bids", []), multiplier)
                            asks = _scale_levels(entry.get("asks", []), multiplier)
                            book = books[inst]
                            if message.get("action") == "snapshot":
                                book.snapshot(bids, asks)
                            else:
                                book.delta(bids, asks)
                            payload = book.maybe_emit()
                            if payload is not None:
                                on_book(venue, key, payload)
                        elif channel == "trades":
                            for trade in data:
                                price = float(trade["px"])
                                size = float(trade["sz"]) * multiplier
                                on_trade(venue, key, {
                                    "price": price, "size": size,
                                    "side": "buy" if trade.get("side") == "buy" else "sell",
                                    "notional": price * size,
                                    "ts": int(trade.get("ts", time.time() * 1000)),
                                })
                finally:
                    ping_task.cancel()
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"{venue}: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def binance_futures_trades_adapter(on_trade) -> None:
    """Binance USDT-perp aggTrade stream — the perp tape as venue
    'binance-fut' (its book comes from the fapi REST poll in server.py,
    mirroring the spot arrangement; its liquidations were already here)."""
    stream_to_key = {spec.binance: spec.key
                     for spec in SYMBOLS.values() if spec.binance}
    streams = [f"{name}@aggTrade" for name in stream_to_key]
    url = f"wss://fstream.binance.com/stream?streams={'/'.join(streams)}"

    while True:
        try:
            async with websockets.connect(url, ping_interval=20, max_size=2**22) as ws:
                _log("binance-fut: trade stream connected")
                async for raw in ws:
                    message = fastjson.loads(raw)
                    data = message.get("data", {})
                    key = stream_to_key.get(message.get("stream", "").split("@")[0])
                    if key is None:
                        continue
                    price, size = float(data["p"]), float(data["q"])
                    on_trade("binance-fut", key, {
                        "price": price, "size": size,
                        "side": "sell" if data.get("m") else "buy",
                        "notional": price * size,
                        "ts": int(data.get("T", time.time() * 1000)),
                    })
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"binance-fut trades: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def coinbase_adapter(on_book, on_trade) -> None:
    """Coinbase Exchange feed: level2_batch (full snapshot + batched deltas,
    public) + matches. USD-quoted — see the config note on the peg smear.
    `match.side` is the MAKER's side, so the aggressor is its opposite."""
    product_to_key = {spec.coinbase: spec.key
                      for spec in SYMBOLS.values() if spec.coinbase}
    books: dict[str, DeltaBook] = {p: DeltaBook() for p in product_to_key}

    while True:
        try:
            async with websockets.connect(COINBASE_WS, ping_interval=20,
                                          max_size=2**23) as ws:
                await ws.send(fastjson.dumps_str({
                    "type": "subscribe",
                    "product_ids": list(product_to_key),
                    "channels": ["level2_batch", "matches"],
                }))
                _log("coinbase: connected + subscribed")
                async for raw in ws:
                    message = fastjson.loads(raw)
                    kind = message.get("type")
                    product = message.get("product_id")
                    key = product_to_key.get(product)
                    if kind == "error":
                        raise RuntimeError(message.get("reason") or message.get("message"))
                    if key is None:
                        continue
                    if kind == "snapshot":
                        books[product].snapshot(message.get("bids", []),
                                                message.get("asks", []))
                        on_book("coinbase", key, books[product].emit())  # first snapshot: always
                    elif kind == "l2update":
                        bids = [[p, s] for side, p, s in message.get("changes", [])
                                if side == "buy"]
                        asks = [[p, s] for side, p, s in message.get("changes", [])
                                if side == "sell"]
                        books[product].delta(bids, asks)
                        payload = books[product].maybe_emit()
                        if payload is not None:
                            on_book("coinbase", key, payload)
                    elif kind == "match":
                        price = float(message["price"])
                        size = float(message["size"])
                        on_trade("coinbase", key, {
                            "price": price, "size": size,
                            "side": "buy" if message.get("side") == "sell" else "sell",
                            "notional": price * size,
                            "ts": int(time.time() * 1000),
                        })
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"coinbase: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)


async def kraken_adapter(on_book, on_trade) -> None:
    """Kraken WS v2: book (500 levels, snapshot+update) + trade. USD-quoted."""
    symbol_to_key = {spec.kraken: spec.key
                     for spec in SYMBOLS.values() if spec.kraken}
    books: dict[str, DeltaBook] = {s: DeltaBook() for s in symbol_to_key}

    def rows(entries: list) -> list:
        return [[e["price"], e["qty"]] for e in entries]

    while True:
        try:
            async with websockets.connect(KRAKEN_WS, ping_interval=20,
                                          max_size=2**23) as ws:
                for channel, extra in (("book", {"depth": 500}), ("trade", {})):
                    await ws.send(fastjson.dumps_str({
                        "method": "subscribe",
                        "params": {"channel": channel,
                                   "symbol": list(symbol_to_key), **extra},
                    }))
                _log("kraken: connected + subscribed")
                async for raw in ws:
                    message = fastjson.loads(raw)
                    channel = message.get("channel")
                    if channel == "book":
                        for entry in message.get("data", []):
                            symbol = entry.get("symbol")
                            key = symbol_to_key.get(symbol)
                            if key is None:
                                continue
                            book = books[symbol]
                            if message.get("type") == "snapshot":
                                book.snapshot(rows(entry.get("bids", [])),
                                              rows(entry.get("asks", [])))
                            else:
                                book.delta(rows(entry.get("bids", [])),
                                           rows(entry.get("asks", [])))
                            payload = (book.emit() if message.get("type") == "snapshot"
                                       else book.maybe_emit())
                            if payload is not None:
                                on_book("kraken", key, payload)
                    elif channel == "trade":
                        for trade in message.get("data", []):
                            key = symbol_to_key.get(trade.get("symbol"))
                            if key is None:
                                continue
                            price = float(trade["price"])
                            size = float(trade["qty"])
                            on_trade("kraken", key, {
                                "price": price, "size": size,
                                "side": "buy" if trade.get("side") == "buy" else "sell",
                                "notional": price * size,
                                "ts": int(time.time() * 1000),
                            })
        except Exception as error:  # noqa: BLE001 — isolation contract
            _log(f"kraken: {error.__class__.__name__}: {error} — reconnecting in {RECONNECT_SECONDS}s")
            await asyncio.sleep(RECONNECT_SECONDS)
