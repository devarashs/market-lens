"""Launcher that works from any working directory (used by preview/launch
configs and later by the VPS service unit): puts the repo on sys.path, then
starts the server. `python -m market_lens` from the repo root does the same."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from market_lens.server import main  # noqa: E402

if __name__ == "__main__":
    main()
