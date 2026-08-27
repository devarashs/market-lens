/** Compact USD magnitude: 1234567 → "1.23M". No sign, no "$" — callers add
    their own prefix so the same value works in labels and table cells. */
export function formatUsd(value: number): string {
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(0) + "K";
  return value.toFixed(0);
}

/** Price for the tab title and compact labels: whole dollars with
    separators above $1k, then more decimals as magnitude drops
    (BTC "78,185", SOL "184.23", DOGE "0.2179"). Locale pinned so the
    output is deterministic. */
export function formatPrice(value: number): string {
  if (value >= 1000) return Math.round(value).toLocaleString("en-US");
  if (value >= 10) return value.toFixed(2);
  if (value >= 0.1) return value.toFixed(4);
  return value.toFixed(6);
}

/** Basis points for a dense readout, with the unit attached.

    Decimals scale because the two things measured in bp here live orders
    of magnitude apart. A single venue's spread on BTC is genuinely
    sub-0.1bp — $0.10 wide on $80,000 is 0.012bp — so a fixed one decimal
    would round almost every real spread to "0.0" and hide the quantity
    being reported. The spot/perp basis runs a few bp to a few tens and
    needs no more than one decimal. */
export function formatBps(bps: number): string {
  if (!Number.isFinite(bps)) return "—";
  return `${Math.abs(bps) < 1 ? bps.toFixed(2) : bps.toFixed(1)}bp`;
}

/** "HH:MM:SS" UTC from an epoch-ms timestamp — tape row time column. */
export function formatUtcTime(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(11, 19);
}

/** Compact venue labels for the tape's 200px-wide rows.

    "80,400.2 · bybit-fut · 15:39:45" needed 143px of a 206px row, so
    rows wrapped to two lines and the tape had ragged 26/44/47px heights
    (measured 2026-08-27). Abbreviating the venue is what trading UIs do
    and it buys back the space without dropping the time.

    The "-f" suffix is kept deliberately: spot and perp are different
    instruments trading at a basis to each other, so collapsing
    binance and binance-fut into one label would hide the thing most
    worth noticing when they disagree. */
const VENUE_SHORT: Record<string, string> = {
  binance: "bin", "binance-fut": "bin-f",
  bybit: "byb", "bybit-fut": "byb-f",
  okx: "okx", "okx-fut": "okx-f",
  coinbase: "cb", kraken: "krk", hyperliquid: "hl",
};

export function shortVenue(venue: string): string {
  return VENUE_SHORT[venue] ?? venue.slice(0, 6);
}
