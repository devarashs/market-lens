import { useEffect, useState } from "react";

import { formatUsd } from "../lib/format";

interface Stables {
  available: boolean;
  supplyUsd?: number;
  change7dPct?: number | null;
  change30dPct?: number | null;
  change90dPct?: number | null;
  percentileOfYear?: number | null;
}

/** Total stablecoin supply — the market's dry powder.

    Deliberately a READOUT, not a signal. The arena tested the idea before
    this was built: the 7-day change carries a faint tilt at a 7-day
    horizon (+1.31% on 605 non-overlapping trades, beating random long
    entry by 1.12 points, only 49% long so it is not just market beta) and
    nothing at 1, 14 or 30 days. A rank correlation of 0.065 explains
    under half a percent of variance, so it is on probation and the
    tooltip says so rather than the number implying more than it earned. */
export function Stablecoins() {
  const [data, setData] = useState<Stables | null>(null);

  useEffect(() => {
    let live = true;
    function load() {
      fetch("/stablecoins")
        .then((response) => response.json())
        .then((payload) => { if (live) setData(payload); })
        .catch(() => { /* the metrics bar simply omits it */ });
    }
    load();
    const timer = setInterval(load, 10 * 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  if (!data?.available || data.supplyUsd === undefined) return null;
  const change = data.change7dPct ?? null;
  const percentile = data.percentileOfYear ?? null;
  const band = percentile === null ? null
    : percentile >= 66.7 ? "expanding fast" : percentile <= 33.3 ? "contracting" : "middling";

  return (
    <span className="gauge stables"
          title={"Total USD-pegged stablecoin supply (DefiLlama). The 7-day change is "
            + "the only window that survived the arena's backtest, and only faintly — "
            + "a measurement on probation, not a signal."}>
      stables: <b>${formatUsd(data.supplyUsd)}</b>{" "}
      {change !== null && (
        <b className={change >= 0 ? "buy-c" : "sell-c"}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}% 7d
        </b>
      )}
      {band && <span className="muted"> · {band}</span>}
      {percentile !== null && (
        <span className="muted"> ({percentile.toFixed(0)}th pct of year)</span>
      )}
    </span>
  );
}
