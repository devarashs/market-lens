/* Candle polling: /klines has no push channel, so the client polls —
   2.5s on the 1s view (stale in seconds), 15s otherwise. The effect owns
   one interval per (symbol, timeframe) and aborts in-flight fetches on
   change so a slow response for the old pair can never overwrite the new
   pair's rows. */

import { useEffect } from "react";

import { mergeCandles } from "./candles";
import type { Candle } from "./types";
import { useLensStore } from "../store/lens";

export function useCandlePolling(): void {
  const symbol = useLensStore((state) => state.symbol);
  const timeframe = useLensStore((state) => state.timeframe);

  useEffect(() => {
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        const response = await fetch(
          `/klines?symbol=${symbol}&interval=${timeframe}&limit=1000`,
          { signal: controller.signal },
        );
        const rows: Candle[] | { error: string } = await response.json();
        if (Array.isArray(rows)) {
          // Merge, don't replace: pan-left backfill lives in candleRows
          // and a poll must never throw that history away.
          const store = useLensStore.getState();
          store.setCandleRows(mergeCandles(store.candleRows, rows));
        }
      } catch {
        // Transient gap: retry on the next tick; the connection pill
        // already tells the user when the server is unreachable.
      }
    }

    load();
    const interval = setInterval(load, timeframe === "1s" ? 2_500 : 15_000);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [symbol, timeframe]);
}
