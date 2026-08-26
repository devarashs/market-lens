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
  recording  — depth snapshots (30s) + big trades to data_recorded/lens.db
               (SQLite via LensStore; replaced the L0 CSVs 2026-08-25)

Protocol (server → client), all JSON over /ws after {"cmd":"subscribe",
"symbol":..., "venues":[...]?}:
  {type:"depth", bids, asks, mid, venues, imbalance, walls, pressure, profile}
  {type:"trade", ...}        {type:"heat", cols}/{type:"heatcol", col}
  {type:"cvd", points}       {type:"metrics", data}  (all symbols)
"""

from __future__ import annotations

import asyncio
import json

from market_lens import fastjson
import time
from collections import defaultdict, deque

from aiohttp import ClientSession, WSMsgType, web

from market_lens.aggregate import (
    aggregate_books,
    bin_price,
    book_imbalance,
    heat_columns_from_archive,
    top_walls,
)
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
    RETENTION_DAYS,
    RETENTION_SWEEP_SECONDS,
    SYMBOLS,
    WEB_DIR,
)
from market_lens.liqmap import LiquidationEstimator
from market_lens.store import LensStore
from market_lens.venues import (
    binance_adapter,
    binance_futures_trades_adapter,
    binance_liquidation_adapter,
    bybit_adapter,
    bybit_futures_adapter,
    coinbase_adapter,
    hyperliquid_adapter,
    kraken_adapter,
    okx_adapter,
    okx_futures_adapter,
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

    def __init__(self, price_bin: float) -> None:
        self.last_price: float | None = None
        # Estimated liquidation bands (see liqmap.py for the method and
        # its stated assumptions); fed by the futures-OI poll below.
        self.liq_estimator = LiquidationEstimator(price_bin)
        self.cvd_minutes: dict[int, float] = defaultdict(float)   # minute → Δnotional
        self.profile: dict[float, list[float]] = defaultdict(lambda: [0.0, 0.0])  # bin → [buy, sell]
        self.pressure: deque[tuple[float, str, float]] = deque()  # (ts, side, notional)
        # Executed flow awaiting archival: minute (epoch s) → bin → [buy, sell].
        # Flushed and dropped once the minute completes; this is only a
        # write buffer, never a read path.
        self.flow_pending: dict[int, dict[float, list[float]]] = defaultdict(
            lambda: defaultdict(lambda: [0.0, 0.0]))
        self.heat: deque[list] = deque(maxlen=HEAT_RING_LENGTH)   # [ts, bids, asks]
        # Recent above-floor trades kept in memory for chart seeding — the
        # permanent archive stays whales-only, but the chart wants
        # denser recent texture than whales alone provide.
        self.recent_trades: deque[dict] = deque(maxlen=800)

    def on_trade(self, symbol: str, trade: dict) -> None:
        self.last_price = trade["price"]
        minute = int(trade["ts"] / 60000) * 60
        signed = trade["notional"] if trade["side"] == "buy" else -trade["notional"]
        self.cvd_minutes[minute] += signed
        if len(self.cvd_minutes) > CVD_MAX_MINUTES:
            for key in sorted(self.cvd_minutes)[: len(self.cvd_minutes) - CVD_MAX_MINUTES]:
                del self.cvd_minutes[key]
        price_bin = bin_price(trade["price"], SYMBOLS[symbol].price_bin)
        side_index = 0 if trade["side"] == "buy" else 1
        self.profile[price_bin][side_index] += trade["notional"]
        self.flow_pending[minute][price_bin][side_index] += trade["notional"]
        now = time.time()
        self.pressure.append((now, trade["side"], trade["notional"]))
        while self.pressure and self.pressure[0][0] < now - PRESSURE_WINDOW_SECONDS:
            self.pressure.popleft()

    def seed_flow(self, rows: list[tuple]) -> None:
        """Fold archived flow minutes — (ts_ms, price_bin, buy, sell) — back
        into the CVD series and the volume profile. Both are derived from
        the FULL trade stream, which is far too large to archive, so the
        per-minute aggregate is what makes them survive a restart."""
        for ts_ms, price_bin, buy_usd, sell_usd in rows:
            self.cvd_minutes[ts_ms // 1000] += buy_usd - sell_usd
            bucket = self.profile[price_bin]
            bucket[0] += buy_usd
            bucket[1] += sell_usd

    def drain_completed_flow(self, current_minute: int
                             ) -> list[tuple[int, dict[float, list[float]]]]:
        """Remove and return every buffered minute before `current_minute`.
        The open minute stays buffered so it is archived exactly once, when
        complete."""
        done = sorted(m for m in self.flow_pending if m < current_minute)
        return [(minute, self.flow_pending.pop(minute)) for minute in done]

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
            key: SymbolAccumulators(spec.price_bin) for key, spec in SYMBOLS.items()
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
            STORE.insert_trade(symbol, venue, trade)
        message = fastjson.dumps_str({"type": "trade", **payload})
        for ws, sub in list(self.clients.items()):
            if sub["symbol"] == symbol and not ws.closed:
                asyncio.ensure_future(ws.send_str(message))

    def on_liquidation(self, venue: str, symbol: str, liq: dict) -> None:
        """A real forced liquidation: archive it (facts the estimator will
        be judged against) and push it to subscribed clients."""
        STORE.insert_liquidation(symbol, venue, liq)
        message = fastjson.dumps_str({"type": "liq", "symbol": symbol,
                              "venue": venue, **liq})
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
# The archive handle, module-level like STATE: the collector is the single
# writer, and every insert happens on the event-loop thread that created it.
STORE = LensStore(RECORD_DIR / "lens.db")


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


async def binance_futures_depth_poll() -> None:
    """Full-depth USDT-perp books from fapi — venue 'binance-fut'. Its own
    weight budget (2400/min): limit=1000 costs 20, five symbols at a 5s
    stagger ≈ 1200/min, comfortably inside."""
    listed = [spec for spec in SYMBOLS.values() if spec.binance]
    async with ClientSession() as session:
        while True:
            for spec in listed:
                try:
                    async with session.get(
                        "https://fapi.binance.com/fapi/v1/depth",
                        params={"symbol": spec.binance.upper(), "limit": 1000},
                        timeout=10,
                    ) as response:
                        data = await response.json()
                        STATE.on_book("binance-fut", spec.key, {
                            "bids": [[float(p), float(q)] for p, q in data["bids"]],
                            "asks": [[float(p), float(q)] for p, q in data["asks"]],
                        })
                except Exception:  # noqa: BLE001 — skip round, poll again
                    pass
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
                message = fastjson.dumps_str({"type": "metrics", "data": metrics})
                for ws in list(STATE.clients):
                    if not ws.closed:
                        await ws.send_str(message)
            except Exception as error:  # noqa: BLE001 — metrics are best-effort
                print(f"metrics poll: {error.__class__.__name__}: {error}", flush=True)
            await asyncio.sleep(METRICS_POLL_SECONDS)


LIQ_POLL_SECONDS = 30


async def liquidation_estimator_poll() -> None:
    """Feed each symbol's estimator a futures-OI observation every 30s;
    push the refreshed estimated bands to that symbol's subscribers.
    HL-only symbols have no Binance futures OI and simply never build a
    map — shown honestly as an empty layer."""
    futures_symbols = {spec.key: spec.binance.upper()
                       for spec in SYMBOLS.values() if spec.binance}
    async with ClientSession() as session:
        while True:
            for key, symbol in futures_symbols.items():
                accumulator = STATE.accumulators[key]
                price = accumulator.last_price
                if price is None:
                    continue
                try:
                    async with session.get(
                        "https://fapi.binance.com/fapi/v1/openInterest",
                        params={"symbol": symbol}, timeout=10,
                    ) as response:
                        data = await response.json()
                    oi_usd = float(data["openInterest"]) * price
                except Exception:  # noqa: BLE001 — poll is best-effort
                    continue
                now = time.time()
                taker_delta = sum(
                    (n if side == "buy" else -n)
                    for ts, side, n in accumulator.pressure if ts >= now - LIQ_POLL_SECONDS)
                ts_ms = int(now * 1000)
                # Archive BEFORE observing: these four numbers are the
                # estimator's entire input, and keeping them is what lets
                # a restart replay the map instead of starting blank.
                STORE.insert_oi_observation(key, ts_ms, price, oi_usd, taker_delta)
                accumulator.liq_estimator.observe(ts_ms, price, oi_usd, taker_delta)
                message = fastjson.dumps_str({"type": "liqmap", "symbol": key,
                                      "bands": accumulator.liq_estimator.bands()})
                for ws, sub in list(STATE.clients.items()):
                    if sub["symbol"] == key and not ws.closed:
                        await ws.send_str(message)
            await asyncio.sleep(LIQ_POLL_SECONDS)


async def flow_archive_loop() -> None:
    """Persist each completed minute of executed flow, per symbol."""
    while True:
        await asyncio.sleep(20)
        current_minute = int(time.time() / 60) * 60
        for symbol, accumulator in STATE.accumulators.items():
            for minute, bins in accumulator.drain_completed_flow(current_minute):
                try:
                    STORE.insert_flow_minute(symbol, minute * 1000, bins)
                except Exception as error:  # noqa: BLE001 — archiving is best-effort
                    print(f"flow archive {symbol}: "
                          f"{error.__class__.__name__}: {error}", flush=True)


async def retention_loop() -> None:
    """Apply the archive retention policy. The store has had a pruning hook
    since it was written and nothing ever called it — the database grew
    without bound (found in the persistence audit, 2026-08-26)."""
    while True:
        try:
            deleted = STORE.apply_retention(RETENTION_DAYS, int(time.time() * 1000))
            pruned = {table: count for table, count in deleted.items() if count}
            if pruned:
                print(f"retention: pruned {pruned}", flush=True)
        except Exception as error:  # noqa: BLE001 — never take the collector down
            print(f"retention: {error.__class__.__name__}: {error}", flush=True)
        await asyncio.sleep(RETENTION_SWEEP_SECONDS)


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
            message = fastjson.dumps_str({"type": "heatcol", "symbol": symbol, "col": column})
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
            wanted[(sub["symbol"], venue_key, sub.get("bin_mult", 1.0))].append(ws)
        record_due = {s for s in SYMBOLS
                      if time.time() - last_recorded.get(s, 0) >= DEPTH_RECORD_SECONDS}
        for symbol in record_due:
            books = STATE.books_for(symbol, None)
            if books:
                spec = SYMBOLS[symbol]
                STORE.insert_depth_snapshot(
                    symbol, int(time.time() * 1000),
                    aggregate_books(books, spec.price_bin, DEPTH_BINS_PER_SIDE))
                last_recorded[symbol] = time.time()

        for (symbol, venue_key, bin_mult), sockets in wanted.items():
            venues = list(venue_key) if venue_key else None
            venue_books = STATE.venue_books_for(symbol, venues)
            if not venue_books:
                continue
            spec = SYMBOLS[symbol]
            effective_bin = round(spec.price_bin * bin_mult, 10)
            books = [book for _, book in venue_books]
            profile = aggregate_books(books, effective_bin, DEPTH_BINS_PER_SIDE)
            accumulator = STATE.accumulators[symbol]

            # Per-venue attribution for the wall rows ("who is quoting
            # it"). Only the 4+4 wall bins matter, so each venue book gets
            # ONE binning pass into those bins — replacing nine full
            # aggregate_books calls per tick, which py-spy showed as the
            # residual load on the 1-vCPU VPS (2026-08-26).
            walls = top_walls(profile)
            wall_bin_sets = {side: {price for price, _ in walls[side]}
                             for side in ("bids", "asks")}
            venue_wall_usd: dict[str, dict[str, dict[float, float]]] = {
                side: {} for side in ("bids", "asks")}
            for venue, book in venue_books:
                for side in ("bids", "asks"):
                    targets = wall_bin_sets[side]
                    if not targets:
                        continue
                    sums = venue_wall_usd[side].setdefault(venue, {})
                    for level_price, size in book[side]:
                        level_bin = bin_price(level_price, effective_bin)
                        if level_bin in targets:
                            sums[level_bin] = sums.get(level_bin, 0.0)                                 + level_price * size
            attributed_walls = {
                side: [
                    [price, usd, {
                        venue: round(sums[price], 2)
                        for venue, sums in venue_wall_usd[side].items()
                        if price in sums
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
                               list(accumulator.heat), effective_bin)
            message = fastjson.dumps_str({
                "type": "depth", "symbol": symbol,
                "venues": STATE.venues_for(symbol),
                "activeVenues": venues or STATE.venues_for(symbol),
                "bin": effective_bin,
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
    # History pagination: candles strictly before endTime (epoch ms) —
    # the client's pan-left backfill.
    end_time = request.query.get("endTime")

    async with ClientSession() as session:
        if spec.binance is not None:
            params = {"symbol": spec.binance.upper(),
                      "interval": interval, "limit": limit}
            if end_time is not None:
                params["endTime"] = int(end_time)
            for base in (BINANCE_REST, BINANCE_REST_FALLBACK):
                try:
                    async with session.get(
                        f"{base}/api/v3/klines", params=params, timeout=15,
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
        anchor = int(end_time) if end_time is not None else int(time.time() * 1000)
        request_body = {"coin": spec.hyperliquid, "interval": interval,
                        "startTime": anchor - limit * interval_ms}
        if end_time is not None:
            request_body["endTime"] = anchor
        async with session.post(
            f"{HYPERLIQUID_REST}/info",
            json={"type": "candleSnapshot", "req": request_body}, timeout=15,
        ) as response:
            rows = await response.json()
            return web.json_response([
                {"time": row["t"] // 1000, "open": float(row["o"]),
                 "high": float(row["h"]), "low": float(row["l"]),
                 "close": float(row["c"])}
                for row in rows
            ])


# ------------------------------------------------------------------ ws + app


async def send_symbol_seed(ws: web.WebSocketResponse, symbol: str) -> None:
    """On (re)subscribe: recorded trades + heat ring + CVD + latest metrics."""
    accumulator = STATE.accumulators[symbol]
    # Seed = permanent whale archive + the in-memory recent-flow ring,
    # deduped (a whale exists in both) and capped, oldest first.
    seen: set[tuple] = set()
    merged: list[dict] = []
    for trade in STORE.recent_trades(symbol, limit=200) + list(accumulator.recent_trades):
        key = (trade["ts"], trade["price"], trade["size"])
        if key not in seen:
            seen.add(key)
            merged.append(trade)
    merged.sort(key=lambda t: t["ts"])
    await ws.send_str(fastjson.dumps_str({"type": "tapeHistory", "symbol": symbol,
                                  "trades": merged[-600:]}))
    await ws.send_str(fastjson.dumps_str({"type": "heat", "symbol": symbol,
                                  "cols": list(accumulator.heat)}))
    await ws.send_str(fastjson.dumps_str({"type": "cvd", "symbol": symbol,
                                  "points": accumulator.cvd_points()}))
    await ws.send_str(fastjson.dumps_str({"type": "liqHistory", "symbol": symbol,
                                  "events": STORE.recent_liquidations(symbol, 300)}))
    await ws.send_str(fastjson.dumps_str({"type": "liqmap", "symbol": symbol,
                                  "bands": accumulator.liq_estimator.bands()}))
    if STATE.metrics:
        await ws.send_str(fastjson.dumps_str({"type": "metrics", "data": STATE.metrics}))


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    STATE.clients[ws] = {"symbol": "BTC", "venues": None}
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                command = fastjson.loads(message.data)
            except ValueError:
                continue
            if command.get("cmd") == "subscribe" and command.get("symbol") in SYMBOLS:
                venues = command.get("venues")
                # Price-grouping control ("compression"): a multiplier on
                # the symbol's base bin, from a fixed set so a client can't
                # request a million bins. 0.2x reaches exchange tick size.
                try:
                    bin_mult = float(command.get("binMult", 1.0))
                except (TypeError, ValueError):
                    bin_mult = 1.0
                if bin_mult not in (0.2, 0.5, 1.0, 2.0, 5.0, 10.0):
                    bin_mult = 1.0
                STATE.clients[ws] = {
                    "symbol": command["symbol"],
                    "venues": venues if isinstance(venues, list) and venues else None,
                    "bin_mult": bin_mult,
                }
                await send_symbol_seed(ws, command["symbol"])
    finally:
        STATE.clients.pop(ws, None)
    return ws


async def index_handler(_: web.Request) -> web.StreamResponse:
    index = WEB_DIR / "index.html"
    if not index.exists():
        # A fresh clone has no build yet — say so instead of a bare 404.
        return web.Response(
            status=503, text="UI not built: run `cd app && npm install && npm run build`")
    return web.FileResponse(index)


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
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/klines", klines_handler)
    assets_dir = WEB_DIR / "assets"
    if assets_dir.exists():  # absent until the first `npm run build`
        app.router.add_static("/assets/", assets_dir)
    # SPA deep links: /BTC, /SOL/15m, /docs, … all serve the app; the
    # client-side router reads the path. Registered last so /ws, /klines,
    # and /assets/ keep winning.
    app.router.add_get("/{tail:.*}", index_handler)
    return app


def seed_heat_rings() -> None:
    """Rebuild each symbol's heat ring from the archive's last hour, so a
    restart no longer blanks the heatmap (Arash, 2026-08-26: "can we save
    data of it and rebuild it?"). The archive kept recording through every
    restart; this is the missing read-back."""
    now_ms = int(time.time() * 1000)
    for symbol, accumulator in STATE.accumulators.items():
        rows = STORE.depth_range(symbol, now_ms - 3_600_000, now_ms)
        for column in heat_columns_from_archive(rows):
            accumulator.heat.append(column)
        if rows:
            span_min = (rows[-1][0] - rows[0][0]) / 60_000
            print(f"heat ring seeded: {symbol} {len(accumulator.heat)} cols "
                  f"({span_min:.0f} min from archive)", flush=True)


LIQ_REPLAY_HOURS = 48  # two half-lives; older inventory is <25% and mostly consumed


def seed_liq_estimators() -> None:
    """Rebuild each symbol's liquidation map by replaying archived OI
    observations, so a restart no longer blanks it (Arash, 2026-08-26:
    "every time the vps version restarts the liq map has to be rebuilt").

    Replay, not snapshot restore: the estimator is a pure function of its
    observation sequence, so feeding the archive back through `observe`
    yields the identical map — including the decay and the consumption of
    every band price traded through while the process was down."""
    cutoff_ms = int((time.time() - LIQ_REPLAY_HOURS * 3600) * 1000)
    for symbol, accumulator in STATE.accumulators.items():
        rows = STORE.oi_observations_since(symbol, cutoff_ms)
        for ts_ms, price, oi_usd, taker_delta_usd in rows:
            accumulator.liq_estimator.observe(ts_ms, price, oi_usd, taker_delta_usd)
        bands = accumulator.liq_estimator.bands()
        if rows:
            span_h = (rows[-1][0] - rows[0][0]) / 3_600_000
            print(f"liq map seeded: {symbol} {len(bands)} bands from "
                  f"{len(rows)} observations ({span_h:.1f}h)", flush=True)


CVD_SEED_HOURS = 24  # matches CVD_MAX_MINUTES, the in-memory series length


def seed_flow() -> None:
    """Rebuild the CVD series and volume profile from archived flow minutes."""
    cutoff_ms = int((time.time() - CVD_SEED_HOURS * 3600) * 1000)
    for symbol, accumulator in STATE.accumulators.items():
        rows = STORE.flow_minutes_since(symbol, cutoff_ms)
        if not rows:
            continue
        accumulator.seed_flow(rows)
        span_h = (rows[-1][0] - rows[0][0]) / 3_600_000
        print(f"flow seeded: {symbol} {len(rows)} minute-bins "
              f"({span_h:.1f}h of CVD + profile)", flush=True)


async def main_async() -> None:
    # Listen FIRST, then rebuild memory from the archive, then start the
    # venue streams. Seeding costs a few seconds of replay; doing it before
    # the socket is open would 502 every page load across a redeploy, and
    # doing it after the adapters start would race live trades against the
    # archived minute being folded in.
    runner = web.AppRunner(build_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", HTTP_PORT)
    await site.start()
    print(f"Market Lens serving on http://127.0.0.1:{HTTP_PORT}", flush=True)

    seed_started = time.perf_counter()
    seed_heat_rings()
    seed_liq_estimators()
    seed_flow()
    print(f"archive replay complete in {time.perf_counter() - seed_started:.1f}s",
          flush=True)

    for task in (binance_adapter(STATE.on_book, STATE.on_trade),
                 hyperliquid_adapter(STATE.on_book, STATE.on_trade),
                 bybit_adapter(STATE.on_book, STATE.on_trade),
                 okx_adapter(STATE.on_book, STATE.on_trade),
                 coinbase_adapter(STATE.on_book, STATE.on_trade),
                 kraken_adapter(STATE.on_book, STATE.on_trade),
                 bybit_futures_adapter(STATE.on_book, STATE.on_trade),
                 okx_futures_adapter(STATE.on_book, STATE.on_trade),
                 binance_futures_trades_adapter(STATE.on_trade),
                 binance_liquidation_adapter(STATE.on_liquidation),
                 binance_depth_poll(), binance_futures_depth_poll(), metrics_poll(),
                 liquidation_estimator_poll(),
                 flow_archive_loop(), retention_loop(),
                 heat_ring_loop(), broadcast_depth_loop()):
        asyncio.create_task(task)
    await asyncio.Event().wait()


def main() -> None:
    try:
        # ~2x event-loop throughput on Linux; unavailable on Windows, where
        # the stdlib loop is fine for a dev instance.
        import uvloop
        uvloop.install()
    except ImportError:
        pass
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        pass
