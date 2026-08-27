/* Candle polling: /klines has no push channel, so the client polls —
   2.5s on the 1s view (stale in seconds), 15s otherwise. The effect owns
   one interval per (symbol, timeframe) and aborts in-flight fetches on
   change so a slow response for the old pair can never overwrite the new
   pair's rows. */

import { useEffect } from "react";

import { mergeCandles } from "./candles";
import type { Candle } from "./types";
import { useLensStore } from "../store/lens";

/** Delay before retrying a failed load, in ms — 400, 800, 1600, capped.

    A first load that fails used to wait for the next poll instead, and on
    anything but the 1s view that is FIFTEEN SECONDS of blank chart. The
    socket layers (book, tape, heatmap) keep painting throughout, so it
    reads exactly as Arash described it: switch symbol, some things show,
    candles do not, reload fixes it (2026-08-27). Measured fetch time for
    1000 candles is 600-770ms, so the window for a switch to land on an
    in-flight request is wide. */
export function backoffDelay(attempt: number): number {
  return Math.min(4_000, 400 * 2 ** Math.max(0, attempt - 1));
}

export function useCandlePolling(): void {
  const symbol = useLensStore((state) => state.symbol);
  const timeframe = useLensStore((state) => state.timeframe);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function load(): Promise<void> {
      try {
        const response = await fetch(
          `/klines?symbol=${symbol}&interval=${timeframe}&limit=1000`,
          { signal: controller.signal },
        );
        const rows: Candle[] | { error: string } = await response.json();
        if (cancelled) return;
        if (!Array.isArray(rows)) {
          throw new Error(
            typeof (rows as { error?: string }).error === "string"
              ? (rows as { error: string }).error
              : "unexpected response");
        }
        attempt = 0;
        // Merge, don't replace: pan-left backfill lives in candleRows
        // and a poll must never throw that history away.
        const store = useLensStore.getState();
        store.setCandleRows(mergeCandles(store.candleRows, rows));
        store.setCandleLoad({ state: "ready", attempt: 0 });
      } catch (error) {
        // An abort means this pair was superseded — the new effect is
        // already loading, and retrying here would fight it.
        if (cancelled || controller.signal.aborted) return;
        attempt += 1;
        // Say so on screen. A silent retry is why a failed load was
        // indistinguishable from a chart that simply never drew.
        useLensStore.getState().setCandleLoad({
          state: "retrying",
          attempt,
          reason: error instanceof Error ? error.message : "request failed",
        });
        retryTimer = setTimeout(load, backoffDelay(attempt));
      }
    }

    load();
    const interval = setInterval(load, timeframe === "1s" ? 2_500 : 15_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(retryTimer);
      clearInterval(interval);
    };
  }, [symbol, timeframe]);
}
