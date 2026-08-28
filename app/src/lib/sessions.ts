/* Trading-hub session clock: which desk is at work, and when the next one
   arrives.

   The arithmetic lives here rather than in the component because clock
   maths is where off-by-one hours hide — a countdown that reads "opens in
   24h 00m" the instant a session closes is the classic one, and it is only
   visible if you can call the function with a made-up time. */

export interface SessionRow {
  key: string;
  name: string;
  hubs: string;
  start: number;          // UTC hour, inclusive
  end: number;            // UTC hour, exclusive
  studyShare: number;     // % measured in the August session study
  volume: number;
  sharePct: number | null;
  driftPct: number | null;
}

export interface HourRow {
  hour: number;
  volume: number;
  sharePct: number | null;
  session: string | null;
}

export interface SessionsResponse {
  asOf: number;
  windowDays: number;
  symbol: string | null;
  totalVolume: number;
  sessions: SessionRow[];
  hourly: HourRow[];
}

/** Fractional UTC hour, e.g. 14.5 at 14:30 UTC. */
export function utcHours(now: Date): number {
  return now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
}

export function isOpen(session: SessionRow, hours: number): boolean {
  return hours >= session.start && hours < session.end;
}

/** Hours until this session next changes state — closes if open, opens if
    not. Never returns 24: a session that just closed opens in 24 hours
    minus the time already elapsed, and a bare modulo reports the wrong end
    of that. */
export function hoursUntilChange(session: SessionRow, hours: number): number {
  if (isOpen(session, hours)) return session.end - hours;
  const until = (session.start - hours + 24) % 24;
  return until === 0 ? 24 : until;
}

/** "3h 07m" — always two-digit minutes so the value does not jitter in
    width once a second. */
export function formatCountdown(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

/** The session currently open. Windows are contiguous, so there is always
    exactly one — but the fallback is honest rather than assumed. */
export function activeSession(
  sessions: SessionRow[], hours: number,
): SessionRow | null {
  return sessions.find((session) => isOpen(session, hours)) ?? null;
}

/** The session opening next, for the "up next" line. */
export function nextSession(
  sessions: SessionRow[], hours: number,
): SessionRow | null {
  const upcoming = sessions
    .filter((session) => !isOpen(session, hours))
    .map((session) => ({ session, wait: hoursUntilChange(session, hours) }))
    .sort((a, b) => a.wait - b.wait);
  return upcoming[0]?.session ?? null;
}

/** A UTC hour rendered in the viewer's own zone, e.g. "09:00". */
export function localHourLabel(utcHour: number, now = new Date()): string {
  const at = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour % 24));
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
