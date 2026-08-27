/* Labels for the order book's price-grouping control.

   The ladder itself is NOT computed here — the server sends `binLadder`
   with every depth frame, so the select's options are exactly the values it will
   accept and the two can never drift. This file only decides how a bin
   size reads to a human: BTC's coarse rungs as "1k"/"10k" rather than
   "1000"/"10000" (Arash asked for them by those names), sub-dollar bins
   at their natural precision. */

/** Drop trailing zeros without going exponential on small numbers. */
function trim(value: number): string {
  return String(parseFloat(value.toFixed(4)));
}

export function formatBin(bin: number): string {
  if (!(bin > 0) || !Number.isFinite(bin)) return "—";
  if (bin >= 1_000_000) return `${trim(bin / 1_000_000)}M`;
  if (bin >= 1_000) return `${trim(bin / 1_000)}k`;
  if (bin >= 1) return trim(bin);
  // Below a dollar, show the bin at exactly its own resolution so
  // 0.0005 and 0.005 are visibly different rungs.
  return bin.toFixed(Math.min(10, -Math.floor(Math.log10(bin))));
}
