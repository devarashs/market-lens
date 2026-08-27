/* Watchlist: one row per MARKET (exchange × symbol) with its rolling 24h
   flow. The chart pages answer "what is this asset doing"; this answers
   "where is it being done, and by which side".

   Deliberately different from the aggr.trade pane it is modelled on: that
   one accumulates from zero when you open it, so its numbers describe your
   session. This window is a fixed rolling 24 hours held by the collector
   and rebuilt from the archive on restart, so the same question always
   gets the same answer no matter who is looking or when they arrived. */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { formatPrice, formatUsd, shortVenue } from "../lib/format";
import {
  SORT_MODES, filterMarkets, sortMarkets, summarise,
  type MarketRow, type MarketsResponse, type SortMode,
} from "../lib/markets";

const POLL_MS = 5_000;
const PREFS_KEY = "lens-markets-v1";

interface Prefs { sort: SortMode; desc: boolean; floor: number }

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { sort: "none", desc: true, floor: 0, ...JSON.parse(raw) };
  } catch {
    // Private mode or blocked storage: defaults are fine.
  }
  return { sort: "none", desc: true, floor: 0 };
}

export function MarketsPage() {
  const [data, setData] = useState<MarketsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);

  useEffect(() => {
    document.title = "Markets — Market Lens";
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Preferences just don't persist this session.
    }
  }, [prefs]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      try {
        const response = await fetch("/markets", { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: MarketsResponse = await response.json();
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (failure) {
        // An aborted poll is a normal unmount, not a failure. Keep the last
        // good data on screen and say it is stale rather than blanking it.
        if (!cancelled && (failure as Error).name !== "AbortError") {
          setError((failure as Error).message);
        }
      }
    }

    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const rows = useMemo(() => {
    const all = data?.markets ?? [];
    return sortMarkets(filterMarkets(all, prefs.floor, query), prefs.sort, prefs.desc);
  }, [data, prefs.floor, prefs.sort, prefs.desc, query]);

  const totals = useMemo(() => summarise(rows), [rows]);

  return (
    <div className="markets-page">
      <header className="markets-head">
        <h1>
          <Link to="/" className="markets-back">Market Lens</Link>
          <span className="muted"> / markets</span>
        </h1>
        <p className="muted markets-sub">
          Rolling {data?.windowHours ?? 24}h of executed flow per market —
          exchange × symbol. Volume is taker notional; <b>Δ%</b> is
          (buy − sell) as a share of <i>that market's own</i> volume, so it
          ranks one-sidedness rather than size. Raise the volume floor before
          reading a Δ% ranking.
        </p>
      </header>

      <div className="markets-controls">
        <input
          className="markets-search"
          placeholder="Filter symbol or venue…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter markets"
        />
        <label className="markets-field">
          <span className="muted">min 24h volume</span>
          <input
            type="number" min={0} step={10_000}
            value={prefs.floor}
            onChange={(event) =>
              setPrefs({ ...prefs, floor: Math.max(0, +event.target.value || 0) })}
            aria-label="Minimum 24h volume"
          />
        </label>
        <label className="markets-field">
          <span className="muted">sort</span>
          <select
            value={prefs.sort}
            onChange={(event) =>
              setPrefs({ ...prefs, sort: event.target.value as SortMode })}
            aria-label="Sort markets by"
          >
            {SORT_MODES.map((mode) => (
              <option key={mode} value={mode}>{mode}</option>
            ))}
          </select>
        </label>
        <button
          className="mini-btn"
          disabled={prefs.sort === "none"}
          onClick={() => setPrefs({ ...prefs, desc: !prefs.desc })}
          title="Switch order"
        >
          {prefs.desc ? "desc ▼" : "asc ▲"}
        </button>
      </div>

      <div className="markets-totals muted">
        <span><b>{totals.markets}</b> markets</span>
        <span>vol <b>${formatUsd(totals.volume)}</b></span>
        <span>
          net{" "}
          <b className={totals.delta >= 0 ? "buy-c" : "sell-c"}>
            {totals.delta >= 0 ? "+" : "−"}${formatUsd(Math.abs(totals.delta))}
          </b>
          {totals.deltaPct !== null && ` (${totals.deltaPct.toFixed(1)}%)`}
        </span>
        {error && <span className="sell-c">stale — {error}</span>}
      </div>

      {data === null && !error && <p className="muted">loading…</p>}

      <table className="markets-table">
        <thead>
          <tr>
            <th>market</th>
            <th className="num">price</th>
            <th className="num">24h</th>
            <th className="num">24h volume</th>
            <th className="num">Δ</th>
            <th className="num">Δ%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <Row key={`${row.symbol}:${row.venue}`} row={row} />)}
        </tbody>
      </table>

      {data !== null && rows.length === 0 && (
        <p className="muted">No market matches — try a lower volume floor.</p>
      )}
    </div>
  );
}

function Row({ row }: { row: MarketRow }) {
  // Bar width tracks |Δ%|, so one-sidedness reads at a glance without
  // having to compare numbers across rows.
  const width = row.deltaPct === null ? 0 : Math.min(100, Math.abs(row.deltaPct));
  return (
    <tr>
      <td>
        <Link to={`/${row.symbol}/1m`} className="markets-symbol">
          <b>{row.symbol}</b>
          <span className="muted"> {shortVenue(row.venue)}</span>
        </Link>
      </td>
      <td className="num">{row.price === null ? "—" : formatPrice(row.price)}</td>
      <td className={`num ${row.change === null ? "" : row.change >= 0 ? "buy-c" : "sell-c"}`}>
        {row.change === null
          ? "—"
          : `${row.change >= 0 ? "+" : ""}${row.change.toFixed(2)}%`}
      </td>
      <td className="num">${formatUsd(row.volume)}</td>
      <td className={`num ${row.delta >= 0 ? "buy-c" : "sell-c"}`}>
        {row.delta >= 0 ? "+" : "−"}${formatUsd(Math.abs(row.delta))}
      </td>
      <td className="num delta-cell">
        <i
          className={row.deltaPct !== null && row.deltaPct >= 0 ? "buy" : "sell"}
          style={{ width: `${width}%` }}
        />
        <span>{row.deltaPct === null ? "—" : `${row.deltaPct.toFixed(0)}%`}</span>
      </td>
    </tr>
  );
}
