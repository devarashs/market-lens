import { useEffect, useMemo, useRef, useState } from "react";

/* A searchable multi-select, used for every "which of these do I want on"
   control: chart layers, venues, moving averages.

   Replaces three rows of checkboxes. Those were fine at six layers and
   unreadable at twenty-plus — the footer had already started wrapping
   into the chart. Searching beats scanning once a list stops fitting on
   one line. */

export interface FilterOption {
  key: string;
  label: string;
  /** Optional grouping header, rendered above the first item of each run. */
  group?: string;
  /** Longer text that search should also match. */
  hint?: string;
  /** A swatch for MA colours; omitted elsewhere. */
  color?: string;
}

export function matchesQuery(option: FilterOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return option.label.toLowerCase().includes(q)
    || option.key.toLowerCase().includes(q)
    || (option.hint?.toLowerCase().includes(q) ?? false)
    || (option.group?.toLowerCase().includes(q) ?? false);
}

export function FilterMenu({ title, options, selected, onToggle, onSetAll }: {
  title: string;
  options: FilterOption[];
  selected: ReadonlySet<string>;
  onToggle(key: string, on: boolean): void;
  onSetAll?(on: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => options.filter((option) => matchesQuery(option, query)),
    [options, query],
  );

  useEffect(() => {
    if (!open) { setQuery(""); return; }
    input.current?.focus();
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

  let lastGroup: string | undefined;
  const activeCount = options.filter((option) => selected.has(option.key)).length;

  return (
    <div className="filter-menu" ref={container}>
      <button className="mini-btn" onClick={() => setOpen((was) => !was)}
              aria-expanded={open} aria-haspopup="listbox">
        {title} <b>{activeCount}</b>/{options.length} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="filter-panel" role="listbox">
          <input
            ref={input}
            className="symbol-search"
            placeholder={`Search ${title.toLowerCase()}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {onSetAll && (
            <div className="filter-actions">
              <button className="mini-btn" onClick={() => onSetAll(true)}>all</button>
              <button className="mini-btn" onClick={() => onSetAll(false)}>none</button>
            </div>
          )}
          <div className="filter-list">
            {visible.length === 0 && <p className="muted small empty">No match.</p>}
            {visible.map((option) => {
              const header = option.group && option.group !== lastGroup
                ? option.group : null;
              lastGroup = option.group;
              return (
                <div key={option.key}>
                  {header && <div className="symbol-group muted">{header}</div>}
                  <label className="filter-row">
                    <input
                      type="checkbox"
                      checked={selected.has(option.key)}
                      onChange={(event) => onToggle(option.key, event.target.checked)}
                    />
                    {option.color && (
                      <span className="swatch" style={{ background: option.color }} />
                    )}
                    <span className="filter-label">{option.label}</span>
                    {option.hint && <span className="muted filter-hint">{option.hint}</span>}
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
