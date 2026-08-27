/* The main view. The URL is the source of truth for symbol + timeframe:
   pills, keyboard shortcuts, and back/forward all navigate; an effect
   applies the route to the store (normalizing illegal pairs like /HYPE/1s
   back to /HYPE/1m with a replace). */

import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { CandleCountdown } from "../components/CandleCountdown";
import { ChartFooter } from "../components/ChartFooter";
import { ChartState } from "../components/ChartState";
import { Header } from "../components/Header";
import { MetricsBar } from "../components/MetricsBar";
import { Readout } from "../components/Readout";
import { SignalsBar } from "../components/SignalsBar";
import { BookPanel } from "../components/BookPanel";
import { TapePanel } from "../components/TapePanel";
import { LensChart } from "../chart/LensChart";
import {
  SYMBOLS, TIMEFRAMES, timeframeAvailable, type Symbol, type Timeframe,
} from "../lib/config";
import { formatPrice } from "../lib/format";
import { useCandlePolling } from "../lib/useCandlePolling";
import { legalTimeframe, useLensStore } from "../store/lens";

/** Tab title: "<price> · <symbol> — Market Lens", price first so a narrow
    tab still shows it. Preference order: aggregate mid from the 1Hz depth
    push, else the metrics last-price (covers every symbol, so a fresh
    symbol switch shows a price before its first depth frame arrives). */
function updateTitle(): void {
  const state = useLensStore.getState();
  const price = state.depth?.mid ?? state.metrics[state.symbol]?.last;
  document.title = price != null
    ? `${formatPrice(price)} · ${state.symbol} — Market Lens`
    : `${state.symbol} ${state.timeframe} — Market Lens`;
}

function parseRoute(symbolParam?: string, timeframeParam?: string) {
  const symbol = SYMBOLS.includes(symbolParam as Symbol)
    ? (symbolParam as Symbol) : "BTC";
  const timeframe = TIMEFRAMES.includes(timeframeParam as Timeframe)
    ? (timeframeParam as Timeframe) : "1m";
  return { symbol, timeframe: legalTimeframe(symbol, timeframe) };
}

export function LensPage() {
  const { symbol: symbolParam, timeframe: timeframeParam } = useParams();
  const navigate = useNavigate();
  useCandlePolling();

  // Route → store, and normalize the URL when it names an illegal or
  // unknown pair (replace: no junk history entries).
  useEffect(() => {
    const { symbol, timeframe } = parseRoute(symbolParam, timeframeParam);
    if (symbolParam !== symbol || timeframeParam !== timeframe) {
      navigate(`/${symbol}/${timeframe}`, { replace: true });
      return;
    }
    const store = useLensStore.getState();
    store.selectSymbol(symbol);
    store.setTimeframe(timeframe);
  }, [symbolParam, timeframeParam, navigate]);

  // Live tab title. Driven by store subscriptions — the 1Hz depth push —
  // and NOT a timer: background tabs throttle timers to a crawl but still
  // deliver WebSocket messages, and a background tab is exactly where a
  // title price matters.
  useEffect(() => {
    const unsubs = [
      useLensStore.subscribe((s) => s.depth, updateTitle),
      useLensStore.subscribe((s) => s.metrics, updateTitle),
      useLensStore.subscribe((s) => s.symbol, updateTitle),
      useLensStore.subscribe((s) => s.timeframe, updateTitle),
    ];
    updateTitle();
    return () => unsubs.forEach((unsub) => unsub());
  }, []);

  // Keyboard shortcuts: 1–6 symbols, [ ] timeframe, h/p layer toggles.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.target as HTMLElement).tagName === "INPUT") return;
      const state = useLensStore.getState();
      const digit = parseInt(event.key, 10);
      if (digit >= 1 && digit <= SYMBOLS.length) {
        navigate(`/${SYMBOLS[digit - 1]}/${state.timeframe}`);
        return;
      }
      // Step only through frames this symbol can actually show, so the
      // bracket keys never land on a disabled interval (HL has no 1s/6h).
      const usable = TIMEFRAMES.filter((tf) => timeframeAvailable(state.symbol, tf));
      const tfIndex = usable.indexOf(state.timeframe);
      if (event.key === "[" && tfIndex > 0) {
        navigate(`/${state.symbol}/${usable[tfIndex - 1]}`);
      }
      if (event.key === "]" && tfIndex >= 0 && tfIndex < usable.length - 1) {
        navigate(`/${state.symbol}/${usable[tfIndex + 1]}`);
      }
      if (event.key === "h") state.setLayer("heat", !state.layers.heat);
      if (event.key === "p") state.setLayer("profile", !state.layers.profile);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return (
    <>
      <Header />
      <MetricsBar />
      <Readout />
      <SignalsBar />
      <main className="layout">
        <section className="chart-wrap">
          <CandleCountdown />
          <LensChart />
          <ChartState />
          <ChartFooter />
        </section>
        <BookPanel />
        <TapePanel />
      </main>
      <footer className="attribution muted">
        Charting by{" "}
        <a href="https://www.tradingview.com/lightweight-charts/"
           target="_blank" rel="noopener noreferrer">
          TradingView Lightweight Charts
        </a>{" "}
        (Apache-2.0). Data: Binance, Bybit, OKX, Coinbase, Kraken, Bitget,
        Deribit, Gate.io &amp; Hyperliquid public streams. Depth/heatmap = resting <em>claims</em>; profile/CVD/tape =
        executed <em>facts</em>. Not financial advice.
      </footer>
    </>
  );
}
