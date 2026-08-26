import { useEffect, useState } from "react";

import { formatPrice, formatUsd } from "../lib/format";
import { useLensStore } from "../store/lens";

interface Info {
  symbol: string;
  assetClass: string;
  returns: Record<string, number | null>;
  volumes: Record<string, number | null>;
  extremes: {
    high: number | null; low: number | null; days: number;
    fromHigh: number | null; rangePosition: number | null;
  };
  volatility30d: number | null;
  marketDataAvailable: boolean;
  market: null | {
    name?: string; marketCap?: number; rank?: number; fdv?: number;
    circulating?: number; maxSupply?: number; spotVolume24h?: number;
    ath?: number; athChangePct?: number; atl?: number; atlChangePct?: number;
  };
  derivatives: {
    openInterestUsd?: number | null; funding?: number | null;
    fundingHl?: number | null; last?: number | null; change24h?: number | null;
  };
  venues: string[];
  liquidations24h: { long: number; short: number };
  positioning: Record<string, number>;
}

const RETURN_ORDER = ["1h", "24h", "7d", "30d", "90d", "1y"];

function Pct({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return (
    <b className={value >= 0 ? "buy-c" : "sell-c"}>
      {value >= 0 ? "+" : ""}{value.toFixed(2)}%
    </b>
  );
}

function Money({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <b>${formatUsd(value)}</b>;
}

export function SymbolInfo({ symbol, onClose }: { symbol: string; onClose(): void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setInfo(null);
    setError(null);
    fetch(`/symbol-info?symbol=${encodeURIComponent(symbol)}`)
      .then((response) => response.json())
      .then((data) => { if (live) { data.error ? setError(data.error) : setInfo(data); } })
      .catch((cause) => { if (live) setError(String(cause)); });
    return () => { live = false; };
  }, [symbol]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const market = info?.market;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()}
           role="dialog" aria-label={`${symbol} information`}>
        <header>
          <h2>{symbol} {market?.name && <span className="muted">{market.name}</span>}</h2>
          <button className="mini-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {error && <p className="sell-c">Could not load: {error}</p>}
        {!info && !error && <p className="muted">Loading…</p>}

        {info && (
          <div className="modal-body">
            <section>
              <h3>Returns</h3>
              <div className="stat-grid">
                {RETURN_ORDER.map((window) => (
                  <div key={window} className="stat">
                    <span className="muted">{window}</span>
                    <Pct value={info.returns[window]} />
                  </div>
                ))}
              </div>
              {info.returns["1y"] === null && (
                <p className="muted small">
                  Blank windows are longer than this market's history — it has
                  {" "}{info.extremes.days} days of candles, not a missing number.
                </p>
              )}
            </section>

            <section>
              <h3>Volume {info.market ? <span className="muted">(perp)</span> : null}</h3>
              <div className="stat-grid">
                <div className="stat"><span className="muted">24h</span>
                  <Money value={info.volumes["24h"]} /></div>
                <div className="stat"><span className="muted">daily avg 7d</span>
                  <Money value={info.volumes.avg7d} /></div>
                <div className="stat"><span className="muted">daily avg 30d</span>
                  <Money value={info.volumes.avg30d} /></div>
                <div className="stat"><span className="muted">30d total</span>
                  <Money value={info.volumes.total30d} /></div>
                {market?.spotVolume24h !== undefined && (
                  <div className="stat"><span className="muted">spot 24h (all venues)</span>
                    <Money value={market.spotVolume24h} /></div>
                )}
              </div>
            </section>

            <section>
              <h3>Size &amp; supply</h3>
              {info.marketDataAvailable && market ? (
                <div className="stat-grid">
                  <div className="stat"><span className="muted">market cap</span>
                    <Money value={market.marketCap} /></div>
                  <div className="stat"><span className="muted">rank</span>
                    <b>{market.rank ? `#${market.rank}` : "—"}</b></div>
                  <div className="stat"><span className="muted">fully diluted</span>
                    <Money value={market.fdv} /></div>
                  <div className="stat"><span className="muted">circulating</span>
                    <b>{market.circulating ? formatUsd(market.circulating) : "—"}</b></div>
                  <div className="stat"><span className="muted">max supply</span>
                    <b>{market.maxSupply ? formatUsd(market.maxSupply) : "∞"}</b></div>
                </div>
              ) : (
                <p className="muted small">
                  No market cap for this one, and that is a fact about the
                  instrument rather than a gap: it is a perpetual on{" "}
                  {info.assetClass === "commodity" ? "a commodity" : "an equity"},
                  with no issuer, float or supply behind it. The underlying
                  company's market cap belongs to a different instrument on a
                  different exchange.
                </p>
              )}
            </section>

            <section>
              <h3>Range &amp; risk</h3>
              <div className="stat-grid">
                <div className="stat">
                  <span className="muted">{info.extremes.days}d high</span>
                  <b>{info.extremes.high !== null ? formatPrice(info.extremes.high) : "—"}</b>
                </div>
                <div className="stat">
                  <span className="muted">{info.extremes.days}d low</span>
                  <b>{info.extremes.low !== null ? formatPrice(info.extremes.low) : "—"}</b>
                </div>
                <div className="stat"><span className="muted">from high</span>
                  <Pct value={info.extremes.fromHigh} /></div>
                <div className="stat">
                  <span className="muted">position in range</span>
                  <b>{info.extremes.rangePosition !== null
                    ? `${info.extremes.rangePosition.toFixed(0)}%` : "—"}</b>
                </div>
                <div className="stat">
                  <span className="muted">volatility (30d, annualised)</span>
                  <b>{info.volatility30d !== null
                    ? `${info.volatility30d.toFixed(0)}%` : "—"}</b>
                </div>
                {market?.ath !== undefined && (
                  <div className="stat"><span className="muted">from all-time high</span>
                    <Pct value={market.athChangePct} /></div>
                )}
              </div>
            </section>

            <section>
              <h3>Derivatives</h3>
              <div className="stat-grid">
                <div className="stat"><span className="muted">open interest</span>
                  <Money value={info.derivatives.openInterestUsd} /></div>
                <div className="stat"><span className="muted">funding</span>
                  <b>{info.derivatives.funding !== null
                      && info.derivatives.funding !== undefined
                    ? `${(info.derivatives.funding * 100).toFixed(4)}%` : "—"}</b></div>
                <div className="stat"><span className="muted">venues streaming</span>
                  <b>{info.venues.length}</b></div>
              </div>
            </section>

            <section>
              <h3>From our own record <span className="muted">(nobody sells this back)</span></h3>
              <div className="stat-grid">
                <div className="stat"><span className="muted">longs liquidated 24h</span>
                  <Money value={info.liquidations24h.long} /></div>
                <div className="stat"><span className="muted">shorts liquidated 24h</span>
                  <Money value={info.liquidations24h.short} /></div>
                {Object.entries(info.positioning).map(([metric, value]) => (
                  <div key={metric} className="stat">
                    <span className="muted">net L/S · {metric}</span>
                    <Pct value={value} />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/** The header button that opens the panel for the current symbol. */
export function SymbolInfoButton() {
  const symbol = useLensStore((s) => s.symbol);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mini-btn" onClick={() => setOpen(true)}
              title={`Reference data for ${symbol}`}>
        info
      </button>
      {open && <SymbolInfo symbol={symbol} onClose={() => setOpen(false)} />}
    </>
  );
}
