# Roadmap — Market Lens

Tracker for this repo (same rules as the arena's: outcomes, kept current,
nothing Done unverified).

## L0 — Record what cannot be re-bought *(agreed 2026-08-25)*

- [~] Depth + big-trade recorder running inside the collector — started
      with the MVP server (CSV); moved to SQLite (`data_recorded/lens.db`,
      `market_lens/store.py`, WAL, indexed on symbol+ts) 2026-08-25 so the
      seed query stays constant-time and the multi-day heatmap gets its
      range reads. Needs 24/7 hosting (arena's VPS) to become a real archive
- [ ] Move collector to the VPS alongside the arena's cycle; pick a
      retention window there (`LensStore.prune_before` is the hook)

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
- [x] **Liquidation layer** (2026-08-26, Arash's ask): real forceOrder
      prints from Binance futures recorded to lens.db (unbackfillable —
      the moat) + drawn as violet × marks; estimated liquidation-density
      map from OI-delta × leverage-tier projection (assumptions stated in
      market_lens/liqmap.py), bands consumed on price cross, 24h decay.
      Feeds the arena's liquidation-cascade backlog thesis.
- [ ] Coinbase, Kraken, dYdX v4 adapters (reference: docs/venue-feeds.md)
- [ ] Symbol add/remove from the UI (config-only today)
- [ ] Price alerts (browser notifications on level cross)

## L1.5 — Proper-stack client rebuild *(Arash 2026-08-25: "laggy, things
disappear, reload to get it back — move to a proper stack, choose one")*

Diagnosis (from web/app.js as shipped): no rAF batching — every 400ms depth
push runs DOM + two-canvas redraws synchronously (the lag); socket has no
onerror, no staleness watchdog, and one unguarded onmessage where a single
throw silently kills a message type (the "disappears until reload"); 830
lines of global mutable state make it unfixable in place.

Stack chosen: **Vite + React 19 + TypeScript + Tailwind v4 + Zustand +
React Router + lightweight-charts (npm, v4 line) + Vitest.** Plain React
over Next.js deliberately: all-client realtime canvas app, no SSR/SEO
surface, and prod stays a single Python process serving static `app/dist`
— no Node runtime on the VPS. Assumptions: the Python collector stays
(symptoms are all client-side; it was just verified onto SQLite), and the
existing visual design is kept — it is the established convention.

- [x] Scaffold `app/` (Vite/TS/Tailwind tokens ported from style.css)
- [x] Data layer: typed messages, LensSocket (backoff+jitter reconnect,
      resubscribe, 10s staleness watchdog, per-message error isolation),
      Zustand store, pure candle/MA/format libs — unit tested
- [x] Chart + overlays: LWC lifecycle component, ported canvas draw
      functions, rAF-driven overlay loop decoupled from React renders
- [x] Full UI parity: header/metrics/readout/signals/footer toggles
      (layers, MAs, venues), tape panel, docs route with search, routing,
      prefs, PNG export, shortcuts, beep
- [x] Server serves `app/dist`; legacy `web/` removed
- [x] Verified: build clean, tests green, browser walk of chart/toggles/
      symbol+timeframe switching/docs/reconnect-after-server-restart

All verified 2026-08-26: 25 Vitest + 26 pytest green, browser walk done
(routing, toggles, shortcuts, docs search, HYPE 1s guard) and the reported
failure reproduced+fixed: server killed under a live page -> "reconnecting",
server back -> same page instance auto-recovers, reseeds 120 tape rows.
Overlay geometry pinned by unit tests; on-screen paint re-checked in the
pane at next opportunity (rAF is suspended while the pane is hidden).

## L2 — History *(needs L0 archive)*

- [ ] Liquidity heatmap over time (the Bookmap-style view)
- [ ] Volume profile + CVD panel
- [ ] Venue-comparison view (where is the book deep, who leads price)

## L3 — Integration with the arena *(explicitly later, per Arash)*

- [ ] Book-imbalance / tape-pressure features exported to the arena's
      strategy book as candidates — tested under its promotion criteria
      like everything else
