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
.venv/Scripts/python -m market_lens
```

Then open **http://127.0.0.1:8899** — localhost only by design.

- Symbols: BTC, ETH, SOL, BNB, DOGE, HYPE (add more in `market_lens/config.py`)
- Venues: Binance spot + Hyperliquid perps (adapter pattern in
  `market_lens/venues.py`; one async task per venue, failure-isolated)
- Depth overlay: notional-summed, price-binned, sqrt-scaled bars
- Tape/markers: trades above a per-symbol notional threshold

## Recording (Phase L0 — the moat)

While running, the server appends to `data_recorded/` (gitignored):
binned depth snapshots every 30s and every big trade. This history has no
free source anywhere — it only exists if we record it, which is why the
collector should live on the 24/7 VPS eventually. CSV now; revisit format
(parquet + rotation) when volumes demand.

## Stack note

Vanilla JS + vendored [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
(Apache-2.0, attribution in the footer), served by the Python collector
itself — deliberately no framework or build step at MVP stage per the
house doctrine ("plain over more-than-needed"); graduates to Next.js when
UI complexity earns it. Not financial advice; a visualization tool.
