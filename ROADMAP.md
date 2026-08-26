# Roadmap — Market Lens

Tracker for this repo (same rules as the arena's: outcomes, kept current,
nothing Done unverified).

## L0 — Record what cannot be re-bought *(agreed 2026-08-25)*

- [x] Depth + big-trade recorder running inside the collector — started
      with the MVP server (CSV); moved to SQLite (`data_recorded/lens.db`,
      `market_lens/store.py`, WAL, indexed on symbol+ts) 2026-08-25 so the
      seed query stays constant-time and the multi-day heatmap gets its
      range reads.
- [x] Collector on the VPS (2026-08-26) behind nginx + Let's Encrypt at
      market-lens.runsudo.net, systemd unit, auto-deploy on push. It is a
      real 24/7 archive now.
- [x] Retention wired (2026-08-26). `prune_before` had existed for a day
      and *never been called* — the database grew unbounded. Now a loop
      applies a per-table policy: depth 14d, trades/flow/OI 90d, and
      forced-liquidation prints **never** pruned (no venue sells that
      history back).
- [x] **Derived state survives restarts** (2026-08-26). The liq map, CVD
      and volume profile were memory-only, so every deploy blanked them —
      and the deploy cron restarts on every push. Now `oi_observations`
      and `flow_minutes` archive the *inputs*, and startup replays them:
      the estimator is a pure function of its observations, so the rebuilt
      map is the same map.
- [x] **All 51 symbols recorded**, watched or not (2026-08-26) — heatmap,
      depth, flow and liq map. Book history cannot be backfilled, so
      recording only what someone had open would leave exactly the gaps a
      later study needs.

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
- [x] **Coinbase + Kraken adapters** (2026-08-26): six venues in the
      aggregate; USD-quoted books join with the ~2bp peg smear, BNB/HYPE
      excluded where unlisted. Venue filter extended to the whole trade
      surface (tape, dashes, sounds) client-side. *Verified live: all six
      in depth.venues, six-venue wall attribution, Coinbase trades
      printing.* Same session, Arash's follow-up: **perp books added** —
      binance-fut (fapi REST + aggTrade), bybit-fut, okx-fut as distinct
      venues; nine books total, perp tapes dominate as expected.
      Remaining candidate: dYdX v4
- [x] **51 symbols incl. equities** (2026-08-26): Hyperliquid builder dexes
      (HIP-3) list perps on real-world assets as `dex:SYMBOL`. Only `xyz`
      has real flow ($2.1B/24h vs $0 on most others, measured), so stocks,
      indices and commodities all come from it; illiquid tickers (NFLX,
      GME, ARM, ASML, VIX, DXY — all under $1.5M/24h there) left out
      deliberately. Plus 16 more main-dex coins. Core/extended tier keeps
      the cost flat. *Verified live: NVDA, GOLD trading with book + tape.*
- [x] Searchable symbol picker (ticker or company name, grouped by asset
      class, `/` to open, rows are real anchors) — the pill row does not
      scale to 51. Registry drift guarded by a test that parses the TS.
- [x] Live price in the tab title; TradingView-style candle-close
      countdown on the chart.
- [x] **OKX perp contract-size fix** (2026-08-26): swap `sz` is contracts,
      not coins (BTC 0.01, ETH 0.1, DOGE 1000). okx-fut was 100x over on
      BTC/BNB, 10x on ETH, 1000x under on DOGE — 63k phantom whale prints
      and a fake wall in the depth aggregate. Archive repaired, backup
      kept. Caught by a CVD calibration control reading 777x.
- [x] **Per-venue accumulators — the venue filter now reaches the profile,
      the VWAP, CVD, the pressure gauge and the tape/combined verdicts**
      (2026-08-26). Profile and pressure are keyed by venue in memory;
      `flow_minutes` gained a venue column (explicit migration) and the
      filtered CVD is summed in SQL, because a per-venue minute series in
      memory would run to ~1M floats. *Verified live: BTC tape 5m went
      from $5.61M/$28.62M across nine venues to $325K/$931K on Coinbase
      alone.* Two stated limits: the heatmap stays all-venue (a ring per
      venue costs ~250MB) and pre-2026-08-26 flow rows have no venue, so
      they count unfiltered only.
- [x] **Net long/short positioning line** (2026-08-26): Binance ratio
      metrics (all accounts / top-20% accounts / top-20% positions) and
      the Bitfinex margin book, normalised to a -100..+100 lean on its own
      chart scale, with a source picker. Both APIs serve only a trailing
      window, so every reading is archived — 42.5k rows in the first pass.
- [x] **Symbol info panel** (2026-08-27): returns/volume/range/volatility
      computed from candles (so it covers the equity perps too), market
      cap + supply from CoinGecko for the coins, OI/funding, and 24h
      liquidations + net positioning from our own archive. Blank where
      history is too short or the instrument has no float — stated, not
      approximated.
- [x] **Liquidation feed moved to OKX** (2026-08-27). Binance's
      `forceOrder` stream had gone silent: 4 minutes on the all-market
      feed, socket open, zero frames, and **zero rows archived in a day**.
      The "moat" data was recording nothing. OKX publishes the same event,
      is alive, and its contract sizing is applied. *Verified: rows
      arriving with correct base-unit sizes.*
- [ ] Positioning as a strategy input — tested under the arena's
      promotion criteria like everything else, never trusted because it
      looks suggestive
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
