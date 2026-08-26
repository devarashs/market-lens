/* Time remaining in the open candle. Candle boundaries are epoch-aligned
   (a 5m bar closes at :00, :05, :10 …; the daily closes at 00:00 UTC),
   which is how Binance and Hyperliquid stamp their klines — so the
   boundary is arithmetic, not something to ask the server for. */

/** Seconds until the current `intervalSeconds` candle closes.

    Counts DOWN to the boundary: a bar that just opened reads the full
    interval and the last second before the close reads 1, so the number
    on screen never sits at 0. */
export function secondsUntilClose(intervalSeconds: number, nowMs: number): number {
  const elapsed = (nowMs / 1000) % intervalSeconds;
  return Math.ceil(intervalSeconds - elapsed);
}

/** "04:32", or "3:07:12" once an hour or more remains (4h and 1d bars). */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60) % 60;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds % 60)}`;
  return `${pad(minutes)}:${pad(seconds % 60)}`;
}
