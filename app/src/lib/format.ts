/** Compact USD magnitude: 1234567 → "1.23M". No sign, no "$" — callers add
    their own prefix so the same value works in labels and table cells. */
export function formatUsd(value: number): string {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(0) + "K";
  return value.toFixed(0);
}

/** "HH:MM:SS" UTC from an epoch-ms timestamp — tape row time column. */
export function formatUtcTime(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(11, 19);
}
