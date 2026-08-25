/* Market Lens frontend — the rich-tool sprint.
   Panels: candles + CVD line (left scale) on the chart; one overlay canvas
   drawing three layers — liquidity heatmap (time × price, resting claims),
   volume profile (left, executed facts), live depth bars (right, resting
   claims); gauges for book imbalance and 5-minute tape pressure; top-walls
   table; big-trade tape with threshold slider; per-venue toggles.
   Still deliberately frameworkless — one vendored chart library + this file. */

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "HYPE"];
const TIMEFRAMES = ["1s", "1m", "5m", "15m", "1h", "4h", "1d"];
const NO_SECONDS = ["HYPE"];   // Hyperliquid candles start at 1m
const BASE_THRESHOLDS = { BTC: 100000, ETH: 50000, SOL: 25000, BNB: 25000,
                          DOGE: 25000, HYPE: 10000 };
const MAX_TAPE_ROWS = 120;
const MAX_TRADES = 600;   // in-memory big-trade store (history + live)

const state = {
  symbol: "BTC", timeframe: "1m", chartStyle: "candles",
  ws: null, depth: null, heat: [], metrics: {},
  trades: [],               // {ts, price, notional, side, venue} — drives
  thresholdMult: 0.5,       // both the tape list and the chart dashes
  venues: [], activeVenues: null,   // null = all
  candleRows: [],           // last loaded OHLC rows (feeds style + MAs)
  showHeat: true, showProfile: true, showWalls: true,
  showTrades: true, showDepth: true, showVwap: true,
};

/* ---------------------------------------------------------------- chart */
const chartEl = document.getElementById("chart");
const chart = LightweightCharts.createChart(chartEl, {
  // Transparent background: the under-overlay canvas (claims layers) shows
  // through BENEATH candles; .chart-wrap provides the actual page color.
  layout: { background: { type: "solid", color: "transparent" }, textColor: "#979083" },
  grid: { vertLines: { color: "#232120" }, horzLines: { color: "#232120" } },
  rightPriceScale: { borderColor: "#35322c" },
  // Hidden: CVD is a divergence shape, not a level — its raw dollar scale
  // was crowding the axis with 7-digit near-identical labels.
  leftPriceScale: { visible: false },
  timeScale: { borderColor: "#35322c", timeVisible: true, secondsVisible: false },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  autoSize: true,
});
/* Price series is swappable (chart style picker). All overlays reference
   `candles` for coordinate mapping; setChartStyle reassigns it in place. */
const SERIES_COLORS = { up: "#3fa36c", down: "#c4564a", line: "#7fae93" };

function makePriceSeries(style) {
  if (style === "bars") {
    return chart.addBarSeries({ upColor: SERIES_COLORS.up, downColor: SERIES_COLORS.down });
  }
  if (style === "line") {
    return chart.addLineSeries({ color: SERIES_COLORS.line, lineWidth: 2 });
  }
  if (style === "area") {
    return chart.addAreaSeries({
      lineColor: SERIES_COLORS.line, lineWidth: 2,
      topColor: "rgba(127,174,147,0.25)", bottomColor: "rgba(127,174,147,0.02)",
    });
  }
  return chart.addCandlestickSeries({   // candles + heikin share the type
    upColor: SERIES_COLORS.up, downColor: SERIES_COLORS.down,
    wickUpColor: SERIES_COLORS.up, wickDownColor: SERIES_COLORS.down,
    borderVisible: false,
  });
}

function toHeikinAshi(rows) {
  const out = [];
  let prevOpen = null, prevClose = null;
  for (const row of rows) {
    const close = (row.open + row.high + row.low + row.close) / 4;
    const open = prevOpen === null ? (row.open + row.close) / 2
                                   : (prevOpen + prevClose) / 2;
    out.push({ time: row.time, open,
               high: Math.max(row.high, open, close),
               low: Math.min(row.low, open, close), close });
    prevOpen = open; prevClose = close;
  }
  return out;
}

function styledRows(rows, style) {
  if (style === "heikin") return toHeikinAshi(rows);
  if (style === "line" || style === "area") {
    return rows.map((r) => ({ time: r.time, value: r.close }));
  }
  return rows;
}

let candles = makePriceSeries("candles");

function setChartStyle(style) {
  state.chartStyle = style;
  const wasVisible = document.getElementById("candles-toggle").checked;
  chart.removeSeries(candles);          // price lines on it die with it…
  vwapLine = null;
  priceLines.length = 0;
  candles = makePriceSeries(style);
  candles.applyOptions({ visible: wasVisible });
  candles.setData(styledRows(state.candleRows, style));
  loadDayLevels();                      // …so re-anchor them to the new one
  document.getElementById("chart-style").value = style;
}
const cvdSeries = chart.addLineSeries({
  priceScaleId: "left", color: "#c9a35a", lineWidth: 1,
  priceLineVisible: false, lastValueVisible: false, title: "CVD",
});

/* ------------------------------------------------------- overlay canvases
   Two layers: `under` (claims — heat, profile, order lines, depth) paints
   beneath the transparent chart; `overlay` (facts — trade dashes, labels)
   paints above the candles. */
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const under = document.getElementById("under-overlay");
const uctx = under.getContext("2d");

function sizeCanvas(canvas, context) {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * devicePixelRatio;
  canvas.height = rect.height * devicePixelRatio;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  return rect;
}

function draw() {
  const rect = sizeCanvas(under, uctx);
  sizeCanvas(overlay, ctx);
  drawHeat(rect);
  drawWallLines(rect);
  drawProfile(rect);
  drawDepth(rect);
  drawBubbles(rect);
}
setInterval(draw, 300);

function wallStartTime(price, bin) {
  /* Walk the heat ring backwards from now: the wall's line starts where the
     level first shows continuous presence. Returns null with no history. */
  let start = null;
  for (let i = state.heat.length - 1; i >= 0; i--) {
    const [when, bids, asks] = state.heat[i];
    const present = [...bids, ...asks].some(([p]) => Math.abs(p - price) <= bin);
    if (!present) break;
    start = when;
  }
  return start;
}

function drawWallLines(rect) {
  /* The current top resting walls as bright horizontal ORDER LINES running
     from where the ring first saw them to the right edge — the reference
     look: persistent liquidity as lines you cannot miss. Claims layer, but
     the brightest claims: these are the levels price negotiates with. */
  state._drawnWalls = 0;
  if (!state.showWalls || !state.depth?.walls) return;
  const bin = state.depth.bin || 1;
  const timeScale = chart.timeScale();
  const all = [
    ...(state.depth.walls.bids || []).map((w) => ({ ...toWall(w), side: "bid" })),
    ...(state.depth.walls.asks || []).map((w) => ({ ...toWall(w), side: "ask" })),
  ];
  const maxUsd = Math.max(...all.map((w) => w.usd), 1);
  for (const wall of all) {
    const y = candles.priceToCoordinate(wall.price);
    if (y === null || y < 0 || y > rect.height) continue;
    const start = wallStartTime(wall.price, bin);
    let x1 = start !== null ? timeScale.timeToCoordinate(start) : null;
    if (x1 === null) x1 = Math.max(0, rect.width * 0.55); // no history: short stub
    const thickness = Math.max(1.5, Math.sqrt(wall.usd / maxUsd) * 4.5);
    const rgb = wall.side === "bid" ? "63,163,108" : "196,86,74";
    uctx.fillStyle = `rgba(${rgb},0.55)`;                // line: under candles
    uctx.fillRect(x1, y - thickness / 2, rect.width - x1, thickness);
    ctx.font = "10px sans-serif";                        // label: above them
    ctx.fillStyle = `rgba(${rgb},0.95)`;
    ctx.fillText("$" + formatUsd(wall.usd), Math.max(x1 + 4, rect.width - 235), y - 4);
    state._drawnWalls++;
  }
}

function toWall(row) {
  return { price: row[0], usd: row[1] };
}

const TF_SECONDS = { "1s": 1, "1m": 60, "5m": 300, "15m": 900,
                     "1h": 3600, "4h": 14400, "1d": 86400 };

function drawBubbles(rect) {
  /* Executed big trades as short BRIGHT horizontal dashes at their actual
     fill price — thickness and length grow with magnitude. Deliberately the
     opposite visual class from the heat lines: long+faint = resting claims,
     short+bright = executed facts. Labels only for monsters (≥5×). */
  state._drawnTrades = 0;
  if (!state.showTrades) return;
  const threshold = currentThreshold();
  const bucket = TF_SECONDS[state.timeframe];
  const timeScale = chart.timeScale();
  let drawn = 0;
  for (const trade of state.trades) {
    if (trade.notional < threshold) continue;
    const snapped = Math.floor(trade.ts / 1000 / bucket) * bucket;
    const x1 = timeScale.timeToCoordinate(snapped);
    const y = candles.priceToCoordinate(trade.price);
    if (x1 === null || y === null || y < 0 || y > rect.height) continue;
    const magnitude = trade.notional / threshold;
    const length = Math.min(90, 10 + Math.sqrt(magnitude) * 16);
    const thickness = Math.min(5, 1 + Math.sqrt(magnitude) * 1.2);
    const alpha = Math.min(0.9, 0.45 + Math.sqrt(magnitude) * 0.25);
    const rgb = trade.side === "buy" ? "63,163,108" : "196,86,74";
    ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(2)})`;
    ctx.fillRect(x1, y - thickness / 2, length, thickness);
    if (magnitude >= 5) {
      ctx.font = "10px sans-serif";
      ctx.fillText("$" + formatUsd(trade.notional), x1 + length + 4, y + 3);
    }
    drawn++;
  }
  state._drawnTrades = drawn; // debug/verification hook
}

function drawHeat(rect) {
  /* Liquidity through time in LINE style (the reference Arash liked):
     each price level draws as a thin 1px streak spanning column-to-column,
     so persistent walls read as long faint horizontal lines and pulled
     walls simply end. Resting CLAIMS layer — deliberately faint. */
  if (!state.showHeat || state.heat.length === 0) return;
  const ts = chart.timeScale();
  for (let i = 0; i < state.heat.length; i++) {
    const [when, bids, asks] = state.heat[i];
    const x1 = ts.timeToCoordinate(when);
    if (x1 === null) continue;
    const nextWhen = i + 1 < state.heat.length ? state.heat[i + 1][0] : null;
    const x2raw = nextWhen !== null ? ts.timeToCoordinate(nextWhen) : null;
    const x2 = x2raw !== null ? x2raw : Math.min(rect.width, x1 + 8);
    const colMax = Math.max(...bids.map(b => b[1]), ...asks.map(a => a[1]), 1);
    for (const [levels, rgb] of [[bids, "63,163,108"], [asks, "196,86,74"]]) {
      for (const [price, usd] of levels) {
        const y = candles.priceToCoordinate(price);
        if (y === null || y < 0 || y > rect.height) continue;
        const alpha = Math.min(0.4, Math.sqrt(usd / colMax) * 0.4);
        uctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
        uctx.fillRect(x1, y, Math.max(1, x2 - x1), 1);
      }
    }
  }
}

function drawProfile(rect) {
  /* Executed volume by price along the left edge — the FACTS layer.
     Green segment = aggressive buys, red = sells, at each price bin. */
  if (!state.showProfile || !state.depth || !state.depth.profile) return;
  const rows = state.depth.profile;
  const maxTotal = Math.max(...rows.map(([, b, s]) => b + s), 1);
  for (const [price, buyUsd, sellUsd] of rows) {
    const y = candles.priceToCoordinate(price);
    if (y === null || y < 0 || y > rect.height) continue;
    const total = buyUsd + sellUsd;
    const width = Math.sqrt(total / maxTotal) * 110;
    const buyWidth = total ? width * (buyUsd / total) : 0;
    uctx.fillStyle = "rgba(63,163,108,0.55)";
    uctx.fillRect(0, y - 2, buyWidth, 4);
    uctx.fillStyle = "rgba(196,86,74,0.55)";
    uctx.fillRect(buyWidth, y - 2, width - buyWidth, 4);
  }
}

function drawDepth(rect) {
  /* Current aggregated book as right-edge bars (resting claims, live). */
  if (!state.showDepth || !state.depth) return;
  const levels = [
    ...state.depth.bids.map(([p, v]) => ({ price: p, usd: v, side: "bid" })),
    ...state.depth.asks.map(([p, v]) => ({ price: p, usd: v, side: "ask" })),
  ];
  const maxUsd = Math.max(...levels.map(l => l.usd), 1);
  for (const level of levels) {
    const y = candles.priceToCoordinate(level.price);
    if (y === null || y < 0 || y > rect.height) continue;
    const width = Math.max(2, Math.sqrt(level.usd / maxUsd) * 175);
    uctx.fillStyle = level.side === "bid"
      ? "rgba(63,163,108,0.45)" : "rgba(196,86,74,0.45)";
    uctx.fillRect(rect.width - width, y - 1.5, width, 3);
  }
}

/* ------------------------------------------------------- gauges + panels */
function formatUsd(value) {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(0) + "K";
  return value.toFixed(0);
}

function renderGauges() {
  const depth = state.depth;
  if (!depth) return;
  const imbalanceEl = document.getElementById("imbalance");
  if (depth.imbalance !== null && depth.imbalance !== undefined) {
    const pct = (depth.imbalance * 100).toFixed(0);
    imbalanceEl.innerHTML = `book: <b class="${depth.imbalance >= 0.5 ? "buy-c" : "sell-c"}">${pct}% bid</b>`;
  }
  const p = depth.pressure || { buy: 0, sell: 0 };
  document.getElementById("pressure").innerHTML =
    `tape 5m: <b class="buy-c">$${formatUsd(p.buy)}▲</b> / <b class="sell-c">$${formatUsd(p.sell)}▼</b>`;

  const mid = depth.mid;
  const rows = [];
  for (const [side, cls] of [["asks", "sell-c"], ["bids", "buy-c"]]) {
    for (const [price, usd, byVenue] of (depth.walls?.[side] || [])) {
      const dist = mid ? ((price / mid - 1) * 100).toFixed(2) : "?";
      const attribution = Object.entries(byVenue || {})
        .sort((a, b) => b[1] - a[1])
        .map(([venue, v]) => `${venue} $${formatUsd(v)}`).join(" · ");
      rows.push({ side, cls, price, usd, dist, attribution }); }
  }
  rows.sort((a, b) => b.price - a.price);
  document.querySelector("#walls tbody").innerHTML = rows.map(r =>
    `<tr title="${r.attribution}"><td class="${r.cls}">${r.side === "bids" ? "BID" : "ASK"}</td>` +
    `<td>${r.price.toLocaleString()}</td><td>$${formatUsd(r.usd)}</td>` +
    `<td class="muted">${r.dist}%</td></tr>`).join("");

  renderVenueToggles(depth.venues || []);
}

function renderVenueToggles(venues) {
  const host = document.getElementById("venue-toggles");
  if (host.dataset.venues === venues.join(",")) return;
  host.dataset.venues = venues.join(",");
  host.innerHTML = venues.map(v =>
    `<label class="muted toggle"><input type="checkbox" data-venue="${v}" checked> ${v}</label>`
  ).join("");
  host.querySelectorAll("input").forEach(box => box.onchange = () => {
    const active = [...host.querySelectorAll("input:checked")].map(b => b.dataset.venue);
    state.activeVenues = active.length === venues.length ? null : active;
    subscribe();
  });
}

function renderMetrics() {
  const host = document.getElementById("metrics");
  const parts = [];
  const m = state.metrics[state.symbol] || {};
  if (m.funding !== undefined) {
    const next = m.nextFunding ? Math.max(0, m.nextFunding - Date.now()) : null;
    const countdown = next === null ? "" :
      ` (in ${Math.floor(next / 3600000)}h${String(Math.floor(next / 60000) % 60).padStart(2, "0")}m)`;
    parts.push(`funding <b class="${m.funding >= 0 ? "buy-c" : "sell-c"}">${(m.funding * 100).toFixed(4)}%</b>${countdown}`);
  }
  if (m.oiUsd) parts.push(`OI <b>$${formatUsd(m.oiUsd)}</b> <span class="muted">(HL)</span>`);
  host.innerHTML = `<span class="sym-name">${state.symbol}</span> ` + parts.join(" · ");
  document.querySelectorAll("#symbols button").forEach(button => {
    const change = state.metrics[button.dataset.symbol]?.change24h;
    const tag = button.querySelector("small");
    if (change !== undefined && tag) {
      tag.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
      tag.className = change >= 0 ? "buy-c" : "sell-c";
    }
  });
}

/* ------------------------------------------------------------------ tape */
const tapeList = document.getElementById("tape-list");

function currentThreshold() {
  return BASE_THRESHOLDS[state.symbol] * state.thresholdMult;
}

function onTrade(trade) {
  state.trades.push(trade);
  if (state.trades.length > MAX_TRADES) state.trades.shift();
  if (trade.notional >= currentThreshold() * 5) beep(trade.side);
  renderTape();
}

function renderTape() {
  const threshold = currentThreshold();
  const rows = state.trades.filter((t) => t.notional >= threshold)
    .slice(-MAX_TAPE_ROWS).reverse();
  tapeList.innerHTML = rows.map((trade) => {
    const when = new Date(trade.ts).toISOString().slice(11, 19);
    return `<li class="${trade.side}">` +
      `<span>${trade.side === "buy" ? "▲" : "▼"} $${formatUsd(trade.notional)}</span>` +
      `<span class="px">${trade.price.toLocaleString()} · ${trade.venue} · ${when}</span></li>`;
  }).join("");
}

/* -------------------------------------------------------------- data flow */
async function loadCandles() {
  // Polled on an interval — a transient server/network gap must be silent
  // (the WS status pill already tells the user we're reconnecting).
  try {
    const response = await fetch(
      `/klines?symbol=${state.symbol}&interval=${state.timeframe}&limit=500`);
    const rows = await response.json();
    if (Array.isArray(rows)) {
      state.candleRows = rows;
      candles.setData(styledRows(rows, state.chartStyle));
      computeMAs();
    }
  } catch { /* retry on the next tick */ }
}

/* ------------------------------------------------------- moving averages */
const MA_DEFS = [
  { id: "sma20", label: "S20", type: "sma", length: 20, color: "#7a9ec2" },
  { id: "sma50", label: "S50", type: "sma", length: 50, color: "#c2a97a" },
  { id: "sma200", label: "S200", type: "sma", length: 200, color: "#b07ac2" },
  { id: "ema9", label: "E9", type: "ema", length: 9, color: "#7ac2b4" },
  { id: "ema21", label: "E21", type: "ema", length: 21, color: "#c27a7a" },
  { id: "ema50", label: "E50", type: "ema", length: 50, color: "#9ac27a" },
];
const maSeries = {};
for (const def of MA_DEFS) {
  maSeries[def.id] = chart.addLineSeries({
    color: def.color, lineWidth: 1, visible: false,
    priceLineVisible: false, lastValueVisible: false,
  });
}

function computeMAs() {
  const closes = state.candleRows.map((r) => r.close);
  const times = state.candleRows.map((r) => r.time);
  for (const def of MA_DEFS) {
    const points = [];
    if (def.type === "sma") {
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= def.length) sum -= closes[i - def.length];
        if (i >= def.length - 1) {
          points.push({ time: times[i], value: sum / def.length });
        }
      }
    } else {
      const k = 2 / (def.length + 1);
      let ema = null;
      for (let i = 0; i < closes.length; i++) {
        ema = ema === null ? closes[i] : closes[i] * k + ema * (1 - k);
        if (i >= def.length - 1) points.push({ time: times[i], value: ema });
      }
    }
    maSeries[def.id].setData(points);
  }
}

function subscribe() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      cmd: "subscribe", symbol: state.symbol,
      venues: state.activeVenues || undefined,
    }));
  }
}

function connect() {
  const statusEl = document.getElementById("status");
  state.ws = new WebSocket(`ws://${location.host}/ws`);
  state.ws.onopen = () => {
    statusEl.textContent = "live";
    statusEl.classList.add("live");
    subscribe();
  };
  state.ws.onclose = () => {
    statusEl.textContent = "reconnecting…";
    statusEl.classList.remove("live");
    setTimeout(connect, 3000);
  };
  state.ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "metrics") {
      state.metrics = message.data;
      renderMetrics();
      return;
    }
    if (message.symbol !== state.symbol) return;
    if (message.type === "depth") {
      state.depth = message;
      renderGauges(); renderSignals(); updateVwapLine(); updateSpread();
    }
    else if (message.type === "trade") onTrade(message);
    else if (message.type === "tapeHistory") {
      state.trades = message.trades || [];
      renderTape();
    }
    else if (message.type === "heat") state.heat = message.cols;
    else if (message.type === "heatcol") {
      state.heat.push(message.col);
      if (state.heat.length > 400) state.heat.shift();
    }
    else if (message.type === "cvd") cvdSeries.setData(
      message.points.map(([t, v]) => ({ time: t, value: v })));
  };
}

/* ---------------------------------------------------------------- routing
   History-API routes without a framework: /SYMBOL/TIMEFRAME (both segments
   optional). Symbol pills and timeframe buttons push state; back/forward
   and pasted deep links restore it. */
function parseRoute() {
  const [symbol, timeframe] = location.pathname.split("/").filter(Boolean);
  return {
    symbol: SYMBOLS.includes(symbol) ? symbol : "BTC",
    timeframe: TIMEFRAMES.includes(timeframe) ? timeframe : "1m",
  };
}

function pushRoute(replace = false) {
  const path = `/${state.symbol}/${state.timeframe}`;
  if (location.pathname !== path) {
    history[replace ? "replaceState" : "pushState"](null, "", path);
  }
  document.title = `${state.symbol} ${state.timeframe} — Market Lens`;
}

window.addEventListener("popstate", () => {
  const route = parseRoute();
  if (route.timeframe !== state.timeframe) setTimeframe(route.timeframe, false);
  if (route.symbol !== state.symbol) setSymbol(route.symbol, false);
});

function setSymbol(symbol, updateUrl = true) {
  state.symbol = symbol;
  if (state.timeframe === "1s" && NO_SECONDS.includes(symbol)) {
    setTimeframe("1m", false);
  }
  document.querySelectorAll("#timeframes button").forEach((b) => {
    b.disabled = b.textContent === "1s" && NO_SECONDS.includes(symbol);
  });
  state.depth = null; state.heat = []; state.trades = [];
  state.activeVenues = null;
  cvdSeries.setData([]);
  tapeList.innerHTML = "";
  document.getElementById("venue-toggles").dataset.venues = "";
  document.querySelectorAll("#symbols button").forEach(
    (b) => b.classList.toggle("active", b.dataset.symbol === symbol));
  document.getElementById("threshold-label").textContent =
    formatUsd(currentThreshold());
  loadCandles();
  loadDayLevels();
  if (vwapLine !== null) { candles.removePriceLine(vwapLine); vwapLine = null; }
  subscribe();
  renderMetrics();
  if (updateUrl) pushRoute();
  chart.timeScale().scrollToRealTime();
}

let candlePoll = null;
function scheduleCandlePoll() {
  // 1s charts go stale in seconds; slower timeframes don't need the churn.
  clearInterval(candlePoll);
  candlePoll = setInterval(loadCandles, state.timeframe === "1s" ? 2500 : 15000);
}

function setTimeframe(timeframe, updateUrl = true) {
  if (timeframe === "1s" && NO_SECONDS.includes(state.symbol)) timeframe = "1m";
  state.timeframe = timeframe;   // trade dashes re-snap at draw time
  document.querySelectorAll("#timeframes button").forEach((b) => {
    b.classList.toggle("active", b.textContent === timeframe);
    b.disabled = b.textContent === "1s" && NO_SECONDS.includes(state.symbol);
  });
  loadCandles();
  scheduleCandlePoll();
  if (updateUrl) pushRoute();
}

/* ------------------------------------------------------------------- init */
const nav = document.getElementById("symbols");
for (const symbol of SYMBOLS) {
  const button = document.createElement("button");
  button.dataset.symbol = symbol;
  button.innerHTML = `${symbol} <small class="muted"></small>`;
  button.onclick = () => setSymbol(symbol);
  nav.appendChild(button);
}
const tfNav = document.getElementById("timeframes");
for (const timeframe of TIMEFRAMES) {
  const button = document.createElement("button");
  button.textContent = timeframe;
  button.onclick = () => setTimeframe(timeframe);
  tfNav.appendChild(button);
}
document.getElementById("threshold").oninput = (event) => {
  state.thresholdMult = parseFloat(event.target.value);
  document.getElementById("threshold-label").textContent =
    formatUsd(currentThreshold());
  renderTape();   // slider re-filters both the tape and (via draw) bubbles
};
/* Layer toggles: overlays via state flags, chart series via visibility. */
const LAYER_BINDINGS = {
  "heat-toggle": (on) => (state.showHeat = on),
  "profile-toggle": (on) => (state.showProfile = on),
  "walls-toggle": (on) => (state.showWalls = on),
  "trades-toggle": (on) => (state.showTrades = on),
  "depth-toggle": (on) => (state.showDepth = on),
  "candles-toggle": (on) => candles.applyOptions({ visible: on }),
  "cvd-toggle": (on) => cvdSeries.applyOptions({ visible: on }),
  "vwap-toggle": (on) => { state.showVwap = on; updateVwapLine(); },
};
for (const [id, apply] of Object.entries(LAYER_BINDINGS)) {
  document.getElementById(id).onchange = (e) => apply(e.target.checked);
}

// Moving averages: one toggle per definition, swatch-colored.
const maHost = document.getElementById("ma-toggles");
for (const def of MA_DEFS) {
  const label = document.createElement("label");
  label.className = "muted toggle";
  label.innerHTML = `<input type="checkbox" id="ma-${def.id}">` +
    `<span class="swatch" style="background:${def.color}"></span>${def.label}`;
  maHost.appendChild(label);
  label.querySelector("input").onchange = (e) => {
    maSeries[def.id].applyOptions({ visible: e.target.checked });
    savePrefs();
  };
}

document.getElementById("chart-style").onchange = (e) => {
  setChartStyle(e.target.value);
  savePrefs();
};

/* ------------------------------------------------- readers (signal strip) */
function renderSignals() {
  const signals = state.depth?.signals;
  if (!signals) return;
  const bar = (score) => {
    const width = Math.min(45, Math.abs(score) / 100 * 45);
    const color = score >= 0 ? "var(--bid)" : "var(--ask)";
    const side = score >= 0 ? "left:50%" : `left:${50 - width}%`;
    return `<span class="bar"><i style="${side};width:${width}%;background:${color}"></i></span>`;
  };
  const cell = (name, s) =>
    `<span class="signal" title="${Object.entries(s.parts || {})
      .map(([k, v]) => `${k}: ${v}`).join(" · ")}">
      <span class="name">${name}</span>${bar(s.score)}
      <span class="val ${s.score >= 0 ? "buy-c" : "sell-c"}">${s.score > 0 ? "+" : ""}${s.score}</span>
    </span>`;
  const combined = signals.combined;
  document.getElementById("signals").innerHTML =
    cell("tape", signals.tape) + cell("book", signals.book) +
    cell("both", combined) +
    `<span class="verdict ${combined.verdict.includes("absorption") ? "warn" : ""}">${combined.verdict}</span>`;
}

/* ------------------------------------------------- crosshair price readout */
chart.subscribeCrosshairMove((param) => {
  const el = document.getElementById("readout");
  if (!param.point || !state.depth) return;
  const price = candles.coordinateToPrice(param.point.y);
  if (price === null) return;
  const bin = state.depth.bin || 1;
  const snapped = Math.floor(price / bin) * bin;
  const find = (rows) => (rows || []).find(([p]) => Math.abs(p - snapped) < bin / 2);
  const bid = find(state.depth.bids);
  const ask = find(state.depth.asks);
  const traded = (state.depth.profile || []).find(([p]) => Math.abs(p - snapped) < bin / 2);
  const parts = [`<b>@ ${snapped.toLocaleString()}</b>`];
  if (bid) parts.push(`resting <b class="buy-c">$${formatUsd(bid[1])} bid</b>`);
  if (ask) parts.push(`resting <b class="sell-c">$${formatUsd(ask[1])} ask</b>`);
  if (!bid && !ask) parts.push(`<span class="muted">no resting size</span>`);
  if (traded) {
    const [, buyUsd, sellUsd] = traded;
    const share = Math.round(100 * buyUsd / Math.max(buyUsd + sellUsd, 1));
    parts.push(`traded <b>$${formatUsd(buyUsd + sellUsd)}</b> (${share}% buy)`);
  }
  el.innerHTML = parts.join(" · ");
});

/* ----------------------------------------------- day levels + VWAP lines */
const priceLines = [];
let vwapLine = null;

let dayLevelsToken = 0;
async function loadDayLevels() {
  const token = ++dayLevelsToken;   // concurrent calls: only the latest wins
  priceLines.splice(0).forEach((line) => {
    try { candles.removePriceLine(line); } catch { /* series was swapped */ }
  });
  if (!document.getElementById("levels-toggle").checked) return;
  try {
    const rows = await (await fetch(`/klines?symbol=${state.symbol}&interval=1d&limit=2`)).json();
    if (token !== dayLevelsToken) return;
    if (!Array.isArray(rows) || rows.length < 2) return;
    const [prev, today] = rows.slice(-2);
    for (const [title, value, color] of [
      ["PDH", prev.high, "#8a8377"], ["PDL", prev.low, "#8a8377"],
      ["PDC", prev.close, "#6d675e"], ["O", today.open, "#7fae93"],
    ]) {
      priceLines.push(candles.createPriceLine({
        price: value, color, lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.SparseDotted,
        axisLabelVisible: true, title,
      }));
    }
  } catch { /* levels are decoration; fail quiet */ }
}

function updateVwapLine() {
  const vwap = state.depth?.vwap;
  if (!state.showVwap) {
    if (vwapLine !== null) { candles.removePriceLine(vwapLine); vwapLine = null; }
    return;
  }
  if (!vwap) return;
  if (vwapLine === null) {
    vwapLine = candles.createPriceLine({
      price: vwap, color: "#c9a35a", lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true, title: "VWAP",
    });
  } else {
    vwapLine.applyOptions({ price: vwap });
  }
}

/* ---------------------------------------------- spread + venue divergence */
function updateSpread() {
  const best = state.depth?.best;
  const mid = state.depth?.mid;
  if (!best || !mid) return;
  const bids = Object.values(best).map(b => b.bid).filter(Boolean);
  const asks = Object.values(best).map(b => b.ask).filter(Boolean);
  if (!bids.length || !asks.length) return;
  const spreadBps = (Math.min(...asks) - Math.max(...bids)) / mid * 10000;
  let divVenue = "", divBps = 0;
  for (const [venue, b] of Object.entries(best)) {
    if (!b.bid || !b.ask) continue;
    const d = ((b.bid + b.ask) / 2 - mid) / mid * 10000;
    if (Math.abs(d) > Math.abs(divBps)) { divBps = d; divVenue = venue; }
  }
  document.getElementById("spread").innerHTML =
    `spread ${spreadBps.toFixed(1)}bp · div ${divVenue} ${divBps >= 0 ? "+" : ""}${divBps.toFixed(1)}bp`;
}

/* ------------------------------------------- monster alert (opt-in sound) */
let audioCtx = null;
function beep(side) {
  if (!document.getElementById("beep-toggle").checked) return;
  audioCtx = audioCtx || new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = side === "buy" ? 880 : 440;
  gain.gain.setValueAtTime(0.06, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.15);
}

/* ------------------------------------------------------ keyboard shortcuts */
document.addEventListener("keydown", (event) => {
  if (event.target.tagName === "INPUT") return;
  const digit = parseInt(event.key, 10);
  if (digit >= 1 && digit <= SYMBOLS.length) return setSymbol(SYMBOLS[digit - 1]);
  const tfIndex = TIMEFRAMES.indexOf(state.timeframe);
  if (event.key === "[" && tfIndex > 0) return setTimeframe(TIMEFRAMES[tfIndex - 1]);
  if (event.key === "]" && tfIndex < TIMEFRAMES.length - 1)
    return setTimeframe(TIMEFRAMES[tfIndex + 1]);
  if (event.key === "h") document.getElementById("heat-toggle").click();
  if (event.key === "p") document.getElementById("profile-toggle").click();
});

/* --------------------------------------------------------------- export */
document.getElementById("export").onclick = () => {
  const shot = chart.takeScreenshot();
  const merged = document.createElement("canvas");
  merged.width = shot.width; merged.height = shot.height;
  const mctx = merged.getContext("2d");
  mctx.drawImage(shot, 0, 0);
  mctx.drawImage(overlay, 0, 0, shot.width, shot.height);
  merged.toBlob((blob) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `lens-${state.symbol}-${state.timeframe}.png`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
};

/* ----------------------------------------------------- persisted settings */
/* Preferences: every toggle/checkbox by id + slider + chart style, saved as
   one flat object and re-applied through the same bindings on load. */
const PREF_CHECKBOX_IDS = [
  ...Object.keys(LAYER_BINDINGS), "levels-toggle", "beep-toggle",
  ...MA_DEFS.map((def) => `ma-${def.id}`),
];

function savePrefs() {
  const prefs = { thresholdMult: state.thresholdMult, chartStyle: state.chartStyle };
  for (const id of PREF_CHECKBOX_IDS) {
    prefs[id] = document.getElementById(id).checked;
  }
  localStorage.setItem("lens-prefs", JSON.stringify(prefs));
}

(function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem("lens-prefs") || "{}");
    for (const id of PREF_CHECKBOX_IDS) {
      if (prefs[id] === undefined) continue;
      const box = document.getElementById(id);
      box.checked = prefs[id];
      if (LAYER_BINDINGS[id]) LAYER_BINDINGS[id](prefs[id]);
      if (id.startsWith("ma-")) {
        maSeries[id.slice(3)].applyOptions({ visible: prefs[id] });
      }
    }
    if (prefs.thresholdMult) {
      state.thresholdMult = prefs.thresholdMult;
      document.getElementById("threshold").value = prefs.thresholdMult;
    }
    if (prefs.chartStyle) setChartStyle(prefs.chartStyle);
  } catch { /* fresh defaults */ }
})();
[...PREF_CHECKBOX_IDS, "threshold"].forEach((id) =>
  document.getElementById(id).addEventListener("change", savePrefs));
document.getElementById("levels-toggle").addEventListener("change", loadDayLevels);

const initialRoute = parseRoute();
setTimeframe(initialRoute.timeframe, false);
setSymbol(initialRoute.symbol, false);
pushRoute(true);   // normalize the URL without adding a history entry
connect();
// Candle polling is owned by scheduleCandlePoll (2.5s on 1s view, else 15s).
setInterval(renderMetrics, 30000); // keeps the funding countdown ticking
