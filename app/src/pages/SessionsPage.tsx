/* Trading-hub session clock, on its own page.

   Ported from the arena dashboard at Arash's request. The one change worth
   the port: over there each card's volume share is frozen text from the
   August session study, so it reads "35% of BTC volume" forever. Here the
   share is recomputed from flow_minutes over a rolling 30 days, and the
   study figure sits beside it — a session drifting away from its
   historical share is the interesting event, and you can only see it with
   both numbers on screen.

   Two clocks at different rates on purpose: the countdown ticks every
   second because a clock that lags is worse than no clock, while the
   volume shares poll once a minute because they move over days. */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { SYMBOLS, type Symbol } from "../lib/config";
import { formatUsd } from "../lib/format";
import {
  activeSession, formatCountdown, hoursUntilChange, isOpen, localHourLabel,
  nextSession, utcHours, type SessionRow, type SessionsResponse,
} from "../lib/sessions";

const POLL_MS = 60_000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function SessionsPage() {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<Symbol | "">("");
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    document.title = "Sessions — Market Lens";
  }, []);

  // The clock. One second, because a countdown that lags reads as broken.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  // The shares. One minute, because they are a 30-day average.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      try {
        const query = symbol ? `?symbol=${symbol}` : "";
        const response = await fetch(`/api/sessions${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: SessionsResponse = await response.json();
        if (!cancelled) { setData(payload); setError(null); }
      } catch (failure) {
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
  }, [symbol]);

  const hours = utcHours(now);
  const sessions = data?.sessions ?? [];
  const open = useMemo(() => activeSession(sessions, hours), [sessions, hours]);
  const next = useMemo(() => nextSession(sessions, hours), [sessions, hours]);
  const peakHour = useMemo(() => {
    const hourly = data?.hourly ?? [];
    return hourly.reduce<{ hour: number; volume: number } | null>(
      (best, row) => (best === null || row.volume > best.volume ? row : best), null);
  }, [data]);
  const maxHourVolume = Math.max(1, ...(data?.hourly ?? []).map((row) => row.volume));

  return (
    <div className="sessions-page">
      <header className="sessions-head">
        <h1>
          <Link to="/" className="sessions-back">Market Lens</Link>
          <span className="muted"> / sessions</span>
        </h1>
        <p className="muted sessions-sub">
          Which trading desks are at work, and what share of volume each one
          actually accounts for — recomputed from the last{" "}
          {data?.windowDays ?? 30} days of recorded flow rather than quoted
          from a study. The study's own figure sits beside each live one, so
          drift is visible.
        </p>
      </header>

      <div className="sessions-now">
        <div className="clock">
          <span className="clock-utc">
            {pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}:{pad(now.getUTCSeconds())}
            <small> UTC</small>
          </span>
          <span className="muted clock-local">
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} local
            {" · "}{Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </div>
        <div className="clock-state">
          {open ? (
            <>
              <span className="badge-open">{open.name} open</span>
              <span className="muted">
                closes in {formatCountdown(hoursUntilChange(open, hours))}
                {next && ` · ${next.name} in ${formatCountdown(hoursUntilChange(next, hours))}`}
              </span>
            </>
          ) : (
            <span className="muted">waiting for the first session…</span>
          )}
        </div>
        <label className="sessions-field">
          <span className="muted">market</span>
          <select value={symbol} aria-label="Volume shares for symbol"
                  onChange={(event) => setSymbol(event.target.value as Symbol | "")}>
            <option value="">all markets</option>
            {SYMBOLS.map((key) => <option key={key} value={key}>{key}</option>)}
          </select>
        </label>
        {error && <span className="sell-c">stale — {error}</span>}
      </div>

      {data === null && !error && <p className="muted">loading…</p>}

      <div className="session-cards">
        {sessions.map((session) => (
          <SessionCard key={session.key} session={session} hours={hours} now={now} />
        ))}
      </div>

      {(data?.hourly?.length ?? 0) > 0 && (
        <section className="hour-profile">
          <h2>Volume by hour of day</h2>
          <p className="muted hour-sub">
            Every UTC hour over the window, coloured by session.
            {peakHour && ` Busiest is ${pad(peakHour.hour)}:00 UTC.`}
            {data && ` Total $${formatUsd(data.totalVolume)}.`}
          </p>
          <div className="hour-bars">
            {data!.hourly.map((row) => (
              <div key={row.hour} className={`hour-bar s-${row.session ?? "none"}`}
                   title={`${pad(row.hour)}:00 UTC — $${formatUsd(row.volume)}`
                          + (row.sharePct !== null ? ` (${row.sharePct.toFixed(2)}%)` : "")}>
                <i style={{ height: `${(row.volume / maxHourVolume) * 100}%` }} />
                <span>{row.hour % 3 === 0 ? pad(row.hour) : ""}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SessionCard({ session, hours, now }: {
  session: SessionRow; hours: number; now: Date;
}) {
  const open = isOpen(session, hours);
  const until = hoursUntilChange(session, hours);
  const drift = session.driftPct;
  return (
    <article className={`session-card${open ? " is-open" : ""}`}>
      <header>
        <h3>{session.name}</h3>
        <span className={open ? "badge-open" : "badge-shut"}>
          {open ? "open" : "closed"}
        </span>
      </header>
      <p className="muted hubs">{session.hubs}</p>
      <p className="window">
        {pad(session.start)}:00–{pad(session.end % 24)}:00 UTC
        <span className="muted">
          {" "}({localHourLabel(session.start, now)}–{localHourLabel(session.end, now)} local)
        </span>
      </p>
      <p className={`countdown${open ? " open" : ""}`}>
        {open ? "closes in " : "opens in "}{formatCountdown(until)}
      </p>
      <div className="share">
        <div className="share-bar">
          <i style={{ width: `${session.sharePct ?? 0}%` }} />
          {/* Where the August study said this session sat. */}
          <b style={{ left: `${session.studyShare}%` }} title="study baseline" />
        </div>
        <div className="share-nums">
          <span className="share-live">
            {session.sharePct === null ? "—" : `${session.sharePct.toFixed(1)}%`}
          </span>
          <span className="muted">of volume · study said {session.studyShare}%</span>
          {drift !== null && Math.abs(drift) >= 1 && (
            <span className={drift > 0 ? "buy-c" : "sell-c"}>
              {drift > 0 ? "+" : ""}{drift.toFixed(1)} pts
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
