import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  ASSET_CLASSES, ASSET_CLASS_LABELS, SYMBOL_META, SYMBOL_NAMES,
  type AssetClass, type Symbol,
} from "../lib/config";
import { formatPrice } from "../lib/format";
import { useLensStore } from "../store/lens";

/** Rank a symbol against a query: exact ticker beats prefix beats a hit
    in the long name, so typing "me" puts META above UNITREE. Returns null
    when it does not match at all. */
export function matchScore(key: string, name: string | undefined,
                           query: string): number | null {
  const q = query.trim().toUpperCase();
  if (!q) return 0;
  const ticker = key.toUpperCase();
  if (ticker === q) return 0;
  if (ticker.startsWith(q)) return 1;
  if (ticker.includes(q)) return 2;
  if (name && name.toUpperCase().includes(q)) return 3;
  return null;
}

interface Row {
  key: Symbol;
  cls: AssetClass;
  name?: string;
}

export function SymbolPicker() {
  const navigate = useNavigate();
  const symbol = useLensStore((s) => s.symbol);
  const timeframe = useLensStore((s) => s.timeframe);
  const metrics = useLensStore((s) => s.metrics);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const rows = useMemo<Row[]>(() => {
    const scored = SYMBOL_META
      .map((meta) => ({
        row: { key: meta.key, cls: meta.cls, name: SYMBOL_NAMES[meta.key] } as Row,
        score: matchScore(meta.key, SYMBOL_NAMES[meta.key], query),
      }))
      .filter((entry) => entry.score !== null);
    // Group by asset class for browsing; within a group, best match first,
    // then the registry's own order (which is roughly by liquidity).
    return ASSET_CLASSES.flatMap((cls) =>
      scored.filter((entry) => entry.row.cls === cls)
        .sort((a, b) => (a.score as number) - (b.score as number))
        .map((entry) => entry.row));
  }, [query]);

  useEffect(() => setActive(0), [query]);

  // Close on outside click, so the picker never strands itself open.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // "/" opens the picker from anywhere — the search shortcut people expect.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
      if (event.key === "/") {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
    else setQuery("");
  }, [open]);

  function choose(key: Symbol) {
    setOpen(false);
    navigate(`/${key}/${timeframe}`);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + step + rows.length) % Math.max(1, rows.length));
      return;
    }
    if (event.key === "Enter" && rows[active]) {
      event.preventDefault();
      choose(rows[active].key);
    }
  }

  const change = metrics[symbol]?.change24h;
  let lastClass: AssetClass | null = null;

  return (
    <div className="symbol-picker" ref={container}>
      <button className="symbol-current" onClick={() => setOpen((was) => !was)}
              aria-haspopup="listbox" aria-expanded={open}
              title="Change symbol (press / to search)">
        <b>{symbol}</b>
        {change !== undefined && (
          <small className={change >= 0 ? "buy-c" : "sell-c"} title="24h change">
            {change >= 0 ? "+" : ""}{change.toFixed(1)}%
          </small>
        )}
        <span className="caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="symbol-menu" role="listbox">
          <input
            ref={input}
            className="symbol-search"
            placeholder="Search symbol or name…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="symbol-legend muted" aria-hidden="true">
            <span />
            <span />
            <span className="px">price</span>
            <span className="chg">24h</span>
          </div>
          <div className="symbol-list">
            {rows.length === 0 && <p className="muted small empty">No match.</p>}
            {rows.map((row, index) => {
              const header = row.cls !== lastClass ? row.cls : null;
              lastClass = row.cls;
              const rowChange = metrics[row.key]?.change24h;
              const rowLast = metrics[row.key]?.last;
              return (
                <div key={row.key}>
                  {header && (
                    <div className="symbol-group muted">{ASSET_CLASS_LABELS[header]}</div>
                  )}
                  {/* A real anchor: middle-click and ctrl-click open a new
                      tab, exactly as the old pills did. */}
                  <Link
                    to={`/${row.key}/${timeframe}`}
                    className={`symbol-option${index === active ? " active" : ""}` +
                      `${row.key === symbol ? " current" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => setOpen(false)}
                    role="option"
                    aria-selected={row.key === symbol}
                  >
                    <b>{row.key}</b>
                    <span className="muted name">{row.name ?? ""}</span>
                    <span className="px">
                      {rowLast !== undefined ? formatPrice(rowLast) : ""}
                    </span>
                    <span className={"chg " + (rowChange === undefined ? ""
                      : rowChange >= 0 ? "buy-c" : "sell-c")}>
                      {rowChange === undefined ? ""
                        : `${rowChange >= 0 ? "+" : ""}${rowChange.toFixed(1)}%`}
                    </span>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
