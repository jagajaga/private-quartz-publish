// Private-Quartz find widget — top-left search bar.
//
// Always-visible compact search bar at top-left of every published page.
// Self-contained, no deps. Reads only the index for the folder you are
// already in (or none); no site-wide search; no telemetry.
//
// Modes:
//   "this page"   in-page text find. Walks text nodes, wraps matches in
//                 <mark class="pf-hit">. Enter / Shift+Enter steps next/prev.
//   "this folder" substring search over /<folder-slug>/_search.json
//                 (slug + title + snippet). Tab hidden when not in a bundle.
//
// SPA: Quartz's micromorph router rewrites document.body on every internal
// navigation, stripping any JS-appended nodes. `build()` is idempotent and
// re-runs on the "nav" CustomEvent Quartz dispatches.
(() => {
  if (window.__pfFindLoaded) return;
  window.__pfFindLoaded = true;

  const $ = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const k of kids) e.append(k && k.nodeType ? k : document.createTextNode(k ?? ""));
    return e;
  };

  // First URL segment is either a standalone file slug or a folder-bundle
  // slug. Either way: if /<seg>/_search.json exists, this page is part of a
  // bundle and folder-mode is available. Recomputed on each SPA nav.
  function currentFolderSlug() {
    const segs = location.pathname.split("/").filter(Boolean);
    return segs[0] && /^[A-Za-z0-9]{6,32}$/.test(segs[0]) ? segs[0] : null;
  }
  let folderSlug = currentFolderSlug();

  let mode = "page";
  let hits = [];
  let hitIdx = 0;
  let folderIndex = null;
  let folderTried = false;

  // Uses Quartz's own theme variables (--light, --lightgray, --gray, --dark,
  // --secondary, --textHighlight, --bodyFont) so the field matches the site
  // and auto-follows the light/dark toggle. 5px radius is the Quartz convention.
  const css = `
    /* Align the field's right edge with the centered page container (max
       1500px, margin auto) so it sits a bit in from the viewport edge —
       symmetric with the dark-mode / reader-mode controls on the page's
       left edge. On screens <= 1500px it falls back to a small fixed inset. */
    #pf-bar { position: fixed; top: 0.6rem;
      right: max(0.6rem, calc((100vw - 1500px) / 2 + 0.6rem));
      z-index: 1000;
      width: 15rem;
      font-family: var(--bodyFont, system-ui), system-ui, sans-serif;
      font-size: 0.85rem; }
    #pf-bar header { display: flex; align-items: center; gap: 0.35rem;
      height: 2.1rem; padding: 0 0.55rem;
      background: var(--lightgray, #e5e5e5); color: var(--dark, #2b2b2b);
      border-radius: 5px; transition: background 0.15s; }
    #pf-bar header::before { content: "⌕"; font-size: 0.95rem;
      color: var(--gray, #b8b8b8); flex: 0 0 auto; }
    #pf-bar.is-active header { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
    #pf-bar input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0;
      background: transparent; color: inherit; font: inherit; padding: 0; }
    #pf-bar input::placeholder { color: var(--gray, #b8b8b8); }
    #pf-bar .pf-expand { display: none; flex-direction: column;
      background: var(--light, #faf8f8);
      border: 1px solid var(--lightgray, #e5e5e5); border-top: 0;
      border-radius: 0 0 5px 5px; overflow: hidden; }
    #pf-bar.is-active .pf-expand { display: flex; }
    #pf-tabs { display: flex; gap: 0.25rem; padding: 0.4rem 0.5rem 0.1rem; }
    #pf-tabs button { font: inherit; font-size: 0.75rem; color: var(--gray, #b8b8b8);
      padding: 0.1rem 0.45rem; border: 1px solid transparent; border-radius: 4px;
      background: transparent; cursor: pointer; }
    #pf-tabs button.active { color: var(--secondary, #284b63);
      border-color: var(--secondary, #284b63); }
    #pf-status { display: flex; align-items: center; gap: 0.4rem;
      padding: 0.35rem 0.6rem; font-size: 0.75rem; color: var(--gray, #b8b8b8); }
    #pf-status .pf-step { margin-left: auto; display: flex; gap: 0.2rem; }
    #pf-status .pf-step button { font: inherit; color: var(--darkgray, #4e4e4e);
      border: 1px solid var(--lightgray, #e5e5e5); background: transparent;
      border-radius: 4px; cursor: pointer; padding: 0 0.4rem; line-height: 1.4; }
    #pf-status .pf-step button:hover { color: var(--secondary, #284b63); }
    #pf-results { overflow: auto; max-height: 50vh; }
    #pf-results a { display: block; padding: 0.4rem 0.6rem; color: var(--darkgray, #4e4e4e);
      text-decoration: none; border-top: 1px solid var(--lightgray, #e5e5e5); }
    #pf-results a:hover { background: var(--highlight, rgba(143,159,169,.15)); }
    #pf-results .pf-title { font-weight: 600; color: var(--dark, #2b2b2b); }
    #pf-results .pf-snip { font-size: 0.72rem; margin-top: 0.1rem; color: var(--gray, #b8b8b8);
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    article mark.pf-hit { background: var(--textHighlight, #fff23688); color: inherit;
      padding: 0 1px; border-radius: 2px; }
    article mark.pf-hit.pf-current { outline: 2px solid var(--secondary, #284b63); }
    @media (max-width: 800px) {
      #pf-bar { width: calc(100vw - 1.2rem); }
    }
  `;

  function ensureStyle() {
    if (document.getElementById("pf-style")) return;
    document.head.appendChild($("style", { id: "pf-style" }, css));
  }

  let bar, input, tabPage, tabFolder, tabsRow, statusText, stepBox, resultsEl;

  function ensureBar() {
    if (bar && document.body.contains(bar)) return;
    bar = null;
    input = $("input", {
      type: "search",
      placeholder: "Search this page…",
      autocomplete: "off",
      spellcheck: "false",
      oninput: onInput,
      onkeydown: onInputKey,
    });
    tabPage = $("button", { class: "active", type: "button", onclick: () => setMode("page") }, "this page");
    tabFolder = $("button", { type: "button", onclick: () => setMode("folder") }, "this folder");
    // Tabs only make sense on a real folder bundle. Hidden by default; the
    // index probe in build() reveals them only when _search.json resolves.
    tabsRow = $("div", { id: "pf-tabs" }, tabPage, tabFolder);
    tabsRow.style.display = "none";
    statusText = $("span", {}, "");
    const prevBtn = $("button", { type: "button", title: "Previous (Shift+Enter)", onclick: () => step(-1) }, "↑");
    const nextBtn = $("button", { type: "button", title: "Next (Enter)", onclick: () => step(1) }, "↓");
    stepBox = $("span", { class: "pf-step" }, prevBtn, nextBtn);
    const statusEl = $("div", { id: "pf-status" }, statusText, stepBox);
    resultsEl = $("div", { id: "pf-results" });
    const expand = $("div", { class: "pf-expand" },
      tabsRow,
      statusEl,
      resultsEl,
    );
    bar = $("div", { id: "pf-bar" },
      $("header", {}, input),
      expand,
    );
    document.body.appendChild(bar);
  }

  function setMode(m) {
    if (m === "folder" && !folderSlug) return;
    mode = m;
    tabPage.classList.toggle("active", m === "page");
    tabFolder.classList.toggle("active", m === "folder");
    input.placeholder = m === "folder" ? "Search this folder…" : "Search this page…";
    clearHits();
    resultsEl.innerHTML = "";
    statusText.textContent = "";
    onInput();
  }

  // Show/hide the whole tab row. The folder tab only makes sense on a real
  // bundle; standalone pages (where the first URL segment is just a file
  // slug, with no _search.json) get no tabs at all — just the slim input.
  function setFolderAvailable(v) {
    if (tabsRow) tabsRow.style.display = v ? "" : "none";
    if (!v && mode === "folder") setMode("page");
  }

  async function loadFolderIndex() {
    if (folderIndex || folderTried) return folderIndex;
    folderTried = true;
    if (!folderSlug) { setFolderAvailable(false); return null; }
    try {
      const r = await fetch(`/${folderSlug}/_search.json`, { cache: "force-cache" });
      if (!r.ok) { setFolderAvailable(false); return null; }
      folderIndex = await r.json();
      setFolderAvailable(true);
    } catch { setFolderAvailable(false); }
    return folderIndex;
  }

  function clearHits() {
    for (const m of hits) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    }
    hits = [];
    hitIdx = 0;
    if (stepBox) stepBox.style.display = "none";
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Build a case-insensitive regex where every whitespace run in the query
  // matches any whitespace in the text. Markdown often joins words with a
  // newline inside one paragraph (e.g. "Марков\nГений" renders as one line),
  // so a literal space in the query must match that newline. Cyrillic case
  // folding is handled by the "i" flag.
  function buildQueryRegex(q) {
    const parts = q.trim().split(/\s+/).filter(Boolean).map(escapeRe);
    return new RegExp(parts.join("\\s+"), "gi");
  }

  function highlightInPage(q) {
    // Root at .center so the page TITLE (the file name, rendered in
    // .page-header outside <article>) is searchable too — not just the body.
    // Exclude the date/read-time metadata and footer to avoid noise matches.
    const root = document.querySelector(".center") ||
      document.querySelector("article") || document.querySelector("main") || document.body;
    const re = buildQueryRegex(q);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest("#pf-bar, script, style, noscript, .content-meta, .page-footer, footer"))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const t of targets) {
      const v = t.nodeValue;
      re.lastIndex = 0;
      if (!re.test(v)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = re.exec(v))) {
        if (m.index > last) frag.appendChild(document.createTextNode(v.slice(last, m.index)));
        const mk = document.createElement("mark");
        mk.className = "pf-hit";
        mk.textContent = m[0];
        frag.appendChild(mk);
        hits.push(mk);
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (last < v.length) frag.appendChild(document.createTextNode(v.slice(last)));
      const parent = t.parentNode;
      if (parent) parent.replaceChild(frag, t);
    }
  }

  function setCurrent(i) {
    if (!hits.length) return;
    hits.forEach((h, j) => h.classList.toggle("pf-current", j === i));
    hits[i].scrollIntoView({ block: "center", behavior: "smooth" });
    statusText.textContent = `${i + 1} of ${hits.length}`;
  }

  function step(dir) {
    if (!hits.length) return;
    hitIdx = (hitIdx + dir + hits.length) % hits.length;
    setCurrent(hitIdx);
  }

  let folderTimer = null;
  function onInput() {
    const q = (input && input.value || "").trim();
    // Expand only when there's something to show — empty input stays slim.
    if (bar) bar.classList.toggle("is-active", q.length > 0);
    if (mode === "page") {
      clearHits();
      if (!q || q.length < 2) { if (statusText) statusText.textContent = q ? "min 2 chars" : ""; return; }
      highlightInPage(q);
      if (hits.length) {
        hitIdx = 0;
        setCurrent(0);
        stepBox.style.display = "flex";
      } else {
        statusText.textContent = "no matches";
      }
    } else {
      clearTimeout(folderTimer);
      folderTimer = setTimeout(async () => {
        const idx = await loadFolderIndex();
        resultsEl.innerHTML = "";
        if (!idx) { statusText.textContent = "folder index unavailable"; return; }
        if (!q) { statusText.textContent = `${idx.length} files in folder`; return; }
        // AND-of-words: every whitespace-separated term must appear somewhere
        // in title+snippet. Word-order independent and spacing-tolerant.
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = [];
        for (const e of idx) {
          const hay = (e.title + " " + (e.snippet || "")).toLowerCase();
          if (terms.every((t) => hay.includes(t))) matches.push(e);
          if (matches.length >= 50) break;
        }
        statusText.textContent = matches.length
          ? `${matches.length} file${matches.length === 1 ? "" : "s"}`
          : "no matches";
        for (const m of matches) {
          resultsEl.appendChild($("a", { href: `/${folderSlug}/${m.slug}` },
            $("div", { class: "pf-title" }, m.title || m.slug),
            $("div", { class: "pf-snip" }, m.snippet || ""),
          ));
        }
      }, 120);
    }
  }

  function onInputKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      clearHits();
      if (resultsEl) resultsEl.innerHTML = "";
      if (statusText) statusText.textContent = "";
      if (bar) bar.classList.remove("is-active");
      input.blur();
      return;
    }
    if (mode !== "page") return;
    if (e.key === "Enter" && hits.length) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  }

  function build() {
    ensureStyle();
    const fresh = !bar || !document.body.contains(bar);
    ensureBar();
    // Recompute folder slug — SPA nav may have changed the URL out from under us.
    const next = currentFolderSlug();
    if (fresh || next !== folderSlug) {
      folderSlug = next;
      folderIndex = null;
      folderTried = false;
      if (mode === "folder") setMode("page");
      // Probe the folder index up front so the "this folder" tab is shown only
      // when this page is actually part of a bundle (not a standalone file).
      loadFolderIndex();
    }
  }

  document.addEventListener("keydown", (e) => {
    const inField = e.target && (
      e.target.matches?.("input, textarea, select") ||
      e.target.isContentEditable
    );
    if ((e.key === "/" && !inField) ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      ensureBar();
      input.focus();
      input.select();
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
  // Quartz SPA: re-attach after every internal navigation (micromorph
  // strips JS-appended nodes that aren't in the new server-rendered HTML).
  document.addEventListener("nav", build);
})();
