"""The client's timeframe table must match the server's.

Same reasoning as tests/test_symbol_registry_sync.py: the UI carries a copy
so it can render without a round trip, and a copy is only safe if drifting
is impossible. Adding an interval to one side and not the other produces a
button that 400s — which nobody notices until they click the one frame
nobody uses.

Both lists were probed against the live upstreams on 2026-08-27 rather than
copied from documentation: Binance serves all sixteen, Hyperliquid serves
every one except 1s and 6h.
"""

from __future__ import annotations

import re
from pathlib import Path

from market_lens.server import HL_UNSUPPORTED, INTERVAL_SECONDS, KLINE_INTERVALS

CONFIG_TS = (Path(__file__).resolve().parent.parent
             / "app" / "src" / "lib" / "config.ts")


def _array(name: str) -> list[str]:
    """Pull a string array out of the TypeScript source by name."""
    text = CONFIG_TS.read_text(encoding="utf-8")
    match = re.search(rf"{name}[^=]*=\s*\[(.*?)\]", text, re.S)
    assert match is not None, f"{name} not found in config.ts"
    return re.findall(r'"([^"]+)"', match[1])


def _tf_seconds() -> dict[str, int]:
    text = CONFIG_TS.read_text(encoding="utf-8")
    match = re.search(r"TF_SECONDS[^{]*\{(.*?)\n\};", text, re.S)
    assert match is not None, "TF_SECONDS not found"
    return {key: int(value.replace("_", ""))
            for key, value in re.findall(r'"([^"]+)":\s*([\d_]+)', match[1])}


def test_the_parser_matched_something():
    """A regex that found nothing would make every assertion below vacuous."""
    assert len(_array("TIMEFRAMES")) >= 10
    assert len(_tf_seconds()) >= 10


def test_the_same_intervals_in_the_same_order():
    assert _array("TIMEFRAMES") == list(KLINE_INTERVALS)


def test_interval_lengths_agree():
    assert _tf_seconds() == INTERVAL_SECONDS


def test_the_hyperliquid_exclusions_agree():
    assert set(_array("HL_UNSUPPORTED")) == set(HL_UNSUPPORTED)


def test_quick_and_grouped_frames_are_real_intervals():
    """The pills and the dropdown groups are hand-written subsets — a typo
    there renders a button that cannot resolve."""
    known = set(KLINE_INTERVALS)
    assert set(_array("QUICK_TIMEFRAMES")) <= known
    text = CONFIG_TS.read_text(encoding="utf-8")
    groups = re.search(r"TIMEFRAME_GROUPS[^=]*=\s*\[(.*?)\n\];", text, re.S)
    assert groups is not None, "TIMEFRAME_GROUPS not found"
    grouped = set(re.findall(r'"([^"]+)"', groups[1])) - {
        "seconds", "minutes", "hours", "days and up"}
    assert grouped <= known
    assert grouped == known, "every interval should be reachable from the menu"
