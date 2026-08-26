"""Estimated liquidation map: where leveraged entries would die.

Nobody can see other traders' positions, so this — like every liquidation
heatmap in existence — is an ESTIMATE built from open-interest changes.
The method, with its assumptions in the open:

  1. When OI rises over an interval while price trades at P, new positions
     of that notional were opened near P. Long/short attribution follows
     the interval's taker flow: net aggressive buying ⇒ the new inventory
     leans long (and vice versa) — imperfect, stated, and the best signal
     available without account data.
  2. Those positions liquidate at the standard leverage-tier distances
     from entry (a 10x long dies ~10% below, mirrored for shorts). The
     tier mix is an ASSUMPTION (see LEVERAGE_TIERS) — venues do not
     publish their books' leverage distribution.
  3. Bands are CONSUMED when price trades through them (the liquidations
     happened or the stops beat them to it), and the whole map decays
     with a half-life, because positions close voluntarily all the time
     and OI decreases cannot be attributed to any particular entry.

Claims-layer honesty applies twice over: this is an estimate OF claims.
The `liquidations` table (real forceOrder prints) is the facts side, and
over time it is the estimator's judge.
"""

from __future__ import annotations

import heapq
from collections import defaultdict

# Assumed share of new perp inventory at each leverage tier. No venue
# publishes this; the shape (mass in the 10x-25x middle, thin tails) is
# the industry's usual guess and the whole map inherits its uncertainty.
LEVERAGE_TIERS: tuple[tuple[float, float], ...] = (
    (5.0, 0.15),
    (10.0, 0.35),
    (25.0, 0.25),
    (50.0, 0.15),
    (100.0, 0.10),
)

DECAY_HALF_LIFE_HOURS = 24.0     # voluntary closes erode the map
MIN_BAND_NOTIONAL_USD = 50_000.0  # drop dust so the wire stays light
# The map is binned COARSER than the order book: ×10 the symbol's depth bin
# (BTC $100, ETH $10). Two reasons, one honest and one measured. Honest:
# projecting an assumed leverage mix onto $10 bins implies a precision this
# estimate does not have. Measured: each observation seeds 10 bands that
# drift with price, so fine bins accumulate thousands of levels over a day —
# which bloats the wire and makes every decay pass slower (2026-08-26).
BIN_MULTIPLE = 10
# Hard cap on what `bands()` returns, strongest first. A liquidation map is
# read as clusters, not as a list; this bounds the payload no matter how
# long the process has been running.
MAX_BANDS = 300
# Bands decayed below this are deleted outright. Two orders of magnitude
# under the display floor, so it can never change what the map shows —
# it just stops decayed-to-nothing bins accumulating forever, which
# bounds memory and keeps replay fast.
BAND_FLOOR_USD = MIN_BAND_NOTIONAL_USD / 100
# An observation this far after the previous one cannot attribute its OI
# change to any particular price — the move happened across an unknown
# path. Decay and consumption still apply (both are functions of elapsed
# time and current price); only the projection is skipped. Guards the
# first observation after downtime from dumping the whole gap's OI growth
# onto one price level.
MAX_ATTRIBUTION_GAP_MS = 10 * 60_000


class LiquidationEstimator:
    """Per-symbol estimated liquidation bands, price-binned.

    Feed it OI observations (`observe`); read `bands()` for the current
    map. Pure state machine — no clock, no I/O; the caller supplies
    timestamps, which keeps every transition unit-testable.

    Purity is also what makes the map survive restarts: the caller
    archives each observation, and replaying that archive in order
    reconstructs the identical map (see `seed_liq_estimators`).
    """

    def __init__(self, price_bin: float) -> None:
        self.price_bin = price_bin * BIN_MULTIPLE
        self.last_oi_usd: float | None = None
        self.last_ts_ms: int | None = None
        # bin price -> {"long": usd, "short": usd}; "long" = longs die here.
        self._bands: dict[float, dict[str, float]] = defaultdict(
            lambda: {"long": 0.0, "short": 0.0})

    def _bin(self, price: float) -> float:
        return round(price / self.price_bin) * self.price_bin

    def observe(self, ts_ms: int, price: float, oi_usd: float,
                taker_delta_usd: float) -> None:
        """One OI observation. `taker_delta_usd` is the interval's net
        aggressive flow (buy − sell notional) used for side attribution."""
        elapsed_ms = ts_ms - self.last_ts_ms if self.last_ts_ms is not None else None
        # Decay and consumption depend only on elapsed time and current
        # price, so they run whenever there IS a previous observation —
        # independently of whether the OI baseline is usable.
        if elapsed_ms is not None:
            self._decay(elapsed_ms)
            self._consume(price)
        if (self.last_oi_usd is not None and elapsed_ms is not None
                and elapsed_ms <= MAX_ATTRIBUTION_GAP_MS):
            oi_increase = oi_usd - self.last_oi_usd
            if oi_increase > 0:
                # Split the new inventory long/short by flow lean: delta=0
                # ⇒ 50/50; strongly one-sided flow shifts up to 90/10.
                scale = max(abs(taker_delta_usd), 1.0)
                lean = max(-0.8, min(0.8, taker_delta_usd / scale * 0.8))
                long_share = 0.5 + lean / 2
                for leverage, weight in LEVERAGE_TIERS:
                    slice_usd = oi_increase * weight
                    long_bin = self._bin(price * (1 - 1 / leverage))
                    short_bin = self._bin(price * (1 + 1 / leverage))
                    self._bands[long_bin]["long"] += slice_usd * long_share
                    self._bands[short_bin]["short"] += slice_usd * (1 - long_share)
        self.last_oi_usd = oi_usd
        self.last_ts_ms = ts_ms

    def _decay(self, elapsed_ms: int) -> None:
        if elapsed_ms <= 0:
            return
        factor = 0.5 ** (elapsed_ms / (DECAY_HALF_LIFE_HOURS * 3_600_000))
        for level in list(self._bands):
            band = self._bands[level]
            band["long"] *= factor
            band["short"] *= factor
            if band["long"] + band["short"] < BAND_FLOOR_USD:
                del self._bands[level]

    def _consume(self, price: float) -> None:
        """Price at P: long-liq bands ABOVE P and short-liq bands BELOW P
        are behind the market — either they fired or their positions
        survived the touch; both ways the estimate is spent."""
        for level in list(self._bands):
            if level >= price:
                self._bands[level]["long"] = 0.0
            if level <= price:
                self._bands[level]["short"] = 0.0
            if (self._bands[level]["long"] + self._bands[level]["short"]) <= 0:
                del self._bands[level]

    def bands(self) -> list[list[float]]:
        """[[price_bin, long_usd, short_usd], ...] sorted by price, dust
        dropped and capped at the strongest MAX_BANDS — the wire/UI shape."""
        rows = [
            [level, round(band["long"], 0), round(band["short"], 0)]
            for level, band in self._bands.items()
            if band["long"] + band["short"] >= MIN_BAND_NOTIONAL_USD
        ]
        if len(rows) > MAX_BANDS:
            rows = heapq.nlargest(MAX_BANDS, rows, key=lambda row: row[1] + row[2])
        rows.sort(key=lambda row: row[0])
        return rows
