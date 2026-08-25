# Roadmap — Market Lens

Tracker for this repo (same rules as the arena's: outcomes, kept current,
nothing Done unverified).

## L0 — Record what cannot be re-bought *(agreed 2026-08-25)*

- [~] Depth + big-trade recorder running inside the collector (CSV,
      `data_recorded/`) — started with the MVP server; needs 24/7 hosting
      (arena's VPS) to become a real archive
- [ ] Move collector to the VPS alongside the arena's cycle; add rotation /
      parquet when file sizes demand

## L1 — Rich tool *(agreed 2026-08-25; feature sprint same day)*

- [x] Live chart per symbol (BTC/ETH/SOL/BNB/DOGE/HYPE) with timeframe
      selector (1m→1d), cross-venue depth overlay, big-trade tape + sized
      chart markers. *Verified in browser.*
- [x] **Four venues aggregated**: Binance (REST full-depth 500 levels +
      aggTrade WS), Hyperliquid, Bybit (orderbook.200 delta), OKX (books
      400 delta) — failure-isolated adapters, DeltaBook maintenance.
- [x] Live liquidity heatmap (in-memory ~1h ring @10s) drawn behind price —
      resting-claims layer through time.
- [x] Volume profile (executed notional by price, buy/sell split) — the
      facts layer; CVD line on the left scale.
- [x] Book-imbalance + 5-minute tape-pressure gauges; top-walls watcher
      with distance-from-mid.
- [x] Funding / next-funding countdown / OI / 24h-change metrics bar;
      per-symbol 24h% on the watchlist pills.
- [x] Venue toggles (per-client filtered aggregation), tape threshold
      slider (×0.25–×4), heatmap/profile visibility toggles.
- [ ] Coinbase, Kraken, dYdX v4 adapters (reference: docs/venue-feeds.md)
- [ ] Symbol add/remove from the UI (config-only today)
- [ ] Price alerts (browser notifications on level cross)

## L2 — History *(needs L0 archive)*

- [ ] Liquidity heatmap over time (the Bookmap-style view)
- [ ] Volume profile + CVD panel
- [ ] Venue-comparison view (where is the book deep, who leads price)

## L3 — Integration with the arena *(explicitly later, per Arash)*

- [ ] Book-imbalance / tape-pressure features exported to the arena's
      strategy book as candidates — tested under its promotion criteria
      like everything else
