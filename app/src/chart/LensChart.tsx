/* The chart surface: Lightweight Charts lifecycle, series management, and
   the overlay-canvas render loop.

   Architecture note (the fix for "laggy"): this component renders ONCE.
   Every live update — depth at 2.5Hz, heat columns, trades — flows through
   transient store subscriptions and a requestAnimationFrame loop with a
   dirty flag, so nothing here re-enters React. The old client redrew both
   canvases synchronously inside every WebSocket message handler; here a
   burst of messages costs one draw on the next frame. */

import {
  ColorType,
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import {
  COLORS, MA_DEFS, QLH_SETTINGS, TF_SECONDS, type ChartStyle,
} from "../lib/config";
import { bucketSeries, computeMa, mergeCandles, styledRows } from "../lib/candles";
import { pickPositioningMetric } from "../lib/positioning";
import type { Candle } from "../lib/types";
import { currentThreshold, useLensStore, type ReadoutData } from "../store/lens";
import { registerChartExporter } from "./chartExport";
import {
  drawBubbles, drawDepth, drawEventMarks, drawHeat, drawLiqGrid, drawLiqMap,
  drawLiqPrints, drawProfile, drawRegimeTint, drawRoundLevels, drawStopClusters,
  drawSweeps, drawValueArea, drawVolumeNodes, drawWallLines, type DrawEnv,
} from "./overlays";
import { computeHunter, valueAreaFromProfile, type HunterFrame } from "../lib/hunter";

/* The four price-series types expose an identical surface for everything
   we call (setData, applyOptions, price mapping, price lines), so one
   nominal type stands in for all of them. The casts live only here. */
type PriceSeries = ISeriesApi<"Candlestick">;

const REDRAW_EVERY_MS = 300; // time drift floor: bars advance even when idle

function makePriceSeries(chart: IChartApi, style: ChartStyle): PriceSeries {
  if (style === "bars") {
    return chart.addBarSeries({
      upColor: COLORS.up, downColor: COLORS.down,
    }) as unknown as PriceSeries;
  }
  if (style === "line") {
    return chart.addLineSeries({
      color: COLORS.line, lineWidth: 2,
    }) as unknown as PriceSeries;
  }
  if (style === "area") {
    return chart.addAreaSeries({
      lineColor: COLORS.line, lineWidth: 2,
      topColor: "rgba(127,174,147,0.25)", bottomColor: "rgba(127,174,147,0.02)",
    }) as unknown as PriceSeries;
  }
  return chart.addCandlestickSeries({ // candles + heikin share the type
    upColor: COLORS.up, downColor: COLORS.down,
    wickUpColor: COLORS.up, wickDownColor: COLORS.down,
    borderVisible: false,
  });
}

interface DayLevels {
  prev: Candle;
  today: Candle;
}

export function LensChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const underRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);

  // Everything below lives for the component's whole life — one effect,
  // one teardown. Splitting it into per-concern effects would force the
  // chart object itself into a ref shared across effects for no gain.
  useEffect(() => {
    const container = containerRef.current!;
    const underCanvas = underRef.current!;
    const overCanvas = overRef.current!;
    const store = useLensStore;

    const chart = createChart(container, {
      // Transparent background: the under-canvas (claims layers) shows
      // through BENEATH candles; .chart-wrap provides the page color.
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#979083",
      },
      grid: {
        vertLines: { color: "#232120" },
        horzLines: { color: "#232120" },
      },
      rightPriceScale: { borderColor: "#35322c" },
      // Hidden: CVD is a divergence shape, not a level — its raw dollar
      // scale crowded the axis with 7-digit near-identical labels.
      leftPriceScale: { visible: false },
      timeScale: { borderColor: "#35322c", timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });

    const cvdSeries = chart.addLineSeries({
      priceScaleId: "left", color: COLORS.gold, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false, title: "CVD",
    });
    // Net positioning sits in its own band along the bottom on a private
    // scale: it is a -100..+100 lean, not a price and not a USD total, so
    // sharing either existing scale would flatten it into a straight line.
    const positioningSeries = chart.addLineSeries({
      priceScaleId: "positioning", color: "#8a7ac2", lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, title: "net L/S",
      priceFormat: { type: "custom", minMove: 0.01,
                     formatter: (value: number) =>
                       `${value >= 0 ? "+" : ""}${value.toFixed(0)}%` },
    });
    chart.priceScale("positioning").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 }, visible: false,
    });

    /* Both of these are bucketed to the displayed bar interval. They
       carry minute-resolution history, and Lightweight Charts shares ONE
       time axis across series: raw minutes put a slot on the axis per
       minute, so an hourly chart spread its candles apart to make room
       and showed enormous gaps between them. */
    function applyCvd(): void {
      const state = store.getState();
      const bucket = TF_SECONDS[state.timeframe];
      cvdSeries.setData(bucketSeries(state.cvd, bucket)
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }

    function applyPositioning(): void {
      const state = store.getState();
      const metric = pickPositioningMetric(state.positioning, state.positioningMetric);
      const points = metric ? state.positioning[metric] ?? [] : [];
      const bucket = TF_SECONDS[state.timeframe];
      positioningSeries.setData(bucketSeries(points, bucket)
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
      positioningSeries.applyOptions({
        visible: state.layers.positioning && points.length > 0,
      });
    }

    const maSeries = new Map<string, ISeriesApi<"Line">>(
      MA_DEFS.map((def) => [def.id, chart.addLineSeries({
        color: def.color, lineWidth: 1, visible: store.getState().maVisible[def.id],
        priceLineVisible: false, lastValueVisible: false,
      })]),
    );

    let priceSeries = makePriceSeries(chart, store.getState().chartStyle);
    let vwapLine: IPriceLine | null = null;
    let dayLines: IPriceLine[] = [];
    let dayLevels: DayLevels | null = null;

    function applyPriceData(): void {
      const { candleRows, chartStyle, layers } = store.getState();
      priceSeries.setData(styledRows(candleRows, chartStyle) as never);
      priceSeries.applyOptions({ visible: layers.candles });
      for (const def of MA_DEFS) {
        maSeries.get(def.id)!.setData(
          computeMa(candleRows, def).map((p) => ({ ...p, time: p.time as UTCTimestamp })));
      }
    }

    /* Price lines (VWAP, day levels) are anchored to the price series, so
       a style switch that rebuilds the series must re-anchor them. */
    function anchorDayLines(): void {
      dayLines.forEach((line) => { try { priceSeries.removePriceLine(line); } catch { /* swapped */ } });
      dayLines = [];
      if (!store.getState().layers.levels || dayLevels === null) return;
      const { prev, today } = dayLevels;
      for (const [title, value, color] of [
        ["PDH", prev.high, "#8a8377"], ["PDL", prev.low, "#8a8377"],
        ["PDC", prev.close, "#6d675e"], ["O", today.open, "#7fae93"],
      ] as const) {
        dayLines.push(priceSeries.createPriceLine({
          price: value, color, lineWidth: 1, lineStyle: LineStyle.SparseDotted,
          axisLabelVisible: true, title,
        }));
      }
    }

    function updateVwapLine(): void {
      const { depth, layers } = store.getState();
      const vwap = depth?.vwap ?? null;
      if (!layers.vwap || vwap === null) {
        if (vwapLine !== null) { priceSeries.removePriceLine(vwapLine); vwapLine = null; }
        return;
      }
      if (vwapLine === null) {
        vwapLine = priceSeries.createPriceLine({
          price: vwap, color: COLORS.gold, lineWidth: 1,
          lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "VWAP",
        });
      } else {
        vwapLine.applyOptions({ price: vwap });
      }
    }

    function rebuildPriceSeries(): void {
      vwapLine = null;   // price lines die with their series
      dayLines = [];
      chart.removeSeries(priceSeries as ISeriesApi<"Candlestick">);
      priceSeries = makePriceSeries(chart, store.getState().chartStyle);
      applyPriceData();
      anchorDayLines();
      updateVwapLine();
    }

    // ------------------------------------------------ day levels fetch
    // Keyed by symbol; token guard so a slow response for the previous
    // symbol can never draw its levels on the new chart.
    let dayLevelsToken = 0;
    async function loadDayLevels(): Promise<void> {
      const token = ++dayLevelsToken;
      const { symbol } = store.getState();
      dayLevels = null;
      anchorDayLines();
      try {
        const response = await fetch(`/klines?symbol=${symbol}&interval=1d&limit=2`);
        const rows: Candle[] = await response.json();
        if (token !== dayLevelsToken || !Array.isArray(rows) || rows.length < 2) return;
        dayLevels = { prev: rows[rows.length - 2], today: rows[rows.length - 1] };
        anchorDayLines();
      } catch { /* levels are decoration; fail quiet */ }
    }

    // --------------------------------------------------- overlay loop
    let dirty = true;
    let lastDrawAt = 0;
    let rafId = 0;
    let canvasW = 0, canvasH = 0;

    function sizeOrClear(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D,
                         width: number, height: number): void {
      const pxW = Math.round(width * devicePixelRatio);
      const pxH = Math.round(height * devicePixelRatio);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;   // resizing clears implicitly
        canvas.height = pxH;
      }
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
    }

    function drawOverlays(): void {
      const rect = underCanvas.getBoundingClientRect();
      canvasW = rect.width; canvasH = rect.height;
      const under = underCanvas.getContext("2d")!;
      const over = overCanvas.getContext("2d")!;
      sizeOrClear(underCanvas, under, canvasW, canvasH);
      sizeOrClear(overCanvas, over, canvasW, canvasH);

      const state = store.getState();
      const timeScale = chart.timeScale();
      const env: DrawEnv = {
        under, over, width: canvasW, height: canvasH,
        priceToY: (price) => priceSeries.priceToCoordinate(price),
        timeToX: (time) => timeScale.timeToCoordinate(time as UTCTimestamp),
      };
      if (state.layers.liqmap && state.liqMap.length) drawLiqMap(env, state.liqMap);
      if (state.layers.heat && state.heat.length) drawHeat(env, state.heat);
      if (state.layers.walls && state.depth?.walls) drawWallLines(env, state.depth, state.heat);
      if (state.layers.profile && state.depth) drawProfile(env, state.depth);
      if (state.layers.depth && state.depth) drawDepth(env, state.depth);
      if (state.layers.trades) {
        const visible = state.activeVenues === null ? state.trades
          : state.trades.filter((t) => state.activeVenues!.includes(t.venue));
        drawBubbles(env, visible, currentThreshold(state), state.timeframe);
      }
      if (state.layers.liqs && state.liqs.length) {
        drawLiqPrints(env, state.liqs, state.timeframe);
      }
      drawHunterLayers(env, state);
    }

    /* The Liquidation Hunter set. Everything here derives from the candle
       rows already on screen, so it is recomputed only when those change
       (see hunterCache) rather than on every animation frame — the pivot
       and squeeze passes walk the whole series. */
    let hunterCache: { rows: Candle[]; value: HunterFrame } | null = null;

    function hunterFrame(rows: Candle[]): HunterFrame {
      if (hunterCache && hunterCache.rows === rows) return hunterCache.value;
      const value = computeHunter(rows, QLH_SETTINGS);
      hunterCache = { rows, value };
      return value;
    }

    function drawHunterLayers(env: DrawEnv, state: ReturnType<typeof store.getState>): void {
      const layers = state.layers;
      const needsHunter = layers.stopClusters || layers.sweeps || layers.absorption
        || layers.exhaustion || layers.squeeze || layers.priceExtreme
        || layers.volumeNodes || layers.roundNumbers;
      const rows = state.candleRows;
      if (!needsHunter || rows.length === 0) {
        // The value-area and grid layers do not need the hunter pass.
        drawStandaloneHunterLayers(env, state);
        return;
      }
      const hunter = hunterFrame(rows);
      if (layers.squeeze && hunter.squeezeNow) {
        drawRegimeTint(env, "rgba(201,163,90,0.055)");
      }
      if (layers.priceExtreme && hunter.priceExtreme) {
        drawRegimeTint(env, "rgba(255,60,60,0.05)");
      }
      if (layers.roundNumbers) drawRoundLevels(env, hunter.roundLevels);
      if (layers.volumeNodes) drawVolumeNodes(env, hunter.volumeNodes);
      if (layers.stopClusters) {
        drawStopClusters(env, hunter.clusters, rows.map((row) => row.time));
      }
      if (layers.sweeps) drawSweeps(env, hunter.sweeps);
      if (layers.absorption) drawEventMarks(env, hunter.absorptions, "diamond", "201,163,90");
      if (layers.exhaustion) drawEventMarks(env, hunter.exhaustions, "cross", "255,80,80");
      drawStandaloneHunterLayers(env, state);
    }

    function drawStandaloneHunterLayers(
      env: DrawEnv, state: ReturnType<typeof store.getState>,
    ): void {
      // Both of these read our measured data rather than a candle proxy.
      if (state.layers.liqGrid && state.depth?.vwap) {
        drawLiqGrid(env, state.depth.vwap, QLH_SETTINGS.liqGridShown);
      }
      if (state.layers.poc && state.depth) {
        const area = valueAreaFromProfile(state.depth.profile ?? [], 70);
        drawValueArea(env, area.poc, area.vah, area.val);
      }
    }

    function frame(now: number): void {
      if (dirty || now - lastDrawAt > REDRAW_EVERY_MS) {
        dirty = false;
        lastDrawAt = now;
        drawOverlays();
      }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    const markDirty = (): void => { dirty = true; };

    // ------------------------------------------- history backfill
    // Panning near the left edge fetches the next 1000 older bars
    // (server passes endTime through to the venue), merged underneath.
    // The initial load is a window, not the limit of history.
    let loadingOlder = false;
    let historyExhausted = false;
    async function loadOlderCandles(): Promise<void> {
      if (loadingOlder || historyExhausted) return;
      const { candleRows, symbol, timeframe } = store.getState();
      const oldest = candleRows[0];
      if (!oldest) return;
      loadingOlder = true;
      try {
        const response = await fetch(
          `/klines?symbol=${symbol}&interval=${timeframe}` +
          `&limit=1000&endTime=${oldest.time * 1000 - 1}`);
        const rows: Candle[] = await response.json();
        if (!Array.isArray(rows) || rows.length === 0) {
          historyExhausted = true;
          return;
        }
        const state = store.getState();
        if (state.symbol !== symbol || state.timeframe !== timeframe) return;
        state.setCandleRows(mergeCandles(rows, state.candleRows));
      } catch { /* transient; the next pan retries */ }
      finally { loadingOlder = false; }
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      markDirty(); // pan/zoom repaints overlays
      if (range !== null && range.from < 30) loadOlderCandles();
    });

    // ------------------------------------------------------ crosshair
    chart.subscribeCrosshairMove((param) => {
      const { depth } = store.getState();
      if (!param.point || !depth) {
        if (store.getState().readout !== null) store.getState().setReadout(null);
        return;
      }
      const price = priceSeries.coordinateToPrice(param.point.y);
      if (price === null) return;
      const bin = depth.bin || 1;
      const snapped = Math.floor(price / bin) * bin;
      const near = (rows: [number, number][]) =>
        rows.find(([p]) => Math.abs(p - snapped) < bin / 2) ?? null;
      const bid = near(depth.bids);
      const ask = near(depth.asks);
      const traded = depth.profile.find(([p]) => Math.abs(p - snapped) < bin / 2) ?? null;
      const readout: ReadoutData = {
        price: snapped,
        bidUsd: bid ? bid[1] : null,
        askUsd: ask ? ask[1] : null,
        tradedUsd: traded ? traded[1] + traded[2] : null,
        buySharePct: traded
          ? Math.round((100 * traded[1]) / Math.max(traded[1] + traded[2], 1))
          : null,
      };
      store.getState().setReadout(readout);
    });

    // ----------------------------------------------------- PNG export
    registerChartExporter(() => {
      const shot = chart.takeScreenshot();
      const merged = document.createElement("canvas");
      merged.width = shot.width;
      merged.height = shot.height;
      const mergedContext = merged.getContext("2d")!;
      mergedContext.drawImage(shot, 0, 0);
      mergedContext.drawImage(overCanvas, 0, 0, shot.width, shot.height);
      merged.toBlob((blob) => {
        if (!blob) return;
        const { symbol, timeframe } = store.getState();
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `lens-${symbol}-${timeframe}.png`;
        link.click();
        URL.revokeObjectURL(link.href);
      });
    });

    // ------------------------------------------- transient subscriptions
    const unsubscribers = [
      store.subscribe((s) => s.candleRows, () => { applyPriceData(); markDirty(); }),
      store.subscribe((s) => s.chartStyle, rebuildPriceSeries),
      store.subscribe((s) => s.cvd, applyCvd),
      store.subscribe((s) => s.timeframe, () => { applyCvd(); applyPositioning(); }),
      store.subscribe((s) => s.layers.candles, (on) => priceSeries.applyOptions({ visible: on })),
      store.subscribe((s) => s.layers.cvd, (on) => cvdSeries.applyOptions({ visible: on })),
      store.subscribe((s) => s.positioning, applyPositioning),
      store.subscribe((s) => s.positioningMetric, applyPositioning),
      store.subscribe((s) => s.layers.positioning, applyPositioning),
      store.subscribe((s) => s.layers.vwap, updateVwapLine),
      store.subscribe((s) => s.depth?.vwap ?? null, updateVwapLine),
      store.subscribe((s) => s.layers.levels, anchorDayLines),
      store.subscribe((s) => s.maVisible, (visible) => {
        for (const def of MA_DEFS) {
          maSeries.get(def.id)!.applyOptions({ visible: visible[def.id] });
        }
      }),
      store.subscribe((s) => s.symbol, () => {
        historyExhausted = false;
        loadDayLevels();
        chart.timeScale().scrollToRealTime();
      }),
      store.subscribe((s) => s.timeframe, () => { historyExhausted = false; }),
      // Redraw triggers for the overlay planes.
      store.subscribe((s) => s.depth, markDirty),
      store.subscribe((s) => s.heat, markDirty),
      store.subscribe((s) => s.trades, markDirty),
      store.subscribe((s) => s.liqs, markDirty),
      store.subscribe((s) => s.liqMap, markDirty),
      store.subscribe((s) => s.layers, markDirty),
      store.subscribe((s) => s.thresholdMult, markDirty),
      store.subscribe((s) => s.timeframe, markDirty),
      store.subscribe((s) => s.activeVenues, markDirty),
    ];

    cvdSeries.applyOptions({ visible: store.getState().layers.cvd });
    applyCvd();
    applyPositioning();
    applyPriceData();
    loadDayLevels();

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      cancelAnimationFrame(rafId);
      registerChartExporter(null);
      chart.remove();
    };
  }, []);

  return (
    // The chart and its two overlay planes fill this box; the footer is a
    // sibling that sizes itself. The planes used to be inset by a
    // hard-coded footer height, which meant every control added to the
    // footer either overlapped it or silently ate chart space.
    <div className="chart-area">
      <canvas ref={underRef} id="under-overlay" />
      <div ref={containerRef} id="chart" />
      <canvas ref={overRef} id="overlay" />
    </div>
  );
}
