/* Market Lens documentation content. One section = one nav entry = one
   search unit. Bodies are trusted static HTML authored here (rendered via
   dangerouslySetInnerHTML — never put user input in them); the search
   index strips tags at load. */

export interface DocSection {
  id: string;
  title: string;
  body: string;
}

export const DOCS: DocSection[] = [
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
browser is connected; it reconnects automatically after server restarts,
and a connection that goes silent for 10&nbsp;seconds is torn down and
rebuilt (the "stale" state) rather than left frozen.</p>
<p>Data flows in from public venue feeds with no keys or accounts; while the
server runs it also records depth snapshots and big trades to
<code>data_recorded/lens.db</code> (see Recording).</p>
<p>The UI is a prebuilt React app served from <code>app/dist</code>; the
server needs no Node. To work on the UI: <code>cd app &amp;&amp; npm install
&amp;&amp; npm run build</code> (or <code>npm run dev</code> for hot reload,
proxied to the collector).</p>`,
  },
  {
    id: "symbols-routing",
    title: "Symbols, routing & URLs",
    body: `
<p>51 symbols in four groups — <b>crypto</b>, <b>stocks</b>, <b>indices</b>
and <b>commodities</b>. Open the picker in the header (or press <b>/</b>)
and search by ticker or company name: "nvidia", "hynix", "micro" all
find their symbol. Arrow keys and enter select; every row is a real link,
so middle-click still opens a tab. Six pills stay in the header for the
everyday watchlist, and keys <b>1–9</b> jump to the first nine.</p>
<p><b>Where the stocks come from.</b> Hyperliquid's builder dexes (HIP-3)
list perps on real-world assets, namespaced <code>dex:SYMBOL</code> —
<code>xyz:NVDA</code> is a perp on Nvidia, traded on-chain. Of the ten
deployed dexes only <code>xyz</code> has real flow ($2.1B/24h against
literally $0 on several others, measured 2026-08-26), so every equity,
index and commodity here comes from it. Tickers you might expect but
will not find — NFLX, GME, ARM, ASML, VIX, DXY — trade under $1.5M/day
there and were left out on purpose: an empty book is worse than a
missing symbol. Worth knowing that the flow is not US-centric: SK Hynix
and SanDisk both out-trade NVDA on this venue.</p>
<p><b>Core vs extended.</b> The six original crypto symbols are
<i>core</i>: every venue's book, the deep Binance poll, a continuously
maintained heat ring, and depth archiving. The other 45 are
Hyperliquid-only and do their book work while you are watching them.
That split is what let the symbol count grow eightfold without the
collector's idle cost following it — and why the 24h change on a stock
comes from Hyperliquid's own mark, not from Binance.</p>
<p>Every view has a URL: <code>/BTC/1m</code>, <code>/NVDA/15m</code>… —
bookmarkable, shareable, and browser back/forward work. Adding a symbol is a
one-line change in <code>market_lens/config.py</code> (venue names, price
bin, big-trade threshold) plus its mirror in <code>app/src/lib/config.ts</code>;
a test parses the TypeScript and fails if the two ever disagree.</p>`,
  },
  {
    id: "charting",
    title: "Chart & timeframes",
    body: `
<p>Candles come from Binance (Hyperliquid for HYPE), 500 bars, refreshed
every 15 seconds so the forming candle stays honest — every 2.5 seconds on
the <b>1s</b> view. Timeframes: 1s, 1m, 5m, 15m, 1h, 4h, 1d — buttons in
the header or <b>[</b> / <b>]</b> keys. Seconds are Binance-only, so
HL-only symbols (HYPE) disable the 1s button. A countdown in the chart's
top-right corner shows how long the open candle has left, turning gold in
its final ten seconds; boundaries are epoch-aligned (the daily closes at
00:00 UTC), so it is arithmetic, not a guess.</p>
<p>Chart styles: candles, Heikin-Ashi, bars, line, area — the picker sits
next to the timeframes. Charting is TradingView's open-source Lightweight
Charts library (Apache-2.0, bundled from npm — no CDN dependency).</p>`,
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
<p>The side panel carries a DOM-style <b>orderbook ladder</b>: asks
stacked above, bids below, each row showing level size, cumulative size,
and price, with a depth bar scaled by cumulative share; the middle row is
the last trade price (colored by aggressor) and the aggregated spread.
The <b>grp selector is the price-compression control</b> — books are
summed per price bin (per-symbol base, e.g. $10 BTC / $0.05 SOL), and grp
multiplies that bin from ×0.2 (exchange tick size) to ×10, re-binned
server-side per client and remembered per symbol. Fine grouping shows the
book's true texture; coarse grouping shows the big shelves.</p>
<p>Notional (price × size) is the unit
everywhere, so venues and symbols are directly comparable. Binance
contributes a 1000-level book via REST polling (~5s refresh — depth beyond
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
in <code>data_recorded/lens.db</code> persists regardless).</p>`,
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
get a printed label.</p>
<p><b>Sound</b> (footer toggle): the tape plays, aggr.trade-style —
every above-threshold trade rings a pentatonic note (never dissonant, even
overlapping): buys chime a sine an octave above sells' triangle, and bigger
prints sit <i>lower</i>, ring longer, and play louder, so you can read the
flow's size and side with your eyes elsewhere. Forced liquidations wail: a
sawtooth glide, downward when longs die, upward when shorts do.
Rate-limited to 8 sounds/s; silent in hidden tabs.</p>
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
    id: "liquidations",
    title: "Liquidations: real prints & the estimated map",
    body: `
<p>Two layers, honestly separated. <b>Liq prints (facts)</b>: every real
forced liquidation from Binance's public <code>forceOrder</code> stream
draws as a violet <b>×</b> at its fill price — magenta when a <i>long</i>
died, blue-violet when a <i>short</i> did; monsters (≥$250K) get a label,
and the footer shows rolling 1h totals; they also appear inline in the
Big Trades column as violet ✕ rows, and — with sound on — as directional
wails. Every print is archived to
<code>lens.db</code> — this history has no free source and cannot be
backfilled, so the archive is the moat. (HL-only symbols like HYPE have no
Binance stream and show none.)</p>
<p><b>Liq map (estimate)</b>: faint full-width violet bands marking where
current leveraged positions <i>would</i> die. Method, assumptions in the
open: when open interest rises while price trades at P, new inventory of
that notional was opened near P; long/short attribution follows the taker
flow; liquidation levels project at the standard tiers (5×/10×/25×/50×/
100× with an assumed mix — no venue publishes the real distribution);
bands are <i>consumed</i> when price trades through them and decay with a
24h half-life. Nobody can see actual positions — every liquidation
heatmap anywhere is this same estimate wearing different clothes. The map
is binned <i>coarser</i> than the order book (×10 the depth bin) on
purpose: projecting an assumed leverage mix onto book-fine bins would
dress an estimate up as a measurement.</p>
<p><b>It survives restarts.</b> Every open-interest observation is
archived, and on startup the collector replays the last 48h back through
the estimator — so a deploy no longer blanks the map. Replay rather than
snapshot: the estimator is a pure function of its observations, so the
rebuilt map is the same map, including the bands price traded through
while the process was down.</p>
<p>Why it matters: liquidation clusters are <b>fuel on the track</b> —
forced orders are price-insensitive flow, so price reaching a dense band
tends to accelerate through it (the cascade), and it is a documented
market habit that price gets drawn toward dense pools. Whether that is
deliberate hunting or emergent physics, the map shows where the fuel
sits, and the real prints grade the estimate over time.</p>`,
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
<p>Nine venue books stream in — five spot: <b>Binance</b> (REST
1000-level book + aggTrade), <b>Bybit</b> (200-level delta), <b>OKX</b>
(400-level delta), <b>Coinbase</b> (full level2), <b>Kraken</b> (500-level)
— and four perp: <b>Hyperliquid</b>, <b>binance-fut</b> (fapi 1000-level
REST + aggTrade), <b>bybit-fut</b> and <b>okx-fut</b> (same protocols as
their spot siblings on the linear/swap endpoints). Perps are where the
leveraged flow lives — their tapes typically dominate — and each is its
own venue in the filter, so spot and perp books can be compared directly.
Each adapter is failure-isolated. Coinbase and Kraken are USD-quoted
(their real liquidity); they join the USDT-quoted aggregate with the ~2bp
peg smear every cross-venue aggregator accepts. BNB trades on neither
(Binance's own token); HYPE remains HL-only.</p>
<p>Footer checkboxes include/exclude venues from <i>your</i> view, and the
filter now reaches nearly everything: the aggregated book, walls and
attribution; the <b>volume profile</b> and the <b>VWAP</b> drawn from it;
<b>CVD</b>; the <b>tape-pressure</b> gauge; and the <b>tape signal and
combined verdict</b>, so unticking a venue changes the read rather than
just the picture. Client-side it also filters the tape list, the chart
trade dashes and the trade sounds. Liquidation prints carry venue
binance-fut and filter with it.</p>
<p><b>The heatmap is the one exception</b>, and deliberately: it is a ring
of already-aggregated book columns, and keeping a separate ring per venue
would cost roughly a quarter of a gigabyte for the multi-venue symbols
alone. It stays all-venue — so with a filter active, the live book layers
narrow while the heatmap behind them still shows everyone. Historical CVD
carries the same small caveat in the other direction: rows archived
before venue attribution existed (before 2026-08-26) count in an
unfiltered total but cannot appear in a filtered one, because we genuinely
do not know which venue they came from.</p>
<p>Books are binned per symbol and summed in USD notional. Still on the
candidate list: dYdX v4 — see <code>docs/venue-feeds.md</code>.</p>`,
  },
  {
    id: "recording",
    title: "Recording (the archive)",
    body: `
<p>While running, the server records to a SQLite database at
<code>data_recorded/lens.db</code>: binned depth snapshots every 30s per
symbol, and every big trade. This history has <b>no free source
anywhere</b> — order-book history is only owned by whoever recorded it,
which is why the collector should eventually live on an always-on server.
The recorded trades power the chart's history seeding (an indexed query,
constant-time however large the archive grows); the depth table will power
the persistent (multi-day) heatmap.</p>
<p>Two further tables exist so that <b>derived state survives a
restart</b> — before them, the liquidation map, the CVD series and the
volume profile were memory-only and every deploy blanked them.
<code>oi_observations</code> keeps the liq map's raw inputs, and
<code>flow_minutes</code> keeps per-minute executed flow binned by price,
which folds back into both the CVD and the profile. The full trade stream
is far too large to archive; its minute aggregate is not.</p>
<p>Retention now runs on its own loop rather than waiting to be called,
with a policy set <i>per table</i>: depth snapshots (the bulk of the file)
age out at 14 days, trades and the derived tables at 90 — and forced
liquidation prints are <b>never</b> pruned, because no venue sells that
history back. Measured growth is roughly 20&nbsp;MB/day across all
symbols. Upgrading from the CSV era: run
<code>python scripts/import_csv_archive.py</code> once.</p>`,
  },
  {
    id: "shortcuts",
    title: "Shortcuts, preferences, export",
    body: `
<p><b>Keyboard</b>: 1–6 symbols · [ and ] timeframe down/up · h heatmap ·
p volume profile.</p>
<p><b>Preferences</b> (toggles, threshold slider, chart style, alert)
persist in the browser across reloads. <b>PNG</b> button exports the
current chart with all overlays baked in, named
<code>lens-SYMBOL-TF.png</code>.</p>`,
  },
  {
    id: "architecture",
    title: "Architecture & extending",
    body: `
<p>One Python process (aiohttp + websockets): venue adapter tasks →
normalized book/trade callbacks → accumulators (CVD, profile, pressure,
heat ring) → a 400ms broadcast loop that aggregates, scores the readers,
and pushes JSON over one WebSocket per browser.</p>
<p>The frontend (<code>app/</code>) is React + TypeScript built with Vite:
a Zustand store is the single client-state authority, the connection layer
(<code>lib/socket.ts</code>) owns reconnect/backoff/staleness, and the
chart surface renders once — live updates flow through transient store
subscriptions into Lightweight Charts and a requestAnimationFrame overlay
loop, so a burst of messages costs one draw on the next frame instead of a
redraw per message. The build outputs static files the Python server
serves; production needs no Node.</p>
<p>To add a <b>symbol</b>: one line in <code>config.py</code> (+ its mirror
in <code>app/src/lib/config.ts</code>). To add a <b>venue</b>: one adapter
function in <code>venues.py</code> emitting the normalized callbacks (the
DeltaBook helper handles snapshot+delta books). Aggregation, signals and
storage live in pure, unit-tested modules (<code>aggregate.py</code>,
<code>signals.py</code>, <code>store.py</code>); the client's pure math
(Heikin-Ashi, MAs, socket backoff) is unit-tested with Vitest.</p>`,
  },
  {
    id: "limitations",
    title: "Limitations — read this one",
    body: `
<p>Honest edges of the tool: <b>(1)</b> the heatmap ring resets on server
restart (refills within the hour; disk record persists). <b>(2)</b> Binance
depth is ~5s stale by design — occasionally the aggregate book crosses
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
