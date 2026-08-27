"""Price grouping: nice numbers, price-relative ladders, untrusted input."""

import math

import pytest

from market_lens.grouping import (
    MAX_FRACTION_OF_PRICE, MIN_BINS_PER_SIDE, book_span, default_bin,
    grouping_ladder, nice_bin, resolve_bin,
)


def test_nice_bin_snaps_to_the_nearest_one_two_five():
    assert nice_bin(7.8) == 10
    assert nice_bin(1.9) == 2
    assert nice_bin(3.1) == 2      # nearest in log space, not rounded up
    assert nice_bin(0.9) == 1
    assert nice_bin(780) == 1000


def test_nice_bin_handles_small_prices_without_float_dust():
    assert nice_bin(0.0000078) == 0.00001
    assert nice_bin(0.021) == 0.02


def test_nice_bin_rejects_nonsense():
    assert nice_bin(0) == 0
    assert nice_bin(-5) == 0
    assert nice_bin(float("inf")) == 0


def test_btc_ladder_reaches_the_thousands_when_nothing_caps_it():
    """The complaint that started this: BTC's coarsest grouping was $100.
    Capped only by price, the ladder does reach the thousands."""
    ladder = grouping_ladder(78_000, 10.0)
    for wanted in (10, 100, 1_000, 5_000, 10_000):
        assert wanted in ladder, f"{wanted} missing from {ladder}"


def test_a_real_btc_book_caps_the_ladder_far_below_that():
    """Measured 2026-08-27: the full Binance BTC book spans +/-1.3%, about
    $1,000. A $10k bin puts the entire book in one row, so the ladder must
    not offer it however round the number looks."""
    ladder = grouping_ladder(78_000, 10.0, span=1_040)
    assert max(ladder) == 500
    assert 1_000 not in ladder


def test_the_shallow_book_we_actually_poll_keeps_btc_at_100():
    """limit=1000 reaches +/-$304 on BTC. The old x10 multiplier gave $100;
    the new ladder must not quietly take that away."""
    assert max(grouping_ladder(79_500, 10.0, span=304)) == 100


def test_the_coarsest_rung_still_fills_the_ladder():
    for price, base, span in ((78_000, 10.0, 1_040), (100.0, 0.05, 1.5)):
        coarsest = max(grouping_ladder(price, base, span))
        assert span / coarsest >= MIN_BINS_PER_SIDE - 1


def test_span_never_empties_the_ladder():
    """A book so thin the cap falls below the symbol's own bin still
    leaves one usable setting."""
    assert grouping_ladder(78_000, 10.0, span=1.0) == [10.0]


def test_book_span_reads_the_farthest_level():
    books = [
        {"bids": [(99.0, 1), (95.0, 1)], "asks": [(101.0, 1), (104.0, 1)]},
        {"bids": [(98.0, 1), (90.0, 1)], "asks": [(102.0, 1)]},
    ]
    assert book_span(books, 100.0) == 10.0


def test_book_span_tolerates_empty_and_missing_sides():
    assert book_span([{"bids": [], "asks": []}], 100.0) == 0.0
    assert book_span([{}], 100.0) == 0.0
    assert book_span([], 100.0) == 0.0
    assert book_span([{"bids": [(90.0, 1)]}], 0.0) == 0.0


def test_sol_ladder_is_scaled_to_its_own_price():
    ladder = grouping_ladder(100.0, 0.05)
    assert min(ladder) <= 0.05 and max(ladder) >= 10
    assert 1 in ladder


def test_ladder_has_no_sparse_gaps():
    """Rounding up used to collapse neighbouring rungs, leaving jumps of
    5x in the middle of a ladder."""
    for price, base in ((78_000, 10.0), (100.0, 0.05), (210.0, 0.1)):
        ladder = grouping_ladder(price, base)
        for finer, coarser in zip(ladder, ladder[1:]):
            assert coarser / finer <= 3.0, f"{finer}->{coarser} in {ladder}"


def test_doge_ladder_stays_in_fractions_of_a_cent():
    ladder = grouping_ladder(0.09, 0.0005)
    assert max(ladder) <= 0.09 * MAX_FRACTION_OF_PRICE + 1e-12
    assert all(entry > 0 for entry in ladder)


def test_ladder_never_goes_finer_than_the_exchange_bin():
    """Aggregating below the venue's own resolution would invent detail."""
    assert min(grouping_ladder(78_000, 10.0)) >= 10


def test_ladder_is_ascending_and_unique():
    ladder = grouping_ladder(78_000, 10.0)
    assert ladder == sorted(ladder)
    assert len(ladder) == len(set(ladder))


def test_ladder_is_capped_relative_to_price():
    for price, base in ((78_000, 10.0), (100.0, 0.05), (0.09, 0.0005)):
        assert max(grouping_ladder(price, base)) <= price * MAX_FRACTION_OF_PRICE + 1e-9


def test_default_is_what_the_book_showed_before():
    assert default_bin(78_000, 10.0) == 10
    assert default_bin(100.0, 0.05) == 0.05


def test_resolve_snaps_a_request_to_the_ladder():
    assert resolve_bin(78_000, 10.0, 900) == 1_000
    assert resolve_bin(78_000, 10.0, 1_000) == 1_000


def test_resolve_clamps_a_request_the_book_cannot_support():
    """A preference stored when the book was deeper must not survive as a
    setting that renders one row."""
    assert resolve_bin(78_000, 10.0, 10_000, span=1_040) == 500


def test_resolve_never_trusts_the_client():
    """A client can ask for anything; the server decides."""
    assert resolve_bin(78_000, 10.0, 0) == 10
    assert resolve_bin(78_000, 10.0, -5) == 10
    assert resolve_bin(78_000, 10.0, None) == 10
    assert resolve_bin(78_000, 10.0, float("inf")) == 10
    # Absurdly coarse requests clamp to the top rung, not past it.
    assert resolve_bin(78_000, 10.0, 1e9) == max(grouping_ladder(78_000, 10.0))


def test_resolve_without_a_price_falls_back_to_the_base_bin():
    assert resolve_bin(0, 10.0, 1_000) == 10.0
