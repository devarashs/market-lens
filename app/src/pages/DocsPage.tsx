/* Docs: sidebar nav, hash deep links (/docs#readers), live search with
   term highlighting. Bodies are trusted static HTML from docs-content.ts
   (authored in-repo — the dangerouslySetInnerHTML is safe by construction
   and must never carry user input). */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { DOCS } from "./docs-content";

function stripHtml(html: string): string {
  const scratch = document.createElement("div");
  scratch.innerHTML = html;
  return scratch.textContent ?? "";
}

/** Wrap search terms in <mark> inside the rendered sections, skipping
    pre/code blocks. Runs against the real DOM after render — matching on
    text nodes, so terms split across tags are simply not highlighted
    (same tradeoff the original made). */
function highlightTerms(container: HTMLElement, terms: string[]): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("pre, code, mark")) continue;
    if (terms.some((term) => node.textContent?.toLowerCase().includes(term))) {
      targets.push(node);
    }
  }
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  for (const node of targets) {
    const span = document.createElement("span");
    span.innerHTML = (node.textContent ?? "").replace(pattern, "<mark>$1</mark>");
    node.replaceWith(span);
  }
}

export function DocsPage() {
  const [query, setQuery] = useState("");
  const location = useLocation();
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const index = useMemo(
    () => DOCS.map((section) => ({
      ...section,
      text: (section.title + " " + stripHtml(section.body)).toLowerCase(),
    })),
    [],
  );

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length
    ? index.filter((section) => terms.every((term) => section.text.includes(term)))
    : index;

  const activeId = location.hash.slice(1) || visible[0]?.id;

  useEffect(() => {
    document.title = "Docs — Market Lens";
  }, []);

  // Highlight after each render of the filtered sections. The sections are
  // re-rendered from source HTML on every query change (the key includes
  // the query), so stale <mark>s never accumulate.
  useEffect(() => {
    if (terms.length && contentRef.current) {
      highlightTerms(contentRef.current, terms);
    }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps -- terms derives from query

  // Deep link: scroll to the hash target once content exists.
  useEffect(() => {
    if (location.hash) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
    }
  }, [location.hash]);

  // "/" focuses search, Escape clears it — promised in the UI placeholder.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "/" && event.target !== searchRef.current) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === "Escape" && event.target === searchRef.current) {
        setQuery("");
        searchRef.current?.blur();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="docs-page">
      <header className="top">
        <h1>Market Lens — docs</h1>
        <input
          ref={searchRef}
          id="docs-search"
          type="search"
          placeholder='search the docs ("/" to focus)'
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Link className="mini-btn back-link" to="/">← back to the app</Link>
      </header>
      <div className="docs-layout">
        <nav className="docs-nav" aria-label="Documentation sections">
          {visible.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={section.id === activeId ? "active" : ""}
            >
              {section.title}
            </a>
          ))}
          {visible.length === 0 && <p className="muted">no matches</p>}
        </nav>
        <div className="docs-content" ref={contentRef}>
          {visible.map((section) => (
            <section key={`${section.id}-${query}`} id={section.id}>
              <h2>{section.title}</h2>
              <div dangerouslySetInnerHTML={{ __html: section.body }} />
            </section>
          ))}
          {visible.length === 0 && (
            <p className="muted">Nothing matches “{query}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}
