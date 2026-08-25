"""One-time migration: data_recorded/*.csv → data_recorded/lens.db.

Run once from the repo root after upgrading past the CSV recorder:

    python scripts/import_csv_archive.py

Safe to re-run — symbols already present in a table are skipped, so it
never duplicates. The CSVs are left in place for you to delete or keep;
the server no longer reads or writes them.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from market_lens.config import RECORD_DIR  # noqa: E402
from market_lens.store import LensStore  # noqa: E402


def main() -> None:
    store = LensStore(RECORD_DIR / "lens.db")
    try:
        imported = store.import_csv_archive(RECORD_DIR)
        totals = store.counts()
    finally:
        store.close()
    print(f"imported: {imported['trades']} trades, "
          f"{imported['depth_snapshots']} depth rows "
          f"({imported['skipped_rows']} malformed rows skipped)")
    print(f"database now holds: {totals['trades']} trades, "
          f"{totals['depth_snapshots']} depth rows")


if __name__ == "__main__":
    main()
