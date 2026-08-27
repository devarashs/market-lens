"""Price grouping for the order book — relative to price, not to a constant.

The old ladder was a multiplier (x0.2 to x10) on each symbol's configured
`price_bin`. Because those bins were chosen per symbol in absolute terms,
the same multiplier meant wildly different things: BTC's x10 was $100, or
0.13% of price, while DOGE's x10 was 2.5%. On BTC the coarsest setting
could not show the shelves at all (Arash, 2026-08-27).

Grouping is therefore expressed in BASIS POINTS OF PRICE and snapped to a
"nice" number — 1, 2 or 5 times a power of ten — so the rungs read as
round figures a trader would name: SOL near $100 gets $0.05 up to $10,
DOGE gets fractions of a cent, BTC gets $10 to a few hundred. One ladder,
one meaning, every symbol.

The top of the ladder is set by the BOOK, not by price. Arash asked for
$1k/$5k/$10k rungs on BTC; measurement says the full Binance book spans
only ±1.3% of price, so a $10k bin puts every level in one row. Offering
it would be offering a broken setting.

Pure module. The server treats the client's request as a suggestion and
resolves it here, because a client can ask for anything.
"""

from __future__ import annotations

import math

# 0.01% to 10% of price. The fine end reaches exchange tick size on the
# majors; the coarse end is where the big shelves live.
RELATIVE_STEPS_BP: tuple[float, ...] = (
    1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
)
# Fallback cap when the book's own span is unknown (no book yet). Grouping
# wider than this stops being an order book and starts being a histogram.
MAX_FRACTION_OF_PRICE = 0.2
# The real cap is the BOOK, not the price. Measured 2026-08-27 on BTC:
# Binance quotes +/-0.38% of price at the depth we poll (+/-1.3% even at
# limit=5000), and Hyperliquid only +/-0.03%. A $10,000 bin therefore puts
# every level in one row — offering it would be offering a broken setting.
#
# Three bins per side is deliberately permissive: it is what the old x10
# multiplier already gave BTC, so the coarsest rung stays where Arash
# found it rather than regressing, and every symbol below BTC's price
# gets a fuller ladder than this bound requires.
MIN_BINS_PER_SIDE = 3


def nice_bin(value: float) -> float:
    """Snap to the NEAREST 1, 2 or 5 times a power of ten.

    Nearest rather than upward, measured in log space so the choice is
    scale-fair: rounding up collapsed neighbouring rungs together and left
    the middle of a ladder sparse (SOL jumped 0.1 -> 0.5 -> 1 -> 5).
    """
    if not (value > 0) or math.isinf(value):
        return 0.0
    exponent = math.floor(math.log10(value))
    candidates = [mantissa * (10 ** exponent) for mantissa in (1.0, 2.0, 5.0, 10.0)]
    best = min(candidates, key=lambda candidate: abs(math.log(value) - math.log(candidate)))
    # Round away the float dust that 10**negative introduces.
    return float(f"{best:.10g}")


def book_span(books: list[dict], reference_price: float) -> float:
    """How far the farthest quoted level sits from price, across venues.

    Books arrive sorted outward from the touch — LocalBook.emit uses
    heapq.nlargest/nsmallest, which return sorted output, and both REST
    sources sort too — so this reads the last level of each side rather
    than scanning every level of every venue on each broadcast tick. An
    unsorted book would only ever understate the span, narrowing the
    ladder rather than offering a rung the book cannot fill.
    """
    if not (reference_price > 0):
        return 0.0
    far = 0.0
    for book in books:
        for side in ("bids", "asks"):
            levels = book.get(side) or ()
            if levels:
                far = max(far, abs(levels[-1][0] - reference_price))
    return far


def grouping_ladder(price: float, base_bin: float,
                    span: float = 0.0) -> list[float]:
    """The selectable bin sizes for a symbol at this price, ascending.

    Never finer than the symbol's own `price_bin` — that is the exchange's
    own resolution and aggregating below it would invent detail — and
    never so coarse that the book collapses into a couple of rows.
    """
    if not (price > 0):
        return [base_bin] if base_bin > 0 else []
    cap = price * MAX_FRACTION_OF_PRICE
    if span > 0:
        cap = min(cap, max(nice_bin(span / MIN_BINS_PER_SIDE), base_bin))
    ladder: list[float] = []
    for step in RELATIVE_STEPS_BP:
        candidate = nice_bin(price * step / 10_000)
        if candidate <= 0 or candidate < base_bin:
            continue
        if candidate > cap:
            break
        if candidate not in ladder:
            ladder.append(candidate)
    if base_bin > 0 and base_bin not in ladder:
        ladder.insert(0, base_bin)
    return sorted(ladder)


def default_bin(price: float, base_bin: float, span: float = 0.0) -> float:
    """What a symbol opens on: its configured bin, which is what the book
    showed before this ladder existed."""
    ladder = grouping_ladder(price, base_bin, span)
    if not ladder:
        return base_bin
    return min(ladder, key=lambda entry: abs(entry - base_bin))


def resolve_bin(price: float, base_bin: float, requested: float | None,
                span: float = 0.0) -> float:
    """The bin actually used. A client may ask for anything, so the request
    is snapped to the nearest rung of the ladder rather than trusted."""
    ladder = grouping_ladder(price, base_bin, span)
    if not ladder:
        return base_bin
    if requested is None or not (requested > 0) or math.isinf(requested):
        return default_bin(price, base_bin, span)
    return min(ladder, key=lambda entry: abs(math.log(entry) - math.log(requested)))
