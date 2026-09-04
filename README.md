# Market Lens

**Live cross-venue market microstructure, on one chart.** Price action with
the order book made visible — resting liquidity aggregated from nine venues
drawn as depth bars on the chart, every large executed trade on a live tape
with audio, forced liquidations on their own strip, and a recorded history
of all of it that no venue sells back.

Live instance: **https://market-lens.runsudo.net**

The premise: market structure is where the size sits — price gravitates
toward large resting liquidity. The caveat the tool embodies: resting
orders are *claims* (walls get pulled; spoofing is real) while executed
prints are *facts* — so the two layers are always visually distinct.

> **Not financial advice.** Market Lens is a visualization and measurement
> instrument. Markets — crypto especially — are volatile; nothing shown
> here is a recommendation to buy or sell anything.

## What it shows

- **Chart** — candles at 16 timeframes (1s→1M) with a cross-venue depth
  overlay (notional-summed, price-binned relative to the symbol's price,
  sqrt-scaled), a liquidity heatmap behind price, volume profile,
  session VWAP, and an estimated liquidation-cluster map.
- **Tape** — every trade above a per-symbol notional threshold, sized and
  colored, with a WebAudio note per print (scheduled, compressed, no
  machine-gunning) and a separate strip for forced liquidations.
- **Order book** — aggregated across venues at price-relative groupings
  (a BTC book groups at $100…$10,000; a DOGE book at fractions of a cent)
  built from up to 10,000 levels a side, plus a top-walls panel.
- **Markets** — a 24h cross-symbol flow table built from recorded prints.
- **Sessions** — the trading-hub clock (Asia/Europe/US), with each hub's
  share of volume measured from this instance's own recorded history
  rather than folklore.
- **Docs** — in-app pages explaining how to read tape, books, and every
  layer's honest limitations.

## Venues

Binance (spot, futures, liquidations), Bybit (spot, futures), OKX (spot,
futures, liquidations), Hyperliquid, Coinbase, Kraken, Bitget, Deribit
(inverse perps), Gate.io — one failure-isolated async adapter per feed in
[`market_lens/venues.py`](market_lens/venues.py). 52 symbols are recorded
around the clock; contract-unit conversions (OKX `ctVal`, Deribit USD
inverse sizing) are handled per venue and tested, because getting them
wrong once produced phantom whales.

## Run it

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # .venv/bin/pip on Linux
cd app && npm install && npm run build && cd ..  # build the UI once
.venv/Scripts/python -m market_lens
```

Open **http://127.0.0.1:8899**. The Python collector serves the prebuilt
UI from `app/dist`, so production needs no Node runtime — one process, no
API keys, only public market-data feeds.

For UI development: `cd app && npm run dev` (HMR, proxied to a local
collector on 8899) or `npm run dev:vps` to develop against the deployed
collector's live flow. `npm test` runs the frontend suite;
`.venv/Scripts/python -m pytest` runs the collector's.

## Recording

While running, the collector archives to SQLite (`data_recorded/lens.db`,
WAL mode): binned depth snapshots, large prints, per-minute flow, open
interest observations, and forced liquidations — with a per-table
retention policy in which liquidation prints are **never** pruned, because
that history has no free source anywhere. Derived state (liquidation map,
CVD, volume profile) is rebuilt from archived inputs on restart, so a
deploy never blanks it. `market_lens/store.py` owns the schema.

## Stack

The UI (`app/`) is React 19 + TypeScript built with Vite — Zustand as the
single client-state authority, React Router, Tailwind v4 carrying the
design tokens, and [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
(Apache-2.0, attribution in the footer). Plain React over Next.js
deliberately: an all-client realtime app with no SSR surface. The backend
is asyncio Python (aiohttp), one process: venue adapters → aggregation →
WebSocket broadcast + SQLite archive. Architecture notes live in the
in-app docs.

## License

© 2026 devarashs. All rights reserved. The source is public to be read;
no license to reuse, copy, or redistribute it is granted at this time.
