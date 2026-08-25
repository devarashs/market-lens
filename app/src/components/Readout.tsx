import { formatUsd } from "../lib/format";
import { useLensStore } from "../store/lens";

/** Crosshair price-level readout: resting size and traded volume at the
    hovered bin, fed by the chart's crosshair handler via the store. */
export function Readout() {
  const readout = useLensStore((s) => s.readout);

  if (!readout) {
    return <div className="readout muted">hover the chart to inspect a price level</div>;
  }
  return (
    <div className="readout">
      <b>@ {readout.price.toLocaleString()}</b>
      {readout.bidUsd !== null && (
        <> · resting <b className="buy-c">${formatUsd(readout.bidUsd)} bid</b></>
      )}
      {readout.askUsd !== null && (
        <> · resting <b className="sell-c">${formatUsd(readout.askUsd)} ask</b></>
      )}
      {readout.bidUsd === null && readout.askUsd === null && (
        <> · <span className="muted">no resting size</span></>
      )}
      {readout.tradedUsd !== null && (
        <> · traded <b>${formatUsd(readout.tradedUsd)}</b> ({readout.buySharePct}% buy)</>
      )}
    </div>
  );
}
