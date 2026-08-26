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


class LiquidationEstimator:
    """Per-symbol estimated liquidation bands, price-binned.

    Feed it OI observations (`observe`); read `bands()` for the current
    map. Pure state machine — no clock, no I/O; the caller supplies
    timestamps, which keeps every transition unit-testable.
    """

    def __init__(self, price_bin: float) -> None:
        self.price_bin = price_bin
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
        if self.last_oi_usd is not None and self.last_ts_ms is not None:
            self._decay(ts_ms - self.last_ts_ms)
            self._consume(price)
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
        for band in self._bands.values():
            band["long"] *= factor
            band["short"] *= factor

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
        dropped — the wire/UI shape."""
        rows = [
            [level, round(band["long"], 0), round(band["short"], 0)]
            for level, band in sorted(self._bands.items())
            if band["long"] + band["short"] >= MIN_BAND_NOTIONAL_USD
        ]
        return rows
