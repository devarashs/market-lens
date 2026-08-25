/** PNG-export seam between the footer button and the chart. The chart
    registers its exporter on mount; the button calls it. Avoids threading
    a ref through the page for one imperative action. */
let exporter: (() => void) | null = null;

export function registerChartExporter(fn: (() => void) | null): void {
  exporter = fn;
}

export function exportChartPng(): void {
  exporter?.();
}
