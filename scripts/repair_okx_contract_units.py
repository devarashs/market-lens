"""One-time repair of the okx-fut contract-unit bug (2026-08-26).

The OKX perp adapter treated swap sizes as base units when they are
CONTRACTS (BTC 0.01, ETH 0.1, SOL 1, DOGE 1000 per contract), so
okx-fut data was wrong by a per-symbol constant between 2026-08-26
12:33 UTC and the fix at 15:55 UTC.

WHAT IS REPAIRED vs WHAT IS DELETED, and why the difference:

  trades      Repairable. The error is a known constant, so sizes and
              notionals are corrected in place. The row SELECTION was
              also wrong — a trade entered the archive by clearing the
              big-trade threshold at an inflated notional — so rows that
              no longer clear it after correction are removed. What
              remains is true whale prints at true sizes. DOGE okx-fut
              whales were understated 1000x and so were never recorded
              at all: that leaves a gap, which is honest, where a
              correction would have been invention.

  flow_minutes / depth_snapshots
              NOT repairable. Both are aggregates across venues with no
              venue column, so the okx-fut contribution cannot be
              separated out after the fact. The affected rows are
              deleted. They are hours old, and an archive that looks
              fine while carrying a 100x phantom OKX book is worse than
              one with a visible gap — a future study cannot spot the
              contamination, but it can spot a hole.

Idempotent: repairs are keyed on rows that still look inflated, and a
second run finds nothing to do. Run with --apply; a bare run reports.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

from market_lens.config import RECORD_DIR, SYMBOLS

# ctVal per OKX swap, as fetched from the instruments endpoint.
CONTRACT_VALUES = {"BTC": 0.01, "ETH": 0.1, "SOL": 1.0, "DOGE": 1000.0,
                   "BNB": 0.01}
# The window the adapter ran with the bug (epoch ms).
BUG_START_MS = 1_787_747_580_000   # 2026-08-26 12:33 UTC
BUG_END_MS = 1_787_759_760_000     # 2026-08-26 15:56 UTC — the deploy


def main() -> None:
    apply = "--apply" in sys.argv
    connection = sqlite3.connect(RECORD_DIR / "lens.db")
    plan: list[str] = []

    for symbol, multiplier in CONTRACT_VALUES.items():
        affected = connection.execute(
            "SELECT COUNT(*) FROM trades WHERE venue = 'okx-fut' AND symbol = ?"
            " AND ts BETWEEN ? AND ?",
            (symbol, BUG_START_MS, BUG_END_MS)).fetchone()[0]
        if not affected:
            continue
        threshold = SYMBOLS[symbol].big_trade_usd
        if multiplier == 1.0:
            plan.append(f"  {symbol}: {affected} okx-fut trades already correct "
                        f"(ctVal 1) — untouched")
            continue
        survivors = connection.execute(
            "SELECT COUNT(*) FROM trades WHERE venue = 'okx-fut' AND symbol = ?"
            " AND ts BETWEEN ? AND ? AND notional_usd * ? >= ?",
            (symbol, BUG_START_MS, BUG_END_MS, multiplier, threshold)).fetchone()[0]
        plan.append(f"  {symbol}: x{multiplier} -> {affected} rows corrected, "
                    f"{affected - survivors} fall below the ${threshold:,.0f} "
                    f"threshold and are removed, {survivors} kept")
        if apply:
            connection.execute(
                "UPDATE trades SET size = size * ?, notional_usd = notional_usd * ?"
                " WHERE venue = 'okx-fut' AND symbol = ? AND ts BETWEEN ? AND ?",
                (multiplier, multiplier, symbol, BUG_START_MS, BUG_END_MS))
            connection.execute(
                "DELETE FROM trades WHERE venue = 'okx-fut' AND symbol = ?"
                " AND ts BETWEEN ? AND ? AND notional_usd < ?",
                (symbol, BUG_START_MS, BUG_END_MS, threshold))

    contaminated = [s for s, m in CONTRACT_VALUES.items() if m != 1.0]
    placeholders = ",".join("?" * len(contaminated))
    depth = connection.execute(
        f"SELECT COUNT(*) FROM depth_snapshots WHERE ts >= ?"
        f" AND symbol IN ({placeholders})",
        (BUG_START_MS, *contaminated)).fetchone()[0]
    flow = connection.execute(
        "SELECT COUNT(*) FROM flow_minutes WHERE ts >= ?",
        (BUG_START_MS,)).fetchone()[0]
    plan.append(f"  depth_snapshots: {depth} rows deleted "
                f"({', '.join(contaminated)} — venue mix not separable)")
    plan.append(f"  flow_minutes: {flow} rows deleted (all symbols — the "
                f"aggregate includes okx-fut)")
    if apply:
        connection.execute(
            f"DELETE FROM depth_snapshots WHERE ts >= ? AND symbol IN ({placeholders})",
            (BUG_START_MS, *contaminated))
        connection.execute("DELETE FROM flow_minutes WHERE ts >= ?", (BUG_START_MS,))
        connection.commit()

    print("APPLIED" if apply else "DRY RUN (pass --apply to execute)")
    print("\n".join(plan))
    counts = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
              for table in ("trades", "depth_snapshots", "flow_minutes",
                            "liquidations", "oi_observations")}
    print(f"  resulting counts: {counts}")


if __name__ == "__main__":
    main()
