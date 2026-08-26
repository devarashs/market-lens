"""The client's symbol table must match the server's.

app/src/lib/config.ts carries a copy of the registry so the UI stays
synchronous (no loading state on every symbol control). A copy is only
safe if drifting is impossible, and at 50 symbols hand-syncing two files
would not survive a single busy afternoon — so this test parses the
TypeScript and compares it to the authority.
"""

from __future__ import annotations

import re
from pathlib import Path

from market_lens.config import SYMBOLS

CONFIG_TS = Path(__file__).resolve().parent.parent / "app" / "src" / "lib" / "config.ts"
ROW = re.compile(
    r'\{\s*key:\s*"(?P<key>[^"]+)",\s*cls:\s*"(?P<cls>[^"]+)",\s*'
    r'seconds:\s*(?P<seconds>true|false),\s*threshold:\s*(?P<threshold>\d+)\s*\}')


def client_rows() -> dict[str, dict]:
    text = CONFIG_TS.read_text(encoding="utf-8")
    return {
        match["key"]: {
            "cls": match["cls"],
            "seconds": match["seconds"] == "true",
            "threshold": float(match["threshold"]),
        }
        for match in ROW.finditer(text)
    }


def test_the_regex_actually_matched_something():
    """A parser that silently matches nothing would make every other
    assertion here vacuously pass."""
    assert len(client_rows()) >= 40


def test_same_symbols_in_the_same_order():
    assert list(client_rows()) == list(SYMBOLS)


def test_asset_classes_match():
    rows = client_rows()
    mismatched = {key: (rows[key]["cls"], spec.asset_class)
                  for key, spec in SYMBOLS.items()
                  if rows[key]["cls"] != spec.asset_class}
    assert mismatched == {}


def test_thresholds_match():
    rows = client_rows()
    mismatched = {key: (rows[key]["threshold"], spec.big_trade_usd)
                  for key, spec in SYMBOLS.items()
                  if rows[key]["threshold"] != spec.big_trade_usd}
    assert mismatched == {}


def test_seconds_capability_follows_the_binance_listing():
    """1s candles come from Binance; Hyperliquid's finest is 1m."""
    rows = client_rows()
    mismatched = {key: (rows[key]["seconds"], spec.binance is not None)
                  for key, spec in SYMBOLS.items()
                  if rows[key]["seconds"] != (spec.binance is not None)}
    assert mismatched == {}
