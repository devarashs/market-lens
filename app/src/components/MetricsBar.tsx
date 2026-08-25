import { useEffect, useState, type ReactNode } from "react";

import { formatUsd } from "../lib/format";
import { useLensStore } from "../store/lens";

/** Funding / OI strip. A 30s ticker re-renders it so the funding
    countdown moves even when no fresh metrics arrive. */
export function MetricsBar() {
  const symbol = useLensStore((s) => s.symbol);
  const metrics = useLensStore((s) => s.metrics[s.symbol]);
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const parts: ReactNode[] = [];
  if (metrics?.funding !== undefined) {
    const remaining = metrics.nextFunding
      ? Math.max(0, metrics.nextFunding - Date.now())
      : null;
    const countdown = remaining === null ? "" :
      ` (in ${Math.floor(remaining / 3_600_000)}h` +
      `${String(Math.floor(remaining / 60_000) % 60).padStart(2, "0")}m)`;
    parts.push(
      <span key="funding">
        funding{" "}
        <b className={metrics.funding >= 0 ? "buy-c" : "sell-c"}>
          {(metrics.funding * 100).toFixed(4)}%
        </b>
        {countdown}
      </span>,
    );
  }
  if (metrics?.oiUsd) {
    parts.push(
      <span key="oi">OI <b>${formatUsd(metrics.oiUsd)}</b> <span className="muted">(HL)</span></span>,
    );
  }

  return (
    <div className="metrics">
      <span className="sym-name">{symbol}</span>
      {parts.length
        ? parts.map((part, i) => <span key={i}>{i > 0 && " · "}{part}</span>)
        : <span className="muted">loading metrics…</span>}
    </div>
  );
}
