/* Market Lens documentation content. One section = one nav entry = one
   search unit. Bodies are HTML; the search index strips tags at load.
   WARNING: section ids become DOM ids on a page that shares style.css with
   the chart app — never reuse an id the app styles (#chart, #overlay,
   #walls, #symbols, #timeframes, #tape-list, #threshold, …). An id
   collision here once absolutely-positioned a whole docs section over the
   header (2026-08-26). */

const DOCS = [
  {
    id: "overview",
    title: "Overview & philosophy",
    body: `
<p>Market Lens shows <b>where the size sits</b>: price action together with
the order book (resting liquidity aggregated across venues) and the tape
(executed trades). The premise: market structure is made by orders — price
tends to travel toward large resting liquidity, and big executed prints tell
you who is actually winning.</p>
<p>The tool's core distinction runs through every panel:
<b>claims vs facts</b>. Resting orders are <i>claims</i> — walls get pulled,
spoofing is real. Executed trades are <i>facts</i> — they cannot be faked.
Claims render faint (heatmap, depth bars); facts render bright (trade
dashes, volume profile, CVD). The automated readers weight facts over
claims for the same reason.</p>
<p>Not financial advice; a visualization and measurement instrument.</p>`,
  },
  {
    id: "getting-started",
    title: "Getting started",
    body: `
<p>Run the server (Python, from the repo root):</p>
<pre>.venv/Scripts/python -m market_lens</pre>
<p>Open <code>http://127.0.0.1:8899</code> — the server binds localhost
only, by design. The status pill (top right) shows <b>live</b> when the
browser is connected; it reconnects automatically after server restarts.</p>
<p>Data flows in from public venue feeds with no keys or accounts; while the
server runs it also records depth snapshots and big trades to
<code>data_recorded/</code> (see Recording).</p>`,
  },
  {
    id: "symbols-routing",
    title: "Symbols, routing & URLs",
    body: `
<p>Symbols: BTC, ETH, SOL, BNB, DOGE, HYPE — switch with the header pills or
keys <b>1–6</b>. Each pill shows the symbol's 24h change.</p>
<p>Every view has a URL: <code>/BTC/1m</code>, <code>/SOL/15m</code>… —
bookmarkable, shareable, and browser back/forward work. Adding a symbol is a
one-line change in <code>market_lens/config.py</code> (venue names, price
bin, big-trade threshold).</p>`,
  },
  {
    id: "charting",
    title: "Chart & timeframes",
    body: `
<p>Candles come from Binance (Hyperliquid for HYPE), 500 bars, refreshed
every 15 seconds so the forming candle stays honest. Timeframes: 1m, 5m,
15m, 1h, 4h, 1d — buttons in the header or <b>[</b> / <b>]</b> keys.</p>
<p>Charting is TradingView's open-source Lightweight Charts library
(Apache-2.0, vendored — no CDN dependency).</p>`,
  },
  {
    id: "depth",
    title: "Depth overlay (right edge)",
    body: `
<p>The current aggregated order book drawn as horizontal bars from the right
edge: green bids below, red asks above, at their price levels. Bar length
scales with the <b>square root</b> of resting notional (USD), so a 100×
larger wall reads ~10× longer — whales stay visible without flattening
everything else.</p>
<p>Books from all enabled venues are summed per price bin (bin sizes are
per-symbol, e.g. $10 for BTC). Notional (price × size) is the unit
everywhere, so venues and symbols are directly comparable. Binance
contributes a 500-level book via REST polling (~3s refresh — depth beyond
top-of-book is worth a little staleness); Bybit and OKX maintain live
delta books (200/400 levels); Hyperliquid pushes full snapshots.</p>`,
  },
  {
    id: "heatmap",
    title: "Liquidity heatmap",
    body: `
<p>The book <i>through time</i>: every 10 seconds the aggregated book is
binned and stored in a ring (~1 hour); each level draws as a thin horizontal
streak. <b>Persistent walls appear as long lines; pulled walls simply
end</b> — watching a wall vanish as price approaches is the spoof tell this
view exists for.</p>
<p>Brightness scales with each column's largest level. Toggle with the
footer checkbox or <b>h</b>. Caveat: the ring is in-memory, so it starts
empty on server restart and fills over the following hour (the disk record
in <code>data_recorded/</code> persists regardless).</p>`,
  },
  {
    id: "profile",
    title: "Volume profile (left edge)",
    body: `
<p>Executed volume by price for the session — the <b>facts</b> mirror of the
depth overlay. Each bar splits green/red by aggressive buy vs sell notional
at that price. Where the profile is fat, business was actually done; a fat
profile shelf under price is real acceptance, unlike a bid wall which is
only a claim. Toggle with the footer checkbox or <b>p</b>.</p>`,
  },
  {
    id: "cvd",
    title: "CVD (cumulative volume delta)",
    body: `
<p>The gold line on the left price scale: running total of buy-aggressor
notional minus sell-aggressor notional, minute-bucketed, across all venues.
Rising CVD with flat price = absorption by sellers; falling CVD with rising
price = short covering rather than real demand. Classic divergence tool —
and pure facts, no book claims involved.</p>`,
  },
  {
    id: "tape",
    title: "Big-trade tape & chart dashes",
    body: `
<p>Trades above the per-symbol threshold (BTC $100K, ETH $50K, SOL/BNB/DOGE
$25K, HYPE $10K) appear twice: in the side tape (side, size, price, venue,
time) and on the chart as <b>short bright dashes at the actual fill
price</b> — length and thickness grow with size; monsters (≥5× threshold)
get a printed label and, if enabled, a sound (higher pitch = buy).</p>
<p>The slider re-filters both views from ×0.1 to ×4 of the base threshold
(default ×0.5), retroactively. The server forwards flow from 10% of the
threshold so the chart carries aggregated-trade texture, not just whales;
dash length, thickness and opacity all scale with size. On load, the chart
seeds from the permanent whale archive plus an in-memory ring of recent
flow (~600 trades), so history is visible immediately.</p>`,
  },
  {
    id: "top-walls",
    title: "Top walls & venue attribution",
    body: `
<p>The four largest resting levels per side, with distance from mid. Hover a
row to see <b>which venues hold it</b> — an "aggregate" wall that is 90% one
venue is a different animal from one spread across four books.</p>
<p>The same walls draw on the chart as <b>order lines</b>: bright horizontal
lines at each wall's price, starting where the heat ring first saw the wall
appear and running to the right edge, thickness scaling with size, dollar
label at the line. Toggle with "order lines" in the footer. Note the top
walls usually cluster near the touch — that is real; the biggest resting
size almost always sits close to price.</p>`,
  },
  {
    id: "gauges",
    title: "Gauges: imbalance, pressure, spread",
    body: `
<p><b>Book imbalance</b>: share of near-mid resting notional on the bid side
(15 bins each way). <b>Tape 5m</b>: rolling five-minute aggressor totals,
buys vs sells, all venues. <b>Spread/divergence</b>: aggregated
best-bid/best-ask spread in basis points, plus the venue whose mid diverges
most from the aggregate. A <i>negative</i> aggregate spread appears when a
slower feed (Binance REST) lags a faster one — that crossed moment is
literally the latency arbitrage window, shown honestly rather than
hidden.</p>`,
  },
  {
    id: "metrics",
    title: "Metrics bar",
    body: `
<p>Per symbol: perp funding rate with next-funding countdown — shown from
Binance and Hyperliquid separately when both exist, because the
<i>spread between venue funding rates</i> is itself a positioning signal —
plus Hyperliquid open interest in USD and 24h change. Refreshes every 30
seconds.</p>`,
  },
  {
    id: "levels",
    title: "Day levels & VWAP",
    body: `
<p>Dotted reference lines: previous day high (PDH), low (PDL), close (PDC),
and today's open (O) — the levels the most eyes share. The dashed gold line
is <b>session VWAP</b>, notional-weighted across all recorded trades since
server start; institutions benchmark fills against it, which makes it a
gravity line worth watching. Toggle via "day levels" in the footer.</p>`,
  },
  {
    id: "readers",
    title: "The automated readers",
    body: `
<p>Three algorithmic readers score −100 (selling/offered) to +100
(buying/bid). Hover any score for its decomposition — every number is
explainable, no black boxes.</p>
<p><b>Tape reader</b> (facts): aggressor flow imbalance (5m), whale-print
skew (do big trades lean the same way as the crowd?), burst intensity (is
the last minute unusually heavy?), and CVD slope.</p>
<p><b>Book reader</b> (claims): near-mid imbalance plus <i>wall pull</i> —
which side's biggest wall is closer and larger. Wall influence is scaled by
<b>persistence</b> in the heatmap ring: a wall that just appeared counts for
almost nothing (spoof-grade evidence); one that has sat for many minutes
counts fully.</p>
<p><b>Combined</b>: weights tape 65/35 over book (facts over claims) and
speaks through an explicit rule table. The most important rule:
<b>strong buying into a close, persistent offer wall is flagged as
"absorption risk"</b>, not bullishness — the classic tape-reading trap,
inverted for sellers too. Aligned readings, one-sided tape into a neutral
book, and book-without-tape each get their own verdict phrasing.</p>`,
  },
  {
    id: "venues",
    title: "Venues & aggregation",
    body: `
<p>Four venues stream in: <b>Binance</b> (spot: REST 500-level book +
aggTrade stream), <b>Bybit</b> (spot: 200-level delta book + trades),
<b>OKX</b> (spot: 400-level delta book + trades), <b>Hyperliquid</b> (perps:
full book snapshots + trades). Each adapter is failure-isolated — one venue
dying or reconnecting never affects the others.</p>
<p>Footer checkboxes include/exclude venues from <i>your</i> aggregation
live (server-side, per client). Books are binned per symbol and summed in
USD notional. Candidate next venues (adapter pattern makes each ~an hour):
Coinbase, Kraken, dYdX v4 — see <code>docs/venue-feeds.md</code> in the
repo for the full survey.</p>`,
  },
  {
    id: "recording",
    title: "Recording (the archive)",
    body: `
<p>While running, the server appends to <code>data_recorded/</code>: binned
depth snapshots every 30s per symbol, and every big trade. This history has
<b>no free source anywhere</b> — order-book history is only owned by whoever
recorded it, which is why the collector should eventually live on an
always-on server. The recorded trades already power the chart's history
seeding; the depth archive will power the persistent (multi-day) heatmap.</p>`,
  },
  {
    id: "shortcuts",
    title: "Shortcuts, preferences, export",
    body: `
<p><b>Keyboard</b>: 1–6 symbols · [ and ] timeframe down/up · h heatmap ·
p volume profile.</p>
<p><b>Preferences</b> (toggles, threshold slider, alert) persist in the
browser across reloads. <b>PNG</b> button exports the current chart with
all overlays baked in, named <code>lens-SYMBOL-TF.png</code>.</p>`,
  },
  {
    id: "architecture",
    title: "Architecture & extending",
    body: `
<p>One Python process (aiohttp + websockets): venue adapter tasks →
normalized book/trade callbacks → accumulators (CVD, profile, pressure,
heat ring) → a 400ms broadcast loop that aggregates, scores the readers,
and pushes JSON over one WebSocket per browser. The frontend is deliberately
frameworkless: one vendored chart library, one JS file, canvas overlays.</p>
<p>To add a <b>symbol</b>: one line in <code>config.py</code>. To add a
<b>venue</b>: one adapter function in <code>venues.py</code> emitting the
normalized callbacks (the DeltaBook helper handles snapshot+delta books).
Aggregation, signals and tests live in pure functions
(<code>aggregate.py</code>, <code>signals.py</code>) — 11 unit tests pin
their behavior.</p>`,
  },
  {
    id: "limitations",
    title: "Limitations — read this one",
    body: `
<p>Honest edges of the tool: <b>(1)</b> the heatmap ring resets on server
restart (refills within the hour; disk record persists). <b>(2)</b> Binance
depth is ~3s stale by design — occasionally the aggregate book crosses
(negative spread) against faster feeds. <b>(3)</b> Volume profile, CVD, VWAP
and the readers accumulate <i>since server start</i>, not since midnight —
a freshly started server has thin facts for a while. <b>(4)</b> Spot books
(Binance/Bybit/OKX) and perp books (Hyperliquid) are mixed deliberately;
they usually agree, but perp-specific stress (funding extremes,
liquidations) can decouple them. <b>(5)</b> The readers are heuristics that
describe the present — they are not predictions, and they have no backtest
yet; treat verdicts as structured observation, not signals to trade.</p>`,
  },
];
