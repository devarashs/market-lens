# Market Lens

Live market-structure charts: price action with the **order book made
visible** — resting liquidity aggregated across venues drawn as depth bars on
the chart, and every big executed trade on a live tape. The premise (Arash's):
market structure is where the size sits; price gravitates toward large resting
liquidity. The caveat the tool embodies: resting orders are *claims* (walls
get pulled — spoofing is real), executed prints are *facts* — so both layers
are shown, visually distinct.

Second product beside the [trading arena](../trading-arena) — separate by
design; integration into the automated strategies comes later (book-imbalance
and tape-pressure features are tracked in the arena's strategy book).

## Run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # (.venv/bin/pip on Linux)
cd app && npm install && npm run build && cd ..  # build the UI once
.venv/Scripts/python -m market_lens
```

Then open **http://127.0.0.1:8899** — localhost only by design. The server
serves the prebuilt UI from `app/dist`, so production needs no Node. For UI
work: `cd app && npm run dev` (HMR, proxied to the collector on 8899);
`npm test` runs the frontend unit tests.

- Symbols: BTC, ETH, SOL, BNB, DOGE, HYPE (add more in `market_lens/config.py`)
- Venues: Binance spot + Hyperliquid perps (adapter pattern in
  `market_lens/venues.py`; one async task per venue, failure-isolated)
- Depth overlay: notional-summed, price-binned, sqrt-scaled bars
- Tape/markers: trades above a per-symbol notional threshold

## Recording (Phase L0 — the moat)

While running, the server records to SQLite at `data_recorded/lens.db`
(gitignored): binned depth snapshots every 30s and every big trade. This
history has no free source anywhere — it only exists if we record it,
which is why the collector should live on the 24/7 VPS eventually.
`market_lens/store.py` owns the schema (WAL mode, indexed on
`(symbol, ts)`); retention is `LensStore.prune_before()` when disk ever
matters. Upgrading from the CSV era: `python scripts/import_csv_archive.py`
migrates the old files once, then they can be deleted.

## Stack note

The UI (`app/`) is React 19 + TypeScript, built with Vite: Zustand as the
single client-state authority, React Router for URLs, Tailwind v4 carrying
the design tokens, and [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
(Apache-2.0, attribution in the footer) bundled from npm. Rebuilt from the
vanilla-JS MVP on 2026-08-25 when its complexity outgrew one file — the
rebuild's architecture notes live in the in-app docs under "Architecture".
Plain React over Next.js deliberately: an all-client realtime app with no
SSR surface, deployed as static files served by the Python collector — one
process in production, no Node runtime. Not financial advice; a
visualization tool.
