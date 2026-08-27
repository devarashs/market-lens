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
    CORE_SYMBOLS,
    HL_DEXES,
    HYPERLIQUID_REST,
    RECORD_DIR,
    RETENTION_DAYS,
    RETENTION_SWEEP_SECONDS,
    SYMBOLS,
    WEB_DIR,
)
from market_lens.liqmap import LiquidationEstimator
from market_lens.positioning import (
    BINANCE_FUTURES_DATA,
    BINANCE_METRICS,
    BITFINEX_PAIRS,
    BITFINEX_STATS,
    parse_binance_ratio,
    parse_bitfinex_sizes,
)
from market_lens.stablecoins import (
    LLAMA_CHART_URL, parse_supply_series, summarise as summarise_stables,
)
from market_lens.store import LensStore
from market_lens.symbolinfo import COINGECKO_IDS, build as build_symbol_info
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
    okx_liquidation_adapter,
)

HEAT_INTERVAL_SECONDS = 10
HEAT_RING_LENGTH = 360          # ≈ 1 hour of columns
HEAT_BINS_PER_SIDE = 40
PRESSURE_WINDOW_SECONDS = 300
METRICS_POLL_SECONDS = 30
# 1000 levels at a 5s cadence stays well inside Binance's request-weight
# budget (depth limit=1000 costs 50 weight; 5 symbols staggered ≈ 3000/min).
BINANCE_DEPTH_POLL_SECONDS = 5.0
# Two weeks of minute buckets per symbol. Cheap in memory (a float per
# minute) and long enough for CVD divergence to mean something on the
# higher timeframes; the wire payload is bounded by downsampling instead
# of by throwing the history away.
CVD_MAX_MINUTES = 14 * 24 * 60
# Points sent to the client. Above this the series is thinned by an
# integer stride — the running total is still accumulated over EVERY
# minute, so thinning changes the resolution of the line, never its level.
CVD_MAX_POINTS = 2000


class SymbolAccumulators:
    """Everything derived from the full trade stream, per symbol."""

    def __init__(self, price_bin: float) -> None:
        self.last_price: float | None = None
        # Estimated liquidation bands (see liqmap.py for the method and
        # its stated assumptions); fed by the futures-OI poll below.
        self.liq_estimator = LiquidationEstimator(price_bin)
        self.cvd_minutes: dict[int, float] = defaultdict(float)   # minute → Δnotional
        # Executed volume, split by venue so the venue filter reaches the
        # profile, the VWAP drawn from it, and the pressure gauge — these
        # used to aggregate at ingest and ignore the filter entirely
        # (Arash: "I expect it to be reflected wherever it can").
        # venue → bin → [buy, sell]
        self.profile: dict[str, dict[float, list[float]]] = defaultdict(
            lambda: defaultdict(lambda: [0.0, 0.0]))
        # (ts, venue, side, notional)
        self.pressure: deque[tuple[float, str, str, float]] = deque()
        # Executed flow awaiting archival: minute (epoch s) → venue → bin →
        # [buy, sell]. Flushed and dropped once the minute completes; this
        # is a write buffer, never a read path.
        self.flow_pending: dict[int, dict[str, dict[float, list[float]]]] = defaultdict(
            lambda: defaultdict(lambda: defaultdict(lambda: [0.0, 0.0])))
        # Minutes in cvd_minutes that came from the kline reconstruction
        # rather than from recorded flow. Tracked so the backfill can be
        # recomputed as its calibration improves, without ever disturbing
        # a minute we actually observed.
        self.backfilled_minutes: set[int] = set()
        self.heat: deque[list] = deque(maxlen=HEAT_RING_LENGTH)   # [ts, bids, asks]
        # Recent above-floor trades kept in memory for chart seeding — the
        # permanent archive stays whales-only, but the chart wants
        # denser recent texture than whales alone provide.
        self.recent_trades: deque[dict] = deque(maxlen=800)

    def on_trade(self, symbol: str, trade: dict, venue: str = "") -> None:
        self.last_price = trade["price"]
        minute = int(trade["ts"] / 60000) * 60
        signed = trade["notional"] if trade["side"] == "buy" else -trade["notional"]
        self.cvd_minutes[minute] += signed
        if len(self.cvd_minutes) > CVD_MAX_MINUTES:
            for key in sorted(self.cvd_minutes)[: len(self.cvd_minutes) - CVD_MAX_MINUTES]:
                del self.cvd_minutes[key]
        price_bin = bin_price(trade["price"], SYMBOLS[symbol].price_bin)
        side_index = 0 if trade["side"] == "buy" else 1
        self.profile[venue][price_bin][side_index] += trade["notional"]
        self.flow_pending[minute][venue][price_bin][side_index] += trade["notional"]
        now = time.time()
        self.pressure.append((now, venue, trade["side"], trade["notional"]))
        while self.pressure and self.pressure[0][0] < now - PRESSURE_WINDOW_SECONDS:
            self.pressure.popleft()

    def seed_flow(self, rows: list[tuple]) -> None:
        """Fold archived flow minutes — (ts_ms, venue, price_bin, buy, sell)
        — back into the CVD series and the volume profile. Both derive from
        the FULL trade stream, far too large to archive, so the per-minute
        aggregate is what makes them survive a restart."""
        for ts_ms, venue, price_bin, buy_usd, sell_usd in rows:
            self.cvd_minutes[ts_ms // 1000] += buy_usd - sell_usd
            bucket = self.profile[venue][price_bin]
            bucket[0] += buy_usd
            bucket[1] += sell_usd

    def drain_completed_flow(self, current_minute: int) -> list[tuple[int, dict]]:
        """Remove and return every buffered minute before `current_minute`.
        The open minute stays buffered so it is archived exactly once, when
        complete."""
        done = sorted(m for m in self.flow_pending if m < current_minute)
        return [(minute, self.flow_pending.pop(minute)) for minute in done]

    def _profile_bins(self, venues: list[str] | None) -> dict[float, list[float]]:
        """Merge the per-venue profiles the filter selects into one map."""
        merged: dict[float, list[float]] = defaultdict(lambda: [0.0, 0.0])
        for venue, bins in self.profile.items():
            if venues is not None and venue not in venues:
                continue
            for price_bin, (buy, sell) in bins.items():
                bucket = merged[price_bin]
                bucket[0] += buy
                bucket[1] += sell
        return merged

    def vwap(self, venues: list[str] | None = None) -> float | None:
        """Session VWAP from the executed-volume profile (notional-weighted)."""
        bins = self._profile_bins(venues)
        total = sum(buy + sell for buy, sell in bins.values())
        if total == 0:
            return None
        weighted = sum(price * (buy + sell) for price, (buy, sell) in bins.items())
        return weighted / total

    def taker_delta(self, window_seconds: float, now: float | None = None,
                    venues: list[str] | None = None) -> float:
        """Net aggressive notional (buys − sells) over the trailing window.

        Lives here rather than inline in the OI poll so the pressure
        deque has exactly one place that knows its shape — adding the
        venue field silently broke a positional unpack in that poll, and
        every backfill and estimator tick died on it until the deploy log
        was read (2026-08-26).
        """
        cutoff = (now if now is not None else time.time()) - window_seconds
        return sum(
            (notional if side == "buy" else -notional)
            for ts, venue, side, notional in self.pressure
            if ts >= cutoff and (venues is None or venue in venues))

    def pending_cvd_minutes(self, venues: list[str] | None) -> dict[int, float]:
        """Delta per minute still in the write buffer — the minutes the
        archive has not seen yet, which a filtered series must add back."""
        out: dict[int, float] = defaultdict(float)
        for minute, by_venue in self.flow_pending.items():
            for venue, bins in by_venue.items():
                if venues is not None and venue not in venues:
                    continue
                for buy, sell in bins.values():
                    out[minute] += buy - sell
        return out

    def cvd_points(self, max_points: int = CVD_MAX_POINTS) -> list[list]:
        """The cumulative delta series, whole history, thinned to fit.

        Previously this returned only the last 720 minutes — the series
        was 12h long however much history the collector held, which read
        as CVD being built from almost no data (Arash, 2026-08-26). The
        running total is summed over every minute and only the emitted
        POINTS are strided, so a thinned line sits at exactly the same
        level as the dense one; it just has fewer vertices.
        """
        minutes = sorted(self.cvd_minutes)
        if not minutes:
            return []
        stride = max(1, -(-len(minutes) // max_points))  # ceil division
        total, points = 0.0, []
        last = len(minutes) - 1
        for index, minute in enumerate(minutes):
            total += self.cvd_minutes[minute]
            if index % stride == 0 or index == last:
                points.append([minute, round(total, 2)])
        return points

    def pressure_totals(self, venues: list[str] | None = None) -> dict:
        buy = sum(n for _, venue, side, n in self.pressure
                  if side == "buy" and (venues is None or venue in venues))
        sell = sum(n for _, venue, side, n in self.pressure
                   if side == "sell" and (venues is None or venue in venues))
        return {"buy": round(buy, 2), "sell": round(sell, 2)}

    def profile_rows(self, limit: int = 120,
                     venues: list[str] | None = None) -> list[list]:
        bins = self._profile_bins(venues)
        rows = sorted(bins.items(), key=lambda kv: -(kv[1][0] + kv[1][1]))[:limit]
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
        # Forwarded prints awaiting their next broadcast tick.
        self.pending_trades: dict[str, list[dict]] = {key: [] for key in SYMBOLS}

    def on_book(self, venue: str, symbol: str, book: dict) -> None:
        self.books[(symbol, venue)] = book

    def on_trade(self, venue: str, symbol: str, trade: dict) -> None:
        self.accumulators[symbol].on_trade(symbol, trade, venue)
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
        # Queue rather than send: `trade_broadcast_loop` coalesces a burst
        # into one message, and — because it checks for subscribers first
        # — never serialises a payload for a symbol nobody is watching.
        # With 51 symbols that was most of the work being thrown away.
        self.pending_trades[symbol].append(payload)

    def drain_pending_trades(self) -> dict[str, list[dict]]:
        drained = {symbol: batch for symbol, batch in self.pending_trades.items() if batch}
        for symbol in drained:
            self.pending_trades[symbol] = []
        return drained

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
    hl_coin_to_spec = {spec.hyperliquid: spec
                       for spec in SYMBOLS.values() if spec.hyperliquid}
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
                # One request per Hyperliquid dex — the main perp dex plus
                # each builder dex our symbols live on (equities and
                # commodities are namespaced `xyz:NVDA` and are absent from
                # the main universe).
                for dex in (None, *HL_DEXES):
                    body = {"type": "metaAndAssetCtxs"}
                    if dex:
                        body["dex"] = dex
                    async with session.post(f"{HYPERLIQUID_REST}/info", json=body,
                                            timeout=10) as response:
                        meta, contexts = await response.json()
                    for asset, context in zip(meta["universe"], contexts):
                        spec = hl_coin_to_spec.get(asset["name"])
                        if spec is None:
                            continue
                        entry = metrics[spec.key]
                        mark = float(context.get("markPx") or 0)
                        entry.setdefault("last", mark)
                        entry["oiUsd"] = round(
                            float(context.get("openInterest") or 0) * mark, 0)
                        # Kept separately from the Binance rate: the venue
                        # funding SPREAD is itself a signal.
                        entry["fundingHl"] = float(context.get("funding") or 0)
                        entry.setdefault("funding", float(context.get("funding") or 0))
                        # HL funding settles hourly.
                        entry.setdefault("nextFunding",
                                         (int(time.time() // 3600) + 1) * 3600 * 1000)
                        # prevDayPx is in the context already. This used to
                        # cost a candleSnapshot request per HL-only symbol,
                        # which at 38 of them would have been 38 extra REST
                        # calls every poll for a number sitting right here.
                        previous = float(context.get("prevDayPx") or 0)
                        if spec.binance is None and previous:
                            entry["change24h"] = round((mark / previous - 1) * 100, 2)
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
    """Feed every symbol's estimator an open-interest observation every 30s
    and push the refreshed bands to that symbol's subscribers.

    Every symbol, not just the Binance-listed ones: Hyperliquid publishes
    open interest for each of its coins — the equity perps included — and
    the metrics poll already has it in hand, so the wider coverage costs
    no extra requests at all. Binance futures OI is still preferred where
    it exists, being the deeper book; each symbol stays on one basis.
    """
    binance_symbols = {spec.key: spec.binance.upper()
                       for spec in SYMBOLS.values() if spec.binance}
    async with ClientSession() as session:
        while True:
            for key in SYMBOLS:
                accumulator = STATE.accumulators[key]
                price = accumulator.last_price
                if price is None:
                    continue
                binance_symbol = binance_symbols.get(key)
                if binance_symbol:
                    try:
                        async with session.get(
                            "https://fapi.binance.com/fapi/v1/openInterest",
                            params={"symbol": binance_symbol}, timeout=10,
                        ) as response:
                            data = await response.json()
                        oi_usd = float(data["openInterest"]) * price
                    except Exception:  # noqa: BLE001 — poll is best-effort
                        continue
                else:
                    # Hyperliquid's own OI, already fetched by metrics_poll.
                    oi_usd = float(STATE.metrics.get(key, {}).get("oiUsd") or 0)
                    if oi_usd <= 0:
                        continue
                now = time.time()
                taker_delta = accumulator.taker_delta(LIQ_POLL_SECONDS, now)
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


CVD_BACKFILL_DAYS = 14
# Below this much overlap the volume ratio is noise, so the backfill goes
# in uncalibrated and says so.
CVD_CALIBRATION_MIN_MINUTES = 20
CVD_BACKFILL_REFRESH_SECONDS = 3600


def _kline_delta_usd(row: list) -> float:
    """Signed taker flow for one Binance kline, in quote units.

    Binance reports quote volume [7] and the taker-BUY share of it [10];
    the sell share is the remainder, so delta = buy - sell = 2*buy - total.
    """
    return 2 * float(row[10]) - float(row[7])


async def backfill_cvd() -> None:
    """Extend CVD back past the day we started recording flow ourselves.

    Our own archive only reaches back to when flow_minutes began, which
    left the series looking like it was built from almost nothing. Binance
    publishes taker-buy volume per 1m kline going back years, so the delta
    is exactly recoverable for the Binance-listed symbols.

    The catch, and the reason for the scaling: the live series sums NINE
    venues while a kline is Binance spot alone, so a raw splice would show
    a visibly shallower slope before the seam and invent a divergence that
    never happened. The overlap where we hold both is used to measure the
    venue ratio, and the backfilled minutes are scaled by it. That makes
    the history comparable in magnitude, not identical in provenance — it
    is a reconstruction, and only fills minutes we never recorded.

    Memory only: this is derived, re-derivable, and Binance-shaped, so it
    never enters the archive that a future study would read.
    """
    await asyncio.sleep(8)  # let the adapters and seeds settle first
    while True:
        await _backfill_cvd_once()
        # Re-run periodically: the calibration window grows as we record,
        # so an early pass that had to go in uncalibrated is replaced by a
        # measured one rather than being stuck at whatever it guessed.
        await asyncio.sleep(CVD_BACKFILL_REFRESH_SECONDS)


async def _backfill_cvd_once() -> None:
    now = time.time()
    start_ms = int((now - CVD_BACKFILL_DAYS * 86_400) * 1000)
    async with ClientSession() as session:
        for key in CORE_SYMBOLS:
            spec = SYMBOLS[key]
            if not spec.binance:
                continue
            accumulator = STATE.accumulators[key]
            # Drop the previous reconstruction before measuring anything,
            # so recorded minutes are all that calibration can see.
            for minute in accumulator.backfilled_minutes:
                accumulator.cvd_minutes.pop(minute, None)
            accumulator.backfilled_minutes.clear()
            recorded = dict(accumulator.cvd_minutes)
            try:
                klines = await _fetch_klines_range(
                    session, spec.binance.upper(), start_ms, int(now * 1000))
            except Exception as error:  # noqa: BLE001 — backfill is best-effort
                print(f"cvd backfill {key}: {error.__class__.__name__}: {error}",
                      flush=True)
                continue
            if not klines:
                continue

            # Calibrate on the minutes we hold both ways.
            gross_rows = STORE.flow_minutes_since(
                key, int((now - CVD_BACKFILL_DAYS * 86_400) * 1000))
            ours: dict[int, float] = defaultdict(float)
            for ts_ms, _venue, _price_bin, buy_usd, sell_usd in gross_rows:
                ours[ts_ms // 60_000 * 60] += buy_usd + sell_usd
            overlap_ours = overlap_theirs = 0.0
            overlap_minutes = 0
            for row in klines:
                minute = int(row[0]) // 60_000 * 60
                if minute in ours:
                    overlap_ours += ours[minute]
                    overlap_theirs += float(row[7])
                    overlap_minutes += 1
            if (overlap_minutes >= CVD_CALIBRATION_MIN_MINUTES
                    and overlap_theirs > 0):
                # Ceiling well above a real venue ratio: nine venues (four
                # of them perp) against Binance spot alone measures ~10-20x,
                # so 60 leaves headroom while still catching the kind of
                # garbage the okx-fut contract bug produced (777x).
                scale = min(60.0, max(0.2, overlap_ours / overlap_theirs))
                note = f"x{scale:.2f} from {overlap_minutes}m overlap"
            else:
                scale = 1.0
                note = "uncalibrated (too little overlap)"

            added = 0
            for row in klines:
                minute = int(row[0]) // 60_000 * 60
                if minute in recorded:
                    continue  # our own recording always wins
                accumulator.cvd_minutes[minute] = _kline_delta_usd(row) * scale
                accumulator.backfilled_minutes.add(minute)
                added += 1
            if added:
                span_d = (max(accumulator.cvd_minutes)
                          - min(accumulator.cvd_minutes)) / 86_400
                print(f"cvd backfill: {key} +{added} minutes {note} "
                      f"— series now {span_d:.1f}d", flush=True)


async def _fetch_klines_range(session, symbol: str, start_ms: int,
                              end_ms: int) -> list:
    """Binance 1m klines across a range, paging the 1000-row limit."""
    rows: list = []
    cursor = start_ms
    while cursor < end_ms:
        async with session.get(
            f"{BINANCE_REST}/api/v3/klines",
            params={"symbol": symbol, "interval": "1m",
                    "startTime": cursor, "endTime": end_ms, "limit": 1000},
            timeout=20,
        ) as response:
            batch = await response.json()
        if not isinstance(batch, list) or not batch:
            break
        rows.extend(batch)
        nxt = int(batch[-1][0]) + 60_000
        if nxt <= cursor:
            break
        cursor = nxt
        await asyncio.sleep(0.12)  # keep well inside the weight budget
    return rows


POSITIONING_POLL_SECONDS = 300
POSITIONING_HISTORY_DAYS = 30
POSITIONING_MAX_POINTS = 1500


async def positioning_poll() -> None:
    """Record net long/short positioning, then push it to subscribers.

    Both sources serve only a trailing window — Binance ~30 days, Bitfinex
    a rolling week — so each pass refetches the whole window and upserts.
    That self-heals gaps from downtime and, more importantly, means the
    archive keeps growing past what either API will ever serve again.
    """
    await asyncio.sleep(12)  # let the seeds and adapters settle
    async with ClientSession() as session:
        while True:
            for key, spec in SYMBOLS.items():
                try:
                    await _record_positioning(session, key, spec)
                except Exception as error:  # noqa: BLE001 — best-effort
                    print(f"positioning {key}: "
                          f"{error.__class__.__name__}: {error}", flush=True)
            await _push_positioning()
            await asyncio.sleep(POSITIONING_POLL_SECONDS)


async def _record_positioning(session, key: str, spec) -> None:
    if spec.binance:
        for metric, path in BINANCE_METRICS.items():
            async with session.get(
                f"{BINANCE_FUTURES_DATA}/{path}",
                params={"symbol": spec.binance.upper(), "period": "5m",
                        "limit": 500},
                timeout=20,
            ) as response:
                rows = await response.json()
            if isinstance(rows, list):
                STORE.insert_positioning(key, metric, parse_binance_ratio(rows))
            await asyncio.sleep(0.15)

    pair = BITFINEX_PAIRS.get(key)
    if pair:
        sides = {}
        for side in ("long", "short"):
            async with session.get(
                f"{BITFINEX_STATS}/pos.size:1m:{pair}:{side}/hist",
                params={"limit": 5000}, timeout=25,
            ) as response:
                sides[side] = await response.json()
            await asyncio.sleep(0.3)
        points = parse_bitfinex_sizes(sides.get("long") or [],
                                      sides.get("short") or [])
        STORE.insert_positioning(key, "bitfinex-margin", points)


async def _push_positioning() -> None:
    """Send each subscriber the series for whatever symbol it is watching."""
    start_ms = int((time.time() - POSITIONING_HISTORY_DAYS * 86_400) * 1000)
    cache: dict[str, str] = {}
    for ws, sub in list(STATE.clients.items()):
        symbol = sub["symbol"]
        if ws.closed:
            continue
        if symbol not in cache:
            cache[symbol] = fastjson.dumps_str({
                "type": "positioning", "symbol": symbol,
                "series": STORE.positioning_series(symbol, start_ms)})
        await ws.send_str(cache[symbol])


TRADE_BROADCAST_SECONDS = 0.1


async def trade_broadcast_loop() -> None:
    """Push queued prints ~10x a second, one message per symbol.

    Sending per print meant a WebSocket frame, a JSON serialisation and a
    task spawn for every trade, and a React render on the client for each
    one. Coalescing costs at most 100ms of latency on a panel that reads
    as a stream anyway, and lets the client apply a whole burst in a
    single frame.
    """
    while True:
        await asyncio.sleep(TRADE_BROADCAST_SECONDS)
        drained = STATE.drain_pending_trades()
        if not drained:
            continue
        watching = {sub["symbol"] for ws, sub in STATE.clients.items() if not ws.closed}
        for symbol, batch in drained.items():
            if symbol not in watching:
                continue  # nobody is looking: never pay for the JSON
            message = fastjson.dumps_str({"type": "trades", "symbol": symbol,
                                          "trades": batch})
            for ws, sub in list(STATE.clients.items()):
                if sub["symbol"] == symbol and not ws.closed:
                    await ws.send_str(message)


STABLECOIN_POLL_SECONDS = 3600
# Latest summary, served to clients and refreshed hourly (the source is a
# daily series, so anything faster is wasted).
STABLECOINS: dict = {"available": False}


async def stablecoin_poll() -> None:
    """Total stablecoin supply — the market's dry powder.

    Shown as a measurement on probation, not a signal: the arena's test
    (docs/research/stablecoin-flow.md) found a faint 7-day tilt that
    survived its controls and nothing at any other horizon.
    """
    await asyncio.sleep(25)
    global STABLECOINS
    async with ClientSession() as session:
        while True:
            try:
                async with session.get(LLAMA_CHART_URL, timeout=45) as response:
                    rows = await response.json()
                series = parse_supply_series(rows)
                if series:
                    STABLECOINS = summarise_stables(series)
            except Exception as error:  # noqa: BLE001 — reference data is best-effort
                print(f"stablecoins: {error.__class__.__name__}: {error}", flush=True)
            await asyncio.sleep(STABLECOIN_POLL_SECONDS)


async def stablecoins_handler(_: web.Request) -> web.Response:
    return web.json_response(STABLECOINS)


async def flow_archive_loop() -> None:
    """Persist each completed minute of executed flow, per symbol."""
    while True:
        await asyncio.sleep(20)
        current_minute = int(time.time() / 60) * 60
        for symbol, accumulator in STATE.accumulators.items():
            for minute, by_venue in accumulator.drain_completed_flow(current_minute):
                try:
                    STORE.insert_flow_minute(symbol, minute * 1000, by_venue)
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
    """Append one binned-book column per symbol every 10s (the live heatmap).

    EVERY symbol, watched or not. Heatmap history cannot be recorded
    retroactively — a symbol whose ring only fills while someone happens
    to be looking at it would show up empty exactly when you open it,
    which is the moment you want it (Arash, 2026-08-26). The cost is
    asymmetric in our favour: an extended symbol aggregates one ~20-level
    Hyperliquid book, while the six core symbols aggregate nine books
    apiece — the expensive ones were always going to run anyway.
    """
    while True:
        await asyncio.sleep(HEAT_INTERVAL_SECONDS)
        now_s = int(time.time())
        for symbol in SYMBOLS:
            spec = SYMBOLS[symbol]
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
        # Every symbol is archived. Order-book history has no free source
        # and cannot be backfilled, so recording only what someone happened
        # to be watching would leave exactly the gaps a later study needs.
        # Retention (14 days for depth) is what bounds the disk, not
        # selective recording.
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
            # The signals read the same filtered view the panels show, so a
            # venue filter changes the verdict rather than only the picture.
            filtered_pressure = [(ts, side, notional)
                                 for ts, venue, side, notional in accumulator.pressure
                                 if venues is None or venue in venues]
            tape = tape_signal(filtered_pressure, spec.big_trade_usd,
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
                "vwap": accumulator.vwap(venues),
                "pressure": accumulator.pressure_totals(venues),
                "profile": accumulator.profile_rows(venues=venues),
                "signals": {"tape": tape, "book": book,
                            "combined": combined_signal(tape, book)},
            })
            for ws in sockets:
                if not ws.closed:
                    await ws.send_str(message)


# -------------------------------------------------------------------- klines


COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/markets"
COINGECKO_POLL_SECONDS = 600
# symbol -> latest CoinGecko row. Market cap moves slowly and the free API
# is rate-limited, so one request every ten minutes covers all 22 coins.
MARKET_DATA: dict[str, dict] = {}
# Candles for the info panel, cached briefly so reopening it costs nothing.
_INFO_CACHE: dict[str, tuple[float, dict]] = {}
INFO_CACHE_SECONDS = 60


async def coingecko_poll() -> None:
    """Market cap, supply and ATH for the coins. Nothing here exists for
    the equity perps — a perp on Nvidia has no issuer or float — and the
    panel states that rather than borrowing the underlying's numbers."""
    await asyncio.sleep(20)
    ids = ",".join(sorted(set(COINGECKO_IDS.values())))
    reverse = {value: key for key, value in COINGECKO_IDS.items()}
    async with ClientSession() as session:
        while True:
            try:
                async with session.get(
                    COINGECKO_URL,
                    params={"vs_currency": "usd", "ids": ids,
                            "price_change_percentage": "1h,24h,7d,30d,1y"},
                    timeout=25,
                ) as response:
                    rows = await response.json()
                if isinstance(rows, list):
                    for row in rows:
                        key = reverse.get(row.get("id"))
                        if key:
                            MARKET_DATA[key] = row
            except Exception as error:  # noqa: BLE001 — reference data is best-effort
                print(f"coingecko: {error.__class__.__name__}: {error}", flush=True)
            await asyncio.sleep(COINGECKO_POLL_SECONDS)


async def _fetch_candles(session, spec, interval: str, limit: int) -> list[dict]:
    """Raw candles keeping VOLUME, which /klines drops — the info panel is
    the one caller that needs it. Normalised to Hyperliquid's field names,
    with Binance's exact quote volume carried through as `q`."""
    if spec.binance is not None:
        async with session.get(
            f"{BINANCE_REST}/api/v3/klines",
            params={"symbol": spec.binance.upper(), "interval": interval,
                    "limit": limit}, timeout=20,
        ) as response:
            rows = await response.json()
        return [{"t": row[0], "o": row[1], "h": row[2], "l": row[3],
                 "c": row[4], "v": row[5], "q": row[7]} for row in rows]

    interval_ms = {"1h": 3600, "1d": 86400}[interval] * 1000
    now_ms = int(time.time() * 1000)
    async with session.post(
        f"{HYPERLIQUID_REST}/info",
        json={"type": "candleSnapshot",
              "req": {"coin": spec.hyperliquid, "interval": interval,
                      "startTime": now_ms - limit * interval_ms,
                      "endTime": now_ms}},
        timeout=25,
    ) as response:
        rows = await response.json()
    return rows if isinstance(rows, list) else []


async def symbol_info_handler(request: web.Request) -> web.Response:
    """Reference statistics for one symbol — the info panel's payload."""
    symbol = request.query.get("symbol", "BTC")
    spec = SYMBOLS.get(symbol)
    if spec is None:
        return web.json_response({"error": "unknown symbol"}, status=400)

    cached = _INFO_CACHE.get(symbol)
    if cached and time.time() - cached[0] < INFO_CACHE_SECONDS:
        return web.json_response(cached[1])

    try:
        async with ClientSession() as session:
            daily = await _fetch_candles(session, spec, "1d", 400)
            hourly = await _fetch_candles(session, spec, "1h", 3)
    except Exception as error:  # noqa: BLE001
        return web.json_response(
            {"error": f"candle fetch failed: {error.__class__.__name__}"}, status=502)

    day_ago = int((time.time() - 86_400) * 1000)
    positioning = STORE.positioning_series(symbol, day_ago)
    payload = build_symbol_info(
        symbol, spec.asset_class, daily, hourly,
        MARKET_DATA.get(symbol), STATE.metrics.get(symbol),
        extras={
            "venues": STATE.venues_for(symbol),
            "liquidations24h": STORE.liquidation_totals(symbol, day_ago),
            # Our own recorded series, which no data provider sells back.
            "positioning": {metric: points[-1][1]
                            for metric, points in positioning.items() if points},
        },
    )
    _INFO_CACHE[symbol] = (time.time(), payload)
    return web.json_response(payload)


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
                             "close": float(row[4]),
                             # Volume rides along: the indicator layers
                             # (z-score, absorption, volume nodes, profile)
                             # are all volume-weighted and had nothing to
                             # weight with while /klines dropped it.
                             "volume": float(row[5])}
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
                 "close": float(row["c"]), "volume": float(row.get("v") or 0)}
                for row in rows
            ])


# ------------------------------------------------------------------ ws + app


def filtered_cvd_points(symbol: str, venues: list[str] | None) -> list[list]:
    """CVD for a venue subset, rebuilt from the archive.

    Unfiltered we use the in-memory series, which is fast and carries the
    kline reconstruction. Filtered, the per-venue history lives only in
    `flow_minutes`, so it is summed there and topped up with the minutes
    still sitting in the write buffer. Rows archived before venue
    attribution existed carry an empty venue and are simply not in a
    filtered total — we do not know where they came from, so claiming
    them for any venue would be a guess.
    """
    accumulator = STATE.accumulators[symbol]
    if not venues:
        return accumulator.cvd_points()
    start_ms = int((time.time() - CVD_MAX_MINUTES * 60) * 1000)
    deltas: dict[int, float] = defaultdict(float)
    for minute, delta in STORE.cvd_series(symbol, start_ms, venues):
        deltas[int(minute)] += delta or 0.0
    for minute, delta in accumulator.pending_cvd_minutes(venues).items():
        deltas[minute] += delta
    total, points = 0.0, []
    for minute in sorted(deltas):
        total += deltas[minute]
        points.append([minute, round(total, 2)])
    stride = max(1, -(-len(points) // CVD_MAX_POINTS))
    return points[::stride] if stride > 1 else points


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
                                  "points": filtered_cvd_points(
                                      symbol, (STATE.clients.get(ws) or {}).get("venues"))}))
    await ws.send_str(fastjson.dumps_str({"type": "liqHistory", "symbol": symbol,
                                  "events": STORE.recent_liquidations(symbol, 300)}))
    await ws.send_str(fastjson.dumps_str({"type": "liqmap", "symbol": symbol,
                                  "bands": accumulator.liq_estimator.bands()}))
    await ws.send_str(fastjson.dumps_str({
        "type": "positioning", "symbol": symbol,
        "series": STORE.positioning_series(
            symbol, int((time.time() - POSITIONING_HISTORY_DAYS * 86_400) * 1000))}))
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
    app.router.add_get("/symbol-info", symbol_info_handler)
    app.router.add_get("/stablecoins", stablecoins_handler)
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


CVD_SEED_HOURS = CVD_MAX_MINUTES // 60  # seed as far back as memory holds


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
                 okx_liquidation_adapter(STATE.on_liquidation),
                 binance_depth_poll(), binance_futures_depth_poll(), metrics_poll(),
                 liquidation_estimator_poll(),
                 flow_archive_loop(), retention_loop(), backfill_cvd(),
                 trade_broadcast_loop(), coingecko_poll(), stablecoin_poll(),
                 positioning_poll(),
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
