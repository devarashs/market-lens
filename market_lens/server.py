"""Market Lens server: collector, aggregators, recorder, and web host.

Feature set (L1 "rich tool" sprint, 2026-08-25):
  depth      — books aggregated across venues; Binance side comes from REST
               full-depth polling (walls beyond top-of-book), Hyperliquid
               from its WS snapshots; per-client venue filtering
  tape       — every trade feeds the accumulators; big ones hit the tape
  cvd        — cumulative volume delta (buy − sell notional), minute buckets
  profile    — executed-volume-by-price bins (the "facts" layer)
  pressure   — rolling 5-minute aggressor buy/sell notional
  heat       — in-memory ring of binned book snapshots (~1h @ 10s): the live
               liquidity heatmap, no disk history needed
  metrics    — funding, next funding, open interest, 24h change per symbol
  recording  — depth snapshots (30s) + big trades to data_recorded/ (L0)

Protocol (server → client), all JSON over /ws after {"cmd":"subscribe",
"symbol":..., "venues":[...]?}:
  {type:"depth", bids, asks, mid, venues, imbalance, walls, pressure, profile}
  {type:"trade", ...}        {type:"heat", cols}/{type:"heatcol", col}
  {type:"cvd", points}       {type:"metrics", data}  (all symbols)
"""

from __future__ import annotations

import asyncio
import csv
import json
import time
from collections import defaultdict, deque

from aiohttp import ClientSession, WSMsgType, web

from market_lens.aggregate import aggregate_books, bin_price, book_imbalance, top_walls
from market_lens.signals import book_signal, combined_signal, tape_signal
from market_lens.config import (
    BINANCE_REST,
    BINANCE_REST_FALLBACK,
    DEPTH_BINS_PER_SIDE,
    DEPTH_BROADCAST_SECONDS,
    DEPTH_RECORD_SECONDS,
    HTTP_PORT,
    HYPERLIQUID_REST,
    RECORD_DIR,
    SYMBOLS,
    WEB_DIR,
)
from market_lens.venues import (
    binance_adapter,
    bybit_adapter,
    hyperliquid_adapter,
    okx_adapter,
)

HEAT_INTERVAL_SECONDS = 10
HEAT_RING_LENGTH = 360          # ≈ 1 hour of columns
HEAT_BINS_PER_SIDE = 40
PRESSURE_WINDOW_SECONDS = 300
METRICS_POLL_SECONDS = 30
# 1000 levels at a 5s cadence stays well inside Binance's request-weight
# budget (depth limit=1000 costs 50 weight; 5 symbols staggered ≈ 3000/min).
BINANCE_DEPTH_POLL_SECONDS = 5.0
CVD_MAX_MINUTES = 24 * 60


class SymbolAccumulators:
    """Everything derived from the full trade stream, per symbol."""

    def __init__(self) -> None:
        self.cvd_minutes: dict[int, float] = defaultdict(float)   # minute → Δnotional
        self.profile: dict[float, list[float]] = defaultdict(lambda: [0.0, 0.0])  # bin → [buy, sell]
        self.pressure: deque[tuple[float, str, float]] = deque()  # (ts, side, notional)
        self.heat: deque[list] = deque(maxlen=HEAT_RING_LENGTH)   # [ts, bids, asks]
        # Recent above-floor trades kept in memory for chart seeding — the
        # permanent CSV archive stays whales-only, but the chart wants
        # denser recent texture than whales alone provide.
        self.recent_trades: deque[dict] = deque(maxlen=800)

    def on_trade(self, symbol: str, trade: dict) -> None:
        minute = int(trade["ts"] / 60000) * 60
        signed = trade["notional"] if trade["side"] == "buy" else -trade["notional"]
        self.cvd_minutes[minute] += signed
        if len(self.cvd_minutes) > CVD_MAX_MINUTES:
            for key in sorted(self.cvd_minutes)[: len(self.cvd_minutes) - CVD_MAX_MINUTES]:
                del self.cvd_minutes[key]
        price_bin = bin_price(trade["price"], SYMBOLS[symbol].price_bin)
        self.profile[price_bin][0 if trade["side"] == "buy" else 1] += trade["notional"]
        now = time.time()
        self.pressure.append((now, trade["side"], trade["notional"]))
        while self.pressure and self.pressure[0][0] < now - PRESSURE_WINDOW_SECONDS:
            self.pressure.popleft()

    def vwap(self) -> float | None:
        """Session VWAP from the executed-volume profile (notional-weighted)."""
        total = sum(buy + sell for buy, sell in self.profile.values())
        if total == 0:
            return None
        weighted = sum(price * (buy + sell)
                       for price, (buy, sell) in self.profile.items())
        return weighted / total

    def cvd_points(self) -> list[list]:
        total, points = 0.0, []
        for minute in sorted(self.cvd_minutes):
            total += self.cvd_minutes[minute]
            points.append([minute, round(total, 2)])
        return points[-720:]  # 12h of minutes is plenty for the pane

    def pressure_totals(self) -> dict:
        buy = sum(n for _, side, n in self.pressure if side == "buy")
        sell = sum(n for _, side, n in self.pressure if side == "sell")
        return {"buy": round(buy, 2), "sell": round(sell, 2)}

    def profile_rows(self, limit: int = 120) -> list[list]:
        rows = sorted(self.profile.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))[:limit]
        return [[price, round(buy, 2), round(sell, 2)]
                for price, (buy, sell) in sorted(rows)]


class LensState:
    def __init__(self) -> None:
        self.books: dict[tuple[str, str], dict] = {}      # (symbol, venue) → book
        self.clients: dict[web.WebSocketResponse, dict] = {}  # ws → {symbol, venues}
        self.accumulators: dict[str, SymbolAccumulators] = {
            key: SymbolAccumulators() for key in SYMBOLS
        }
        self.metrics: dict[str, dict] = {}

    def on_book(self, venue: str, symbol: str, book: dict) -> None:
        self.books[(symbol, venue)] = book

    def on_trade(self, venue: str, symbol: str, trade: dict) -> None:
        self.accumulators[symbol].on_trade(symbol, trade)
        threshold = SYMBOLS[symbol].big_trade_usd
        # Forward from 10% of threshold: the chart wants aggregated-flow
        # texture, and the client slider filters from ×0.1 up. Only
        # full-threshold trades enter the permanent record.
        if trade["notional"] < threshold * 0.1:
            return
        payload = {"symbol": symbol, "venue": venue, **trade}
        self.accumulators[symbol].recent_trades.append(payload)
        if trade["notional"] >= threshold:
            record_trade(symbol, venue, trade)
        message = json.dumps({"type": "trade", **payload})
        for ws, sub in list(self.clients.items()):
            if sub["symbol"] == symbol and not ws.closed:
                asyncio.ensure_future(ws.send_str(message))

    def books_for(self, symbol: str, venues: list[str] | None) -> list[dict]:
        return [book for (sym, venue), book in self.books.items()
                if sym == symbol and (venues is None or venue in venues)]

    def venue_books_for(self, symbol: str, venues: list[str] | None
                        ) -> list[tuple[str, dict]]:
        return [(venue, book) for (sym, venue), book in self.books.items()
                if sym == symbol and (venues is None or venue in venues)]

    def venues_for(self, symbol: str) -> list[str]:
        return sorted(venue for (sym, venue) in self.books if sym == symbol)


STATE = LensState()


# ------------------------------------------------------------------ recorder


def record_trade(symbol: str, venue: str, trade: dict) -> None:
    RECORD_DIR.mkdir(exist_ok=True)
    path = RECORD_DIR / f"{symbol}_trades.csv"
    new = not path.exists()
    with path.open("a", newline="") as handle:
        writer = csv.writer(handle)
        if new:
            writer.writerow(["ts", "venue", "side", "price", "size", "notional"])
        writer.writerow([trade["ts"], venue, trade["side"], trade["price"],
                         trade["size"], round(trade["notional"], 2)])


def record_depth(symbol: str, profile: dict) -> None:
    RECORD_DIR.mkdir(exist_ok=True)
    path = RECORD_DIR / f"{symbol}_depth.csv"
    new = not path.exists()
    now_ms = int(time.time() * 1000)
    with path.open("a", newline="") as handle:
        writer = csv.writer(handle)
        if new:
            writer.writerow(["ts", "side", "price_bin", "notional_usd"])
        for side in ("bids", "asks"):
            for price, notional in profile[side][:25]:
                writer.writerow([now_ms, side[:-1], price, notional])


# ------------------------------------------------------- background pollers


async def binance_depth_poll() -> None:
    """Full-depth REST books for Binance symbols — the walls beyond top-20.

    ~3s staleness per symbol is the accepted tradeoff for 500 levels of
    visibility; the fast mid comes from Hyperliquid's sub-second snapshots.
    """
    listed = [spec for spec in SYMBOLS.values() if spec.binance]
    async with ClientSession() as session:
        while True:
            for spec in listed:
                for base in (BINANCE_REST, BINANCE_REST_FALLBACK):
                    try:
                        async with session.get(
                            f"{base}/api/v3/depth",
                            params={"symbol": spec.binance.upper(), "limit": 1000},
                            timeout=10,
                        ) as response:
                            data = await response.json()
                            STATE.on_book("binance", spec.key, {
                                "bids": [[float(p), float(q)] for p, q in data["bids"]],
                                "asks": [[float(p), float(q)] for p, q in data["asks"]],
                            })
                            break
                    except Exception:  # noqa: BLE001 — try fallback, then skip round
                        continue
                await asyncio.sleep(BINANCE_DEPTH_POLL_SECONDS / len(listed))


async def metrics_poll() -> None:
    """Funding / next funding / open interest / 24h change, every 30s."""
    binance_symbols = {spec.binance.upper(): spec.key
                       for spec in SYMBOLS.values() if spec.binance}
    async with ClientSession() as session:
        while True:
            metrics: dict[str, dict] = {key: {} for key in SYMBOLS}
            try:
                async with session.get(
                    f"{BINANCE_REST}/api/v3/ticker/24hr",
                    params={"symbols": json.dumps(list(binance_symbols), separators=(",", ":"))},
                    timeout=10,
                ) as response:
                    for row in await response.json():
                        key = binance_symbols.get(row.get("symbol"))
                        if key:
                            metrics[key]["last"] = float(row["lastPrice"])
                            metrics[key]["change24h"] = float(row["priceChangePercent"])
                async with session.get(
                    "https://fapi.binance.com/fapi/v1/premiumIndex", timeout=10
                ) as response:
                    for row in await response.json():
                        key = binance_symbols.get(row.get("symbol"))
                        if key:
                            metrics[key]["funding"] = float(row["lastFundingRate"])
                            metrics[key]["nextFunding"] = int(row["nextFundingTime"])
                async with session.post(
                    f"{HYPERLIQUID_REST}/info", json={"type": "metaAndAssetCtxs"},
                    timeout=10,
                ) as response:
                    meta, contexts = await response.json()
                    for asset, context in zip(meta["universe"], contexts):
                        for spec in SYMBOLS.values():
                            if spec.hyperliquid == asset["name"]:
                                entry = metrics[spec.key]
                                entry.setdefault("last", float(context.get("markPx", 0)))
                                entry["oiUsd"] = round(
                                    float(context.get("openInterest", 0))
                                    * float(context.get("markPx", 0)), 0)
                                # Kept separately from the Binance rate: the
                                # venue funding SPREAD is itself a signal.
                                entry["fundingHl"] = float(context.get("funding", 0))
                                entry.setdefault("funding", float(context.get("funding", 0)))
                                # HL funding settles hourly.
                                entry.setdefault("nextFunding",
                                                 (int(time.time() // 3600) + 1) * 3600 * 1000)
                                if spec.binance is None:
                                    async with session.post(
                                        f"{HYPERLIQUID_REST}/info",
                                        json={"type": "candleSnapshot",
                                              "req": {"coin": spec.hyperliquid,
                                                      "interval": "1d",
                                                      "startTime": int(time.time() * 1000)
                                                      - 2 * 86_400_000}},
                                        timeout=10,
                                    ) as candles:
                                        rows = await candles.json()
                                        if rows:
                                            day = rows[-1]
                                            open_price = float(day["o"])
                                            if open_price:
                                                entry["change24h"] = round(
                                                    (float(day["c"]) / open_price - 1) * 100, 2)
                STATE.metrics = metrics
                message = json.dumps({"type": "metrics", "data": metrics})
                for ws in list(STATE.clients):
                    if not ws.closed:
                        await ws.send_str(message)
            except Exception as error:  # noqa: BLE001 — metrics are best-effort
                print(f"metrics poll: {error.__class__.__name__}: {error}", flush=True)
            await asyncio.sleep(METRICS_POLL_SECONDS)


async def heat_ring_loop() -> None:
    """Append one binned-book column per symbol every 10s (the live heatmap)."""
    while True:
        await asyncio.sleep(HEAT_INTERVAL_SECONDS)
        now_s = int(time.time())
        for symbol, spec in SYMBOLS.items():
            books = STATE.books_for(symbol, None)
            if not books:
                continue
            profile = aggregate_books(books, spec.price_bin, HEAT_BINS_PER_SIDE)
            column = [now_s, profile["bids"], profile["asks"]]
            STATE.accumulators[symbol].heat.append(column)
            message = json.dumps({"type": "heatcol", "symbol": symbol, "col": column})
            for ws, sub in list(STATE.clients.items()):
                if sub["symbol"] == symbol and not ws.closed:
                    await ws.send_str(message)


async def broadcast_depth_loop() -> None:
    last_recorded: dict[str, float] = {}
    while True:
        await asyncio.sleep(DEPTH_BROADCAST_SECONDS)
        # One aggregation per distinct (symbol, venue-filter) among clients,
        # plus whatever is due for disk recording.
        wanted: dict[tuple, list[web.WebSocketResponse]] = defaultdict(list)
        for ws, sub in STATE.clients.items():
            venue_key = tuple(sorted(sub["venues"])) if sub["venues"] else None
            wanted[(sub["symbol"], venue_key)].append(ws)
        record_due = {s for s in SYMBOLS
                      if time.time() - last_recorded.get(s, 0) >= DEPTH_RECORD_SECONDS}
        for symbol in record_due:
            books = STATE.books_for(symbol, None)
            if books:
                spec = SYMBOLS[symbol]
                record_depth(symbol, aggregate_books(books, spec.price_bin,
                                                     DEPTH_BINS_PER_SIDE))
                last_recorded[symbol] = time.time()

        for (symbol, venue_key), sockets in wanted.items():
            venues = list(venue_key) if venue_key else None
            venue_books = STATE.venue_books_for(symbol, venues)
            if not venue_books:
                continue
            spec = SYMBOLS[symbol]
            books = [book for _, book in venue_books]
            profile = aggregate_books(books, spec.price_bin, DEPTH_BINS_PER_SIDE)
            accumulator = STATE.accumulators[symbol]

            # Per-venue attribution for the wall rows ("who is quoting it"),
            # and per-venue best bid/ask for the divergence gauge.
            venue_bins = {
                venue: aggregate_books([book], spec.price_bin, DEPTH_BINS_PER_SIDE)
                for venue, book in venue_books
            }
            walls = top_walls(profile)
            attributed_walls = {
                side: [
                    [price, usd, {
                        venue: usd_at
                        for venue, bins in venue_bins.items()
                        for level_price, usd_at in bins[side]
                        if level_price == price
                    }]
                    for price, usd in walls[side]
                ]
                for side in ("bids", "asks")
            }
            best = {
                venue: {
                    "bid": book["bids"][0][0] if book["bids"] else None,
                    "ask": book["asks"][0][0] if book["asks"] else None,
                }
                for venue, book in venue_books
            }
            imbalance = book_imbalance(profile)
            tape = tape_signal(list(accumulator.pressure), spec.big_trade_usd,
                               accumulator.cvd_minutes)
            book = book_signal(imbalance, attributed_walls, profile["mid"],
                               list(accumulator.heat), spec.price_bin)
            message = json.dumps({
                "type": "depth", "symbol": symbol,
                "venues": STATE.venues_for(symbol),
                "activeVenues": venues or STATE.venues_for(symbol),
                "bin": spec.price_bin,
                **profile,
                "imbalance": imbalance,
                "walls": attributed_walls,
                "best": best,
                "vwap": accumulator.vwap(),
                "pressure": accumulator.pressure_totals(),
                "profile": accumulator.profile_rows(),
                "signals": {"tape": tape, "book": book,
                            "combined": combined_signal(tape, book)},
            })
            for ws in sockets:
                if not ws.closed:
                    await ws.send_str(message)


# -------------------------------------------------------------------- klines


async def klines_handler(request: web.Request) -> web.Response:
    """Normalized candles: [{time, open, high, low, close}], any interval."""
    symbol = request.query.get("symbol", "BTC")
    interval = request.query.get("interval", "1m")
    if interval not in ("1s", "1m", "5m", "15m", "1h", "4h", "1d"):
        return web.json_response({"error": "bad interval"}, status=400)
    spec = SYMBOLS.get(symbol)
    if spec is None:
        return web.json_response({"error": "unknown symbol"}, status=400)
    if interval == "1s" and spec.binance is None:
        # Hyperliquid's finest candle is 1m — seconds exist only via Binance.
        return web.json_response({"error": "1s unavailable for this symbol"},
                                 status=400)
    limit = min(int(request.query.get("limit", "500")), 1000)

    async with ClientSession() as session:
        if spec.binance is not None:
            for base in (BINANCE_REST, BINANCE_REST_FALLBACK):
                try:
                    async with session.get(
                        f"{base}/api/v3/klines",
                        params={"symbol": spec.binance.upper(),
                                "interval": interval, "limit": limit}, timeout=15,
                    ) as response:
                        rows = await response.json()
                        return web.json_response([
                            {"time": row[0] // 1000, "open": float(row[1]),
                             "high": float(row[2]), "low": float(row[3]),
                             "close": float(row[4])}
                            for row in rows
                        ])
                except Exception:  # noqa: BLE001 — try the fallback host
                    continue
            return web.json_response({"error": "kline fetch failed"}, status=502)

        interval_ms = {"1m": 60, "5m": 300, "15m": 900,
                       "1h": 3600, "4h": 14400, "1d": 86400}[interval] * 1000
        start = int(time.time() * 1000) - limit * interval_ms
        async with session.post(
            f"{HYPERLIQUID_REST}/info",
            json={"type": "candleSnapshot",
                  "req": {"coin": spec.hyperliquid, "interval": interval,
                          "startTime": start}}, timeout=15,
        ) as response:
            rows = await response.json()
            return web.json_response([
                {"time": row["t"] // 1000, "open": float(row["o"]),
                 "high": float(row["h"]), "low": float(row["l"]),
                 "close": float(row["c"])}
                for row in rows
            ])


# ------------------------------------------------------------------ ws + app


def recorded_big_trades(symbol: str, limit: int = 200) -> list[dict]:
    """Tail of the L0 big-trade record — 'previous trades' for chart seeding.

    Reads the whole CSV today; switch to a reverse reader when files grow
    past a few MB (they rotate to the VPS before that matters).
    """
    path = RECORD_DIR / f"{symbol}_trades.csv"
    if not path.exists():
        return []
    with path.open("r", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return [
        {"ts": int(row["ts"]), "venue": row["venue"], "side": row["side"],
         "price": float(row["price"]), "size": float(row["size"]),
         "notional": float(row["notional"])}
        for row in rows[-limit:]
    ]


async def send_symbol_seed(ws: web.WebSocketResponse, symbol: str) -> None:
    """On (re)subscribe: recorded trades + heat ring + CVD + latest metrics."""
    accumulator = STATE.accumulators[symbol]
    # Seed = permanent whale archive + the in-memory recent-flow ring,
    # deduped (a whale exists in both) and capped, oldest first.
    seen: set[tuple] = set()
    merged: list[dict] = []
    for trade in recorded_big_trades(symbol) + list(accumulator.recent_trades):
        key = (trade["ts"], trade["price"], trade["size"])
        if key not in seen:
            seen.add(key)
            merged.append(trade)
    merged.sort(key=lambda t: t["ts"])
    await ws.send_str(json.dumps({"type": "tapeHistory", "symbol": symbol,
                                  "trades": merged[-600:]}))
    await ws.send_str(json.dumps({"type": "heat", "symbol": symbol,
                                  "cols": list(accumulator.heat)}))
    await ws.send_str(json.dumps({"type": "cvd", "symbol": symbol,
                                  "points": accumulator.cvd_points()}))
    if STATE.metrics:
        await ws.send_str(json.dumps({"type": "metrics", "data": STATE.metrics}))


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    STATE.clients[ws] = {"symbol": "BTC", "venues": None}
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                command = json.loads(message.data)
            except ValueError:
                continue
            if command.get("cmd") == "subscribe" and command.get("symbol") in SYMBOLS:
                venues = command.get("venues")
                STATE.clients[ws] = {
                    "symbol": command["symbol"],
                    "venues": venues if isinstance(venues, list) and venues else None,
                }
                await send_symbol_seed(ws, command["symbol"])
    finally:
        STATE.clients.pop(ws, None)
    return ws


async def index_handler(_: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB_DIR / "index.html")


async def docs_handler(_: web.Request) -> web.FileResponse:
    return web.FileResponse(WEB_DIR / "docs.html")


@web.middleware
async def no_cache_middleware(request: web.Request, handler):
    """Static assets must never be cached: this is a localhost tool that
    ships UI changes constantly, and a stale stylesheet against fresh HTML
    produces exactly the kind of broken-looking page that cost a debugging
    round on 2026-08-25. Caching buys nothing at 127.0.0.1."""
    response = await handler(request)
    response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


def build_app() -> web.Application:
    app = web.Application(middlewares=[no_cache_middleware])
    app.router.add_get("/", index_handler)
    app.router.add_get("/docs", docs_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/klines", klines_handler)
    app.router.add_static("/web/", WEB_DIR)
    # SPA deep links: /BTC, /SOL/15m, … all serve the app; the client-side
    # router (History API) reads the path. Registered last so /ws, /klines,
    # and /web/ keep winning.
    app.router.add_get("/{tail:.*}", index_handler)
    return app


async def main_async() -> None:
    for task in (binance_adapter(STATE.on_book, STATE.on_trade),
                 hyperliquid_adapter(STATE.on_book, STATE.on_trade),
                 bybit_adapter(STATE.on_book, STATE.on_trade),
                 okx_adapter(STATE.on_book, STATE.on_trade),
                 binance_depth_poll(), metrics_poll(),
                 heat_ring_loop(), broadcast_depth_loop()):
        asyncio.create_task(task)
    runner = web.AppRunner(build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", HTTP_PORT)
    await site.start()
    print(f"Market Lens serving on http://127.0.0.1:{HTTP_PORT}", flush=True)
    await asyncio.Event().wait()


def main() -> None:
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        pass
