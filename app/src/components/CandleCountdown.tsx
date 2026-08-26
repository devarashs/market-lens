import { useEffect, useState } from "react";

import { formatCountdown, secondsUntilClose } from "../lib/candleClock";
import { TF_SECONDS } from "../lib/config";
import { useLensStore } from "../store/lens";

/** Time left in the open candle, pinned to the chart's top-right — the
    TradingView countdown. Ticks four times a second but only re-renders
    when the displayed second actually changes, so the boundary lands
    crisply without a render loop. */
export function CandleCountdown() {
  const timeframe = useLensStore((s) => s.timeframe);
  const interval = TF_SECONDS[timeframe];
  const [remaining, setRemaining] = useState(
    () => secondsUntilClose(interval, Date.now()));

  useEffect(() => {
    function tick() {
      // Recomputed from the wall clock every tick rather than decremented,
      // so a throttled background tab resumes on the right second.
      setRemaining(secondsUntilClose(interval, Date.now()));
    }
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [interval]);

  if (interval <= 1) return null; // a 1s bar has nothing worth counting

  return (
    <div className={`candle-countdown${remaining <= 10 ? " closing" : ""}`}
         title={`Time left in the current ${timeframe} candle`}>
      <span className="muted">{timeframe}</span>
      <b>{formatCountdown(remaining)}</b>
    </div>
  );
}
