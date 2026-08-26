import { exportChartPng } from "../chart/chartExport";
import { MA_DEFS } from "../lib/config";
import { formatUsd } from "../lib/format";
import { useLensStore, type LayerFlags } from "../store/lens";

const LAYER_TOGGLES: [keyof LayerFlags, string][] = [
  ["candles", "candles"], ["trades", "trades"], ["walls", "order lines"],
  ["heat", "heatmap"], ["profile", "profile"], ["depth", "depth"],
  ["liqs", "liqs"], ["liqmap", "liq map"],
  ["cvd", "CVD"], ["vwap", "VWAP"], ["levels", "day levels"],
];

function Gauges() {
  const depth = useLensStore((s) => s.depth);
  if (!depth) return <span className="gauge muted">book warming up…</span>;

  const imbalancePct = depth.imbalance !== null
    ? (depth.imbalance * 100).toFixed(0) : null;
  const pressure = depth.pressure ?? { buy: 0, sell: 0 };

  // Spread + divergence across venues' best quotes.
  let spread: string | null = null;
  const bids = Object.values(depth.best ?? {}).map((b) => b.bid).filter(Boolean) as number[];
  const asks = Object.values(depth.best ?? {}).map((b) => b.ask).filter(Boolean) as number[];
  if (bids.length && asks.length && depth.mid) {
    const spreadBps = ((Math.min(...asks) - Math.max(...bids)) / depth.mid) * 10_000;
    let divVenue = "", divBps = 0;
    for (const [venue, best] of Object.entries(depth.best)) {
      if (!best.bid || !best.ask) continue;
      const bps = (((best.bid + best.ask) / 2 - depth.mid) / depth.mid) * 10_000;
      if (Math.abs(bps) > Math.abs(divBps)) { divBps = bps; divVenue = venue; }
    }
    spread = `spread ${spreadBps.toFixed(1)}bp · div ${divVenue} ` +
      `${divBps >= 0 ? "+" : ""}${divBps.toFixed(1)}bp`;
  }

  return (
    <>
      <span className="gauge">
        {imbalancePct !== null && (
          <>book: <b className={depth.imbalance! >= 0.5 ? "buy-c" : "sell-c"}>
            {imbalancePct}% bid</b></>
        )}
      </span>
      <span className="gauge">
        tape 5m: <b className="buy-c">${formatUsd(pressure.buy)}▲</b>
        {" / "}
        <b className="sell-c">${formatUsd(pressure.sell)}▼</b>
      </span>
      <span className="gauge muted">{spread}</span>
    </>
  );
}

function LiqGauge() {
  const liqs = useLensStore((s) => s.liqs);
  const cutoff = Date.now() - 3_600_000;
  let longs = 0, shorts = 0;
  for (const liq of liqs) {
    if (liq.ts >= cutoff) {
      if (liq.side === "long") longs += liq.notional;
      else shorts += liq.notional;
    }
  }
  if (longs + shorts === 0) return null;
  return (
    <span className="gauge muted">
      liqs 1h: <b className="sell-c">${formatUsd(longs)} longs</b>
      {" / "}
      <b className="buy-c">${formatUsd(shorts)} shorts</b>
    </span>
  );
}

function VenueToggles() {
  const venues = useLensStore((s) => s.depth?.venues) ?? [];
  const activeVenues = useLensStore((s) => s.activeVenues);
  const setActiveVenues = useLensStore((s) => s.setActiveVenues);

  function toggle(venue: string, on: boolean) {
    const current = activeVenues ?? venues;
    const next = on ? [...current, venue] : current.filter((v) => v !== venue);
    setActiveVenues(next.length === venues.length ? null : next);
  }

  return (
    <span id="venue-toggles">
      {venues.map((venue) => (
        <label key={venue} className="muted toggle">
          <input
            type="checkbox"
            checked={activeVenues === null || activeVenues.includes(venue)}
            onChange={(event) => toggle(venue, event.target.checked)}
          />{" "}{venue}
        </label>
      ))}
    </span>
  );
}

export function ChartFooter() {
  const layers = useLensStore((s) => s.layers);
  const maVisible = useLensStore((s) => s.maVisible);
  const beepEnabled = useLensStore((s) => s.beepEnabled);
  const setLayer = useLensStore((s) => s.setLayer);
  const setMaVisible = useLensStore((s) => s.setMaVisible);
  const setBeepEnabled = useLensStore((s) => s.setBeepEnabled);

  return (
    <div className="chart-footer">
      <div className="footer-row">
        <Gauges />
        <LiqGauge />
        <VenueToggles />
        <label className="muted toggle">
          <input
            type="checkbox"
            checked={beepEnabled}
            onChange={(event) => setBeepEnabled(event.target.checked)}
          />{" "}monster alert
        </label>
        <button className="mini-btn" title="Save chart as PNG" onClick={exportChartPng}>
          PNG
        </button>
      </div>
      <div className="footer-row">
        <span className="muted row-label">layers</span>
        {LAYER_TOGGLES.map(([layer, label]) => (
          <label key={layer} className="muted toggle">
            <input
              type="checkbox"
              checked={layers[layer]}
              onChange={(event) => setLayer(layer, event.target.checked)}
            />{" "}{label}
          </label>
        ))}
        <span className="muted row-label">MA</span>
        <span id="ma-toggles">
          {MA_DEFS.map((def) => (
            <label key={def.id} className="muted toggle">
              <input
                type="checkbox"
                checked={maVisible[def.id]}
                onChange={(event) => setMaVisible(def.id, event.target.checked)}
              />
              <span className="swatch" style={{ background: def.color }} />
              {def.label}
            </label>
          ))}
        </span>
      </div>
    </div>
  );
}
