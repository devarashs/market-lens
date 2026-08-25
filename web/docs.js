/* Docs renderer: sidebar nav, hash deep links (/docs#readers), and live
   client-side search with term highlighting. Content lives in
   docs-content.js as HTML sections; the search index is their stripped
   text, built once at load. */

const nav = document.getElementById("docs-nav");
const content = document.getElementById("docs-content");
const searchBox = document.getElementById("docs-search");

const index = DOCS.map((section) => {
  const scratch = document.createElement("div");
  scratch.innerHTML = section.body;
  return { ...section, text: (section.title + " " + scratch.textContent).toLowerCase() };
});

function render(filter = "") {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = terms.length
    ? index.filter((s) => terms.every((t) => s.text.includes(t)))
    : index;

  nav.innerHTML = visible.map((s) =>
    `<a href="#${s.id}" data-id="${s.id}">${s.title}</a>`).join("")
    + (visible.length === 0 ? `<p class="muted">no matches</p>` : "");

  content.innerHTML = visible.map((s) =>
    `<section id="${s.id}"><h2>${s.title}</h2>${s.body}</section>`).join("")
    || `<p class="muted">Nothing matches “${filter}”.</p>`;

  if (terms.length) highlight(terms);
  markActive();
}

function highlight(terms) {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest("pre, code")) continue;
    if (terms.some((t) => node.textContent.toLowerCase().includes(t))) targets.push(node);
  }
  for (const node of targets) {
    const pattern = new RegExp(`(${terms.map(t =>
      t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    const span = document.createElement("span");
    span.innerHTML = node.textContent.replace(pattern, "<mark>$1</mark>");
    node.replaceWith(span);
  }
}

function markActive() {
  const id = location.hash.slice(1) || (index[0] && index[0].id);
  nav.querySelectorAll("a").forEach((a) =>
    a.classList.toggle("active", a.dataset.id === id));
}

searchBox.addEventListener("input", () => render(searchBox.value));
window.addEventListener("hashchange", markActive);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && event.target !== searchBox) {
    event.preventDefault();
    searchBox.focus();
    searchBox.select();
  }
  if (event.key === "Escape" && event.target === searchBox) {
    searchBox.value = "";
    render();
    searchBox.blur();
  }
});

render();
if (location.hash) {
  document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
