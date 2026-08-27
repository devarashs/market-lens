import { exportChartPng } from "../chart/chartExport";
import { LAYER_DEFS, MA_DEFS, POSITIONING_LABELS } from "../lib/config";
import { FilterMenu, type FilterOption } from "./FilterMenu";
import { availableMetrics, pickPositioningMetric } from "../lib/positioning";
import { formatBps, formatUsd } from "../lib/format";
import { crossVenueBasis, tightestVenueSpread, widestVenueDivergence } from "../lib/spread";
import { useLensStore } from "../store/lens";

/** Which positioning series the chart draws. Only rendered when the
    symbol has more than one — most do not, and the equity perps have
    none at all. */
function PositioningPicker() {
  const positioning = useLensStore((s) => s.positioning);
  const chosen = useLensStore((s) => s.positioningMetric);
  const setMetric = useLensStore((s) => s.setPositioningMetric);
  const available = availableMetrics(positioning);
  if (available.length === 0) {
    return <span className="gauge muted">net L/S: no source for this symbol</span>;
  }
  const active = pickPositioningMetric(positioning, chosen);
  const latest = active ? positioning[active]?.at(-1)?.[1] : undefined;
  return (
    <span className="gauge">
      net L/S{" "}
      {latest !== undefined && (
        <b className={latest >= 0 ? "buy-c" : "sell-c"}>
          {latest >= 0 ? "+" : ""}{latest.toFixed(0)}%
        </b>
      )}{" "}
      <select
        className="mini-btn"
        aria-label="Positioning source"
        value={active ?? ""}
        onChange={(event) => setMetric(event.target.value)}
      >
        {available.map((metric) => (
          <option key={metric} value={metric}>
            {POSITIONING_LABELS[metric] ?? metric}
          </option>
        ))}
      </select>
    </span>
  );
}

function Gauges() {
  const depth = useLensStore((s) => s.depth);
  if (!depth) return <span className="gauge muted">book warming up…</span>;

  const imbalancePct = depth.imbalance !== null
    ? (depth.imbalance * 100).toFixed(0) : null;
  const pressure = depth.pressure ?? { buy: 0, sell: 0 };

  /* Spread, basis and divergence across venues' best quotes.

     The spread is the tightest SINGLE venue's, never min(ask) − max(bid)
     across the aggregate: that subtraction spans spot and perp venues
     trading at a basis to each other, and it goes negative whenever the
     basis is wider than either venue's own spread. It read -10.0bp here on
     BTC, 2026-08-27, with every individual venue tight and uncrossed. The
     crossing is reported separately, under its real name. lib/spread.ts
     carries the arithmetic; the ladder's mid row shows the same pair. */
  const tightest = tightestVenueSpread(depth.best);
  const basis = crossVenueBasis(depth.best);
  const divergence = widestVenueDivergence(depth.best, depth.mid);
  const readings = [
    tightest && `spread ${formatBps(tightest.bps)} ${tightest.venue}`,
    basis && `basis ${formatBps(basis.bps)}`,
    divergence && `div ${divergence.venue} `
      + `${divergence.bps >= 0 ? "+" : ""}${formatBps(divergence.bps)}`,
  ].filter(Boolean);
  const spread = readings.length ? readings.join(" · ") : null;

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

/** Markets: which venues feed the aggregate, searchable. */
function VenueMenu() {
  const venues = useLensStore((s) => s.depth?.venues) ?? EMPTY_VENUES;
  const activeVenues = useLensStore((s) => s.activeVenues);
  const setActiveVenues = useLensStore((s) => s.setActiveVenues);
  const selected = new Set(activeVenues ?? venues);

  const options: FilterOption[] = venues.map((venue) => ({
    key: venue,
    label: venue,
    group: venue.endsWith("-fut") || venue === "hyperliquid" ? "Perps" : "Spot",
  }));

  function toggle(venue: string, on: boolean) {
    const current = activeVenues ?? venues;
    const next = on ? [...current, venue] : current.filter((v) => v !== venue);
    setActiveVenues(next.length === venues.length ? null : next);
  }

  return (
    <FilterMenu
      title="Markets" options={options} selected={selected} onToggle={toggle}
      onSetAll={(on) => setActiveVenues(on ? null : [])}
    />
  );
}

/** Chart layers, grouped and searchable — twenty-two of them now. */
function LayerMenu() {
  const layers = useLensStore((s) => s.layers);
  const setLayer = useLensStore((s) => s.setLayer);
  const setLayers = useLensStore((s) => s.setLayers);
  const flags = layers as unknown as Record<string, boolean>;
  const selected = new Set(
    LAYER_DEFS.filter((def) => flags[def.key]).map((def) => def.key));
  return (
    <FilterMenu
      title="Layers"
      options={LAYER_DEFS.map((def) => ({ ...def }))}
      selected={selected}
      onToggle={(key, on) => setLayer(key as keyof typeof layers, on)}
      onSetAll={(on) => setLayers(Object.fromEntries(
        LAYER_DEFS.map((def) => [def.key, on])) as Partial<typeof layers>)}
    />
  );
}

/** Moving averages: SMA and EMA in one searchable list. */
function MaMenu() {
  const maVisible = useLensStore((s) => s.maVisible);
  const setMaVisible = useLensStore((s) => s.setMaVisible);
  const selected = new Set(MA_DEFS.filter((def) => maVisible[def.id])
    .map((def) => def.id));
  const options: FilterOption[] = MA_DEFS.map((def) => ({
    key: def.id,
    label: def.label,
    color: def.color,
    group: def.kind === "sma" ? "Simple" : "Exponential",
    hint: `${def.length} bars`,
  }));
  return (
    <FilterMenu
      title="MAs" options={options} selected={selected}
      onToggle={(key, on) => setMaVisible(key, on)}
      onSetAll={(on) => MA_DEFS.forEach((def) => setMaVisible(def.id, on))}
    />
  );
}

const EMPTY_VENUES: string[] = [];

export function ChartFooter() {
  const beepEnabled = useLensStore((s) => s.beepEnabled);
  const setBeepEnabled = useLensStore((s) => s.setBeepEnabled);

  return (
    <div className="chart-footer">
      <div className="footer-row">
        <Gauges />
        <LiqGauge />
        <PositioningPicker />
        <label className="muted toggle">
          <input
            type="checkbox"
            checked={beepEnabled}
            onChange={(event) => setBeepEnabled(event.target.checked)}
          />{" "}sound
        </label>
        <button className="mini-btn" title="Save chart as PNG" onClick={exportChartPng}>
          PNG
        </button>
        <span className="footer-menus">
          <LayerMenu />
          <VenueMenu />
          <MaMenu />
        </span>
      </div>
    </div>
  );
}
