"""SQLite persistence for the recorded archive: big trades + depth snapshots.

Replaces the L0 append-only CSVs (2026-08-25). Two reasons, both measured:
the tape-history seed was re-parsing an entire CSV on every symbol
subscribe (already 2k rows after one afternoon — unbounded on a 24/7
host), and the planned multi-day heatmap needs indexed time-range reads
that a growing flat file cannot serve.

Engine choice: SQLite over a server database on purpose. One writer
(the collector), occasional readers, a 2 GB VPS — a database *server*
would be pure operational overhead here. WAL mode keeps the file safe
across crashes and allows a concurrent reader process (e.g. the arena
bot) without coordination.

Durability: synchronous=NORMAL under WAL. A power cut can lose the last
few rows but can never corrupt the file — acceptable for market data
that regenerates continuously, and it keeps inserts off the fsync path
of the event loop.
"""

from __future__ import annotations

import csv
import sqlite3
from pathlib import Path

# Depth snapshots archive the strongest bins only: 25 per side covers every
# wall the UI surfaces while keeping the archive ~1 MB/day across all
# symbols. Widening this is a deliberate storage decision, not a default.
DEPTH_ARCHIVE_BINS_PER_SIDE = 25

_SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
    ts           INTEGER NOT NULL,  -- exchange timestamp, epoch ms
    symbol       TEXT    NOT NULL,
    venue        TEXT    NOT NULL,
    side         TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
    price        REAL    NOT NULL,
    size         REAL    NOT NULL,
    notional_usd REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_symbol_ts ON trades (symbol, ts);

CREATE TABLE IF NOT EXISTS depth_snapshots (
    ts           INTEGER NOT NULL,  -- capture timestamp, epoch ms
    symbol       TEXT    NOT NULL,
    side         TEXT    NOT NULL CHECK (side IN ('bid', 'ask')),
    price_bin    REAL    NOT NULL,
    notional_usd REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_depth_symbol_ts ON depth_snapshots (symbol, ts);

-- Real forced liquidations from venue streams (Binance futures forceOrder).
-- `side` is the side that DIED: 'long' means a long was force-closed (the
-- forced order itself sells). This history cannot be backfilled from
-- anywhere — recording it is the point (arena backlog, 2026-08-24).
CREATE TABLE IF NOT EXISTS liquidations (
    ts           INTEGER NOT NULL,  -- exchange timestamp, epoch ms
    symbol       TEXT    NOT NULL,
    venue        TEXT    NOT NULL,
    side         TEXT    NOT NULL CHECK (side IN ('long', 'short')),
    price        REAL    NOT NULL,
    size         REAL    NOT NULL,
    notional_usd REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_liq_symbol_ts ON liquidations (symbol, ts);
"""


class LensStore:
    """Single-owner archive handle. All calls run on the caller's thread —
    the collector's event loop — and each insert is a sub-millisecond WAL
    append, so no executor indirection is needed at recording rates
    (one 50-row snapshot batch per symbol per 30s, whale trades rarer).
    """

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(db_path)
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA synchronous = NORMAL")
        self.connection.executescript(_SCHEMA)
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    # ------------------------------------------------------------- writes

    def insert_trade(self, symbol: str, venue: str, trade: dict) -> None:
        """Archive one at-or-above-threshold trade.

        `trade` is the venue-adapter shape: ts (ms), side, price, size,
        notional. Notional rounds to cents, matching the old CSV record.
        """
        self.connection.execute(
            "INSERT INTO trades (ts, symbol, venue, side, price, size, notional_usd)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (trade["ts"], symbol, venue, trade["side"], trade["price"],
             trade["size"], round(trade["notional"], 2)),
        )
        self.connection.commit()

    def insert_depth_snapshot(self, symbol: str, ts_ms: int, profile: dict) -> None:
        """Archive one aggregated-book snapshot (top bins per side).

        `profile` is `aggregate_books()` output: {"bids": [[price_bin,
        notional], ...], "asks": [...]} sorted strongest-first is NOT
        guaranteed — bids/asks arrive nearest-mid first, which is what we
        keep: the near-mid band is where walls and the heatmap live.
        """
        rows = [
            (ts_ms, symbol, side[:-1], price_bin, notional_usd)
            for side in ("bids", "asks")
            for price_bin, notional_usd in profile[side][:DEPTH_ARCHIVE_BINS_PER_SIDE]
        ]
        self.connection.executemany(
            "INSERT INTO depth_snapshots (ts, symbol, side, price_bin, notional_usd)"
            " VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        self.connection.commit()

    def insert_liquidation(self, symbol: str, venue: str, liq: dict) -> None:
        """Archive one forced liquidation. `liq`: ts (ms), side ('long' died
        / 'short' died), price, size, notional."""
        self.connection.execute(
            "INSERT INTO liquidations (ts, symbol, venue, side, price, size,"
            " notional_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (liq["ts"], symbol, venue, liq["side"], liq["price"],
             liq["size"], round(liq["notional"], 2)),
        )
        self.connection.commit()

    # -------------------------------------------------------------- reads

    def recent_liquidations(self, symbol: str, limit: int) -> list[dict]:
        """Last `limit` liquidations for a symbol, oldest first — chart
        seeding, same shape the WS pushes live."""
        rows = self.connection.execute(
            "SELECT ts, venue, side, price, size, notional_usd FROM liquidations"
            " WHERE symbol = ? ORDER BY ts DESC LIMIT ?",
            (symbol, limit),
        ).fetchall()
        return [
            {"ts": ts, "venue": venue, "side": side, "price": price,
             "size": size, "notional": notional_usd}
            for ts, venue, side, price, size, notional_usd in reversed(rows)
        ]

    def recent_trades(self, symbol: str, limit: int) -> list[dict]:
        """Last `limit` archived trades for a symbol, oldest first —
        the shape `send_symbol_seed` merges with the in-memory ring."""
        rows = self.connection.execute(
            "SELECT ts, venue, side, price, size, notional_usd FROM trades"
            " WHERE symbol = ? ORDER BY ts DESC LIMIT ?",
            (symbol, limit),
        ).fetchall()
        return [
            {"ts": ts, "venue": venue, "side": side, "price": price,
             "size": size, "notional": notional_usd}
            for ts, venue, side, price, size, notional_usd in reversed(rows)
        ]

    def depth_range(self, symbol: str, start_ms: int, end_ms: int) -> list[tuple]:
        """Depth rows in [start_ms, end_ms] inclusive, time-ordered:
        (ts, side, price_bin, notional_usd). The read the multi-day
        heatmap will be built on."""
        return self.connection.execute(
            "SELECT ts, side, price_bin, notional_usd FROM depth_snapshots"
            " WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts",
            (symbol, start_ms, end_ms),
        ).fetchall()

    def counts(self) -> dict[str, int]:
        return {
            table: self.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("trades", "depth_snapshots", "liquidations")
        }

    # ---------------------------------------------------------- retention

    def prune_before(self, cutoff_ms: int) -> dict[str, int]:
        """Delete rows older than `cutoff_ms` from both tables; returns
        deleted counts per table. The retention hook — the *policy* (how
        long to keep) belongs to whoever schedules this, not the store."""
        deleted = {}
        for table in ("trades", "depth_snapshots", "liquidations"):
            cursor = self.connection.execute(
                f"DELETE FROM {table} WHERE ts < ?", (cutoff_ms,))
            deleted[table] = cursor.rowcount
        self.connection.commit()
        return deleted

    # ------------------------------------------------------- CSV migration

    def import_csv_archive(self, record_dir: Path) -> dict[str, int]:
        """One-time migration of the L0 CSV archive into the database.

        Discovers `<SYMBOL>_trades.csv` / `<SYMBOL>_depth.csv` by name, so
        it needs no symbol config. Guarded per symbol and table: a symbol
        that already has rows is skipped entirely, making a re-run safe
        (no duplicates) without pretending to be a general sync tool.
        Malformed rows are counted and skipped, not fatal — a partial
        CSV line from a killed process must not block the migration.
        """
        imported = {"trades": 0, "depth_snapshots": 0, "skipped_rows": 0}
        self._import_csv_files(
            record_dir, "_trades.csv", "trades", imported,
            lambda symbol, row: (
                "INSERT INTO trades (ts, symbol, venue, side, price, size,"
                " notional_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (int(row["ts"]), symbol, row["venue"], row["side"],
                 float(row["price"]), float(row["size"]),
                 float(row["notional"])),
            ),
        )
        self._import_csv_files(
            record_dir, "_depth.csv", "depth_snapshots", imported,
            lambda symbol, row: (
                "INSERT INTO depth_snapshots (ts, symbol, side, price_bin,"
                " notional_usd) VALUES (?, ?, ?, ?, ?)",
                (int(row["ts"]), symbol, row["side"],
                 float(row["price_bin"]), float(row["notional_usd"])),
            ),
        )
        self.connection.commit()
        return imported

    def _import_csv_files(self, record_dir: Path, suffix: str, table: str,
                          imported: dict[str, int], build_insert) -> None:
        for path in sorted(record_dir.glob(f"*{suffix}")):
            symbol = path.name[: -len(suffix)]
            if self._symbol_has_rows(table, symbol):
                continue
            with path.open("r", newline="") as handle:
                for row in csv.DictReader(handle):
                    # A torn tail line (process killed mid-write) shows up
                    # as missing fields or unparseable numbers — both land
                    # here and skip the row, never the migration.
                    try:
                        statement, values = build_insert(symbol, row)
                    except (KeyError, TypeError, ValueError):
                        imported["skipped_rows"] += 1
                        continue
                    self.connection.execute(statement, values)
                    imported[table] += 1

    def _symbol_has_rows(self, table: str, symbol: str) -> bool:
        return self.connection.execute(
            f"SELECT 1 FROM {table} WHERE symbol = ? LIMIT 1", (symbol,)
        ).fetchone() is not None
