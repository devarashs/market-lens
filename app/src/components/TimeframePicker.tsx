/* Timeframe control: the frames a chart actually gets left on as pills,
   and all sixteen behind a grouped menu.

   Sixteen buttons in a row is a wall, and it pushed the header into a
   second line on narrow screens — but hiding the everyday frames behind a
   click is worse than the wall. So both: pills for the six, a menu for the
   rest, and the menu marks whichever frame is current even when it is not
   a pill, so the control never lies about what you are looking at.

   Intervals unavailable for the symbol (Hyperliquid serves neither 1s nor
   6h) render disabled with the reason on hover rather than vanishing —
   a control that changes shape per symbol is harder to learn than one
   that greys out. */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  QUICK_TIMEFRAMES, TIMEFRAME_GROUPS, timeframeAvailable,
  type Symbol, type Timeframe,
} from "../lib/config";

export function TimeframePicker({ symbol, timeframe }: {
  symbol: Symbol; timeframe: Timeframe;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  // Close on outside click, so the menu never strands itself open.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(frame: Timeframe) {
    setOpen(false);
    navigate(`/${symbol}/${frame}`);
  }

  // Surfaced as a pill when it is one, so "more" never shows the active
  // frame twice — and shows the current frame when it is not.
  const activeIsQuick = QUICK_TIMEFRAMES.includes(timeframe);

  return (
    <div className="tf-picker" ref={container}>
      <nav id="timeframes" aria-label="Timeframes">
        {QUICK_TIMEFRAMES.map((frame) => (
          <button
            key={frame}
            className={frame === timeframe ? "active" : ""}
            disabled={!timeframeAvailable(symbol, frame)}
            onClick={() => choose(frame)}
          >
            {frame}
          </button>
        ))}
        <button
          className={`tf-more${!activeIsQuick ? " active" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="All timeframes"
          onClick={() => setOpen((was) => !was)}
        >
          {activeIsQuick ? "more" : timeframe}
          <span aria-hidden="true"> ▾</span>
        </button>
      </nav>

      {open && (
        <div className="tf-menu" role="listbox" aria-label="All timeframes">
          {TIMEFRAME_GROUPS.map((group) => (
            <div key={group.label} className="tf-group">
              <div className="tf-group-label muted">{group.label}</div>
              <div className="tf-grid">
                {group.frames.map((frame) => {
                  const available = timeframeAvailable(symbol, frame);
                  return (
                    <button
                      key={frame}
                      role="option"
                      aria-selected={frame === timeframe}
                      className={frame === timeframe ? "active" : ""}
                      disabled={!available}
                      title={available ? undefined
                        : `${frame} is not published for ${symbol}`}
                      onClick={() => choose(frame)}
                    >
                      {frame}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
