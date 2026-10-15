/* Search: a search field in the sidebar and a command palette (Cmd/Ctrl-K, or "/").
   People and photos come from GET /api/search (api_search.py); pages and actions are matched here.
   Enter opens the highlighted result; Shift-Enter shows a person in the family tree. */
(() => {
  const RECENT_KEY = "family-photo-explorer:recent-searches";
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
  const enc = encodeURIComponent;
  const fmt = n => Number(n || 0).toLocaleString();
  const plural = (k, one, many = one + "s") => (k === 1 ? one : many);
  const fold = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’‘`]/g, "");
  const toks = s => fold(s).match(/[\p{L}\p{N}]+/gu) || [];
  const editable = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    people: '<circle cx="12" cy="8" r="4.5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  };
  const svg = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const KEYWORDS = {
    home: "overview start progress dashboard next", groups: "name faces clusters unnamed look alike",
    leftovers: "leftover faces strong matches unmatched singles", people: "person everyone names list",
    map: "similarity look alikes lookalikes cloud", portraits: "average faces morph grow up video composite",
    tree: "family tree genealogy relatives parents children", gallery: "photos pictures browse album",
    imports: "inbox added batches new photos import",
    history: "undo changes backups", timeline: "dates years decades", suggest: "suggestions",
  };
  const ACTIONS = [
    { kind: "action", id: "import", title: "Process new photos", sub: "Import everything waiting in the Inbox", icon: ICONS.inbox,
      keywords: "import inbox add new scans upload process" },
    { kind: "action", id: "gedcom", title: "Export GEDCOM", sub: "Download the family tree as a GEDCOM file", icon: ICONS.download,
      keywords: "export download family tree gedcom ged genealogy file" },
    { kind: "action", id: "random", title: "Show a random photo", sub: "Open a captioned photo from the albums", icon: ICONS.shuffle,
      keywords: "random surprise shuffle photo album" },
  ];

  // ---------- markup ----------
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "search-trigger";
  trigger.setAttribute("aria-label", "Search people, photos and pages");
  trigger.setAttribute("aria-keyshortcuts", mac ? "Meta+K /" : "Control+K /");
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.innerHTML = `${svg(ICONS.search)}<span>Search</span><kbd>${mac ? "⌘K" : "Ctrl K"}</kbd>`;
  const brand = $(".side .brand");
  if (brand) brand.after(trigger);

  const dlg = document.createElement("dialog");
  dlg.className = "search-palette";
  dlg.id = "search-palette";
  dlg.setAttribute("aria-label", "Search");
  dlg.innerHTML = `<div class="sp-box">
    <div class="sp-field">${svg(ICONS.search)}
      <input id="sp-input" type="text" role="combobox" aria-expanded="true" aria-controls="sp-list" aria-autocomplete="list"
        aria-label="Search people, photos and pages" placeholder="Search people, captions, pages…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
      <button type="button" class="sp-close" aria-label="Close search">${svg(ICONS.x)}</button>
    </div>
    <div class="sp-list" id="sp-list" role="listbox" aria-label="Search results"></div>
    <p class="sp-status" role="status" aria-live="polite"></p>
    <div class="sp-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> Move</span><span><kbd>↵</kbd> Open</span>
      <span><kbd>⇧</kbd><kbd>↵</kbd> Show in family tree</span><span><kbd>Esc</kbd> Close</span></div>
  </div>`;
  document.body.appendChild(dlg);
  const input = $("#sp-input", dlg), list = $("#sp-list", dlg), status = $(".sp-status", dlg);

  let flat = [], active = -1, seq = 0, ctrl = null, imgTimer = null, statusTimer = null, lastQuery = null;
  const cache = new Map();

  // ---------- helpers ----------
  function mark(text, qt) {
    text = String(text ?? "");
    if (!qt.length) return esc(text);
    let out = "", last = 0;
    for (const m of text.matchAll(/[\p{L}\p{N}\p{M}'’‘`]+/gu)) {
      const word = m[0], f = fold(word);
      const t = qt.filter(q => f.startsWith(q)).sort((a, b) => b.length - a.length)[0];
      if (!t) continue;
      let n = 0, i = 0;   // map the folded prefix back to the original letters
      while (i < word.length && n < t.length) n += fold(word[i++]).length;
      while (i < word.length && /\p{M}/u.test(word[i])) i++;
      out += esc(text.slice(last, m.index)) + "<mark>" + esc(word.slice(0, i)) + "</mark>";
      last = m.index + i;
    }
    return out + esc(text.slice(last));
  }
  const ver = () => (S && S.v) || 0;
  const initials = name => esc(String(name).replace(/&quot;|["'()]/g, "").split(/\s+/).filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase());
  function years(p) {
    const b = String(p.born || "").trim(), d = String(p.died || "").trim();
    return b && d ? `${b}–${d}` : b ? `Born ${b}` : d ? `Died ${d}` : "";
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function niceDate(raw) {
    const m = String(raw || "").match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
    return m && +m[2] >= 1 && +m[2] <= 12 ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : String(raw || "").trim();
  }
  function recent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).slice(0, 6) : [];
    } catch { return []; }
  }
  function saveRecent(items) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(items)); } catch {} }
  function remember(q) { saveRecent([q, ...recent().filter(x => fold(x) !== fold(q))].slice(0, 6)); }

  function go(hash) {
    if (location.hash !== hash) history.pushState(null, "", hash);
    applyRoute();
    scrollTo(0, 0);
    if (S) person ? load() : render();
    setTimeout(() => window.focusMain?.(), 0);
  }
  const ready = () => new Promise(resolve => { const check = () => (S ? resolve() : setTimeout(check, 40)); check(); });

  function pages() {
    const tabs = [...document.querySelectorAll("nav#tabs [data-tab]")].map(b => ({
      kind: "page", tab: b.dataset.tab, title: TITLES[b.dataset.tab] || b.textContent.trim(),
      icon: b.querySelector("svg") ? b.querySelector("svg").innerHTML : ICONS.search,
      keywords: KEYWORDS[b.dataset.tab] || "", sub: "Page" }));
    return [...tabs, {kind: "page", tab: "people/_duplicates", title: "Possible duplicates",
      keywords: "duplicates merge same person", sub: "Page", icon: ICONS.people}, ...ACTIONS];
  }
  function matchPages(qt) {
    const qs = qt.join(" ");
    return pages().map(p => {
      const words = toks(p.title), key = words.join(" "), kw = toks(p.keywords);
      const tier = key === qs ? 4 : key.startsWith(qs) ? 3
        : qt.every(t => words.some(w => w.startsWith(t))) ? 2
        : qt.every(t => words.some(w => w.startsWith(t)) || kw.some(w => w.startsWith(t))) ? 1 : 0;
      return { ...p, tier: tier && tier + 0.5 };   // a page beats a person or photo matched just as well
    }).filter(p => p.tier).sort((a, b) => b.tier - a.tier).slice(0, 5);
  }

  // ---------- results ----------
  function groupsFor(q, data) {
    const qt = toks(q), groups = [];
    const people = data.people.items.map(p => ({ kind: "person", ...p }));
    if (people.length) {
      if (data.people.total > people.length && qt.length === 1)
        people.push({ kind: "more-people", q: qt[0], title: `Show all ${fmt(data.people.total)} matching names on the People page` });
      groups.push({ key: "people", title: "People", total: data.people.total, shown: data.people.items.length, items: people, top: Math.max(...data.people.items.map(p => p.tier || 0)), order: 0 });
    }
    const pg = matchPages(qt);
    if (pg.length) groups.push({ key: "pages", title: "Pages and actions", items: pg, top: pg[0].tier, order: 1 });
    const photos = data.photos.items.map(p => ({ kind: "photo", ...p }));
    if (photos.length) groups.push({ key: "photos", title: "Photos", total: data.photos.total, shown: photos.length, items: photos, top: photos[0].tier, order: 2 });
    groups.sort((a, b) => b.top - a.top || a.order - b.order);
    return groups;
  }
  function emptyGroups() {
    const groups = [], rec = recent();
    if (rec.length) groups.push({ key: "recent", title: "Recent searches",
      items: [...rec.map(q => ({ kind: "recent", q })), { kind: "clear-recent" }] });
    groups.push({ key: "pages", title: "Go to", items: pages() });
    return groups;
  }

  function avatar(it) {
    if (it.kind === "person") {
      if (it.rep != null) return `<img class="sp-av" src="/thumbs/${it.rep}.jpg?v=${ver()}" alt="" decoding="async">`;
      if (it.src) return `<img class="sp-av" data-src="/photos/${enc(it.src)}?v=${ver()}&thumbnail=1" alt="">`;
      return `<span class="sp-av sp-initials" aria-hidden="true">${initials(it.name)}</span>`;
    }
    if (it.kind === "photo") return `<img class="sp-av sp-photo" data-src="/gallery-image/${enc(it.path)}?v=${ver()}" alt="">`;
    const icon = it.kind === "recent" ? ICONS.clock : it.kind === "clear-recent" ? ICONS.x : it.kind === "more-people" ? ICONS.people : it.icon;
    return `<span class="sp-av sp-icon" aria-hidden="true">${svg(icon)}</span>`;
  }
  function row(it, i, qt) {
    let title, sub = "", hint;
    if (it.kind === "person") {
      const y = years(it);
      title = mark(it.name, qt);
      sub = [y ? `<span class="sp-yrs">${esc(y)}</span>` : "",
        it.photos ? `${fmt(it.photos)} ${plural(it.photos, "photo")}` : "No photos yet",
        it.alias ? `Also called ${mark(it.alias, qt)}` : "",
        !y && it.tree ? "In the family tree" : "", it.hidden ? "Only in FamilySearch tags" : ""].filter(Boolean).join(" · ");
      hint = "Open person";
    } else if (it.kind === "photo") {
      const file = it.path.split("/").pop();
      title = it.caption ? mark(it.caption, qt) : mark(file, qt);
      sub = [it.caption ? mark(file, qt) : "", esc(niceDate(it.date)), it.album ? "Album photo" : esc(it.source || "Imported"),
        it.faces ? `${it.faces} ${plural(it.faces, "face")}` : ""].filter(Boolean).join(" · ");
      hint = "Open photo";
    } else if (it.kind === "recent") { title = esc(it.q); hint = "Search"; }
    else if (it.kind === "clear-recent") { title = "Clear recent searches"; hint = "Clear"; }
    else if (it.kind === "more-people") { title = esc(it.title); hint = "Open People"; }
    else { title = mark(it.title, qt); sub = esc(it.sub || ""); hint = it.kind === "action" ? "Run" : "Go to"; }
    return `<div class="sp-item sp-k-${it.kind}" role="option" id="sp-opt-${i}" data-sp-i="${i}" aria-selected="false">
      ${avatar(it)}<span class="sp-text"><span class="sp-title">${title}</span>${sub ? `<span class="sp-sub">${sub}</span>` : ""}</span>
      <span class="sp-hint" aria-hidden="true">${hint} <kbd>↵</kbd></span></div>`;
  }
  function show(groups, q, error = "") {
    const qt = toks(q);
    flat = [];
    const html = groups.map(g => `<div class="sp-group" role="group" aria-labelledby="sp-g-${g.key}">
      <div class="sp-head" id="sp-g-${g.key}">${esc(g.title)}${g.total > g.shown ? `<span class="sp-count">${fmt(g.shown)} of ${fmt(g.total)}</span>` : ""}</div>
      ${g.items.map(it => row(it, flat.push(it) - 1, qt)).join("")}</div>`).join("");
    list.innerHTML = (error ? `<p class="sp-note" role="alert">${esc(error)}</p>` : "") + (html ||
      `<div class="sp-empty"><b>No matches for “${esc(q.trim())}”</b><span>Try a first name, a surname, or a word from a caption.</span></div>`);
    active = flat.length ? 0 : -1;
    paint();
    lastQuery = q;
    clearTimeout(imgTimer);   // photo previews load once the results stop changing
    imgTimer = setTimeout(() => list.querySelectorAll("img[data-src]").forEach(img => { img.src = img.dataset.src; img.removeAttribute("data-src"); }), 140);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      status.textContent = !qt.length ? "" : flat.length ? `${flat.length} ${plural(flat.length, "result")}. Use the up and down arrows to choose.` : "No results.";
    }, 400);
  }
  function paint(scroll = true) {
    list.querySelectorAll('[aria-selected="true"]').forEach(el => el.setAttribute("aria-selected", "false"));
    const el = active >= 0 && $(`#sp-opt-${active}`, list);
    if (el) {
      el.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", el.id);
      if (scroll) el.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  }
  function move(step) {
    if (!flat.length) return;
    active = (active + step + flat.length) % flat.length;
    paint();
  }

  function run() {
    const q = input.value, qt = toks(q);
    if (!qt.length) { seq++; if (ctrl) ctrl.abort(); return show(emptyGroups(), ""); }
    const key = qt.join(" ");
    if (cache.has(key)) { seq++; return show(groupsFor(q, cache.get(key)), q); }
    const my = ++seq;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    fetch(`/api/search?q=${enc(q)}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then(d => {
        if (!d.updating) cache.set(key, d);
        if (cache.size > 60) cache.delete(cache.keys().next().value);
        if (my === seq) show(groupsFor(q, d), q);
      })
      .catch(err => {
        if (err.name === "AbortError" || my !== seq) return;
        const none = { total: 0, items: [] };
        show(groupsFor(q, { people: none, photos: none }), q, "Couldn’t search people and photos. Check that the app is still running, then try again.");
      });
  }

  async function act(id) {
    if (id === "gedcom") {
      const a = document.createElement("a");
      a.href = "/family-tree.ged"; a.download = "family-tree.ged";
      document.body.appendChild(a); a.click(); a.remove();
      return toast("Downloading family-tree.ged");
    }
    if (id === "random") {
      try {
        const r = await (await fetch("/api/home/photos?n=1")).json();
        if (!r.photos || !r.photos.length) return toast("There are no captioned album photos yet.", true);
        await ready();
        return openPhotoPath(r.photos[0].path);
      } catch { return toast("Couldn’t pick a photo. Check that the app is still running, then try again.", true); }
    }
    if (id === "import") {
      let st;
      try { st = await (await fetch("/api/import")).json(); }
      catch { return toast("Couldn’t check the Inbox. Check that the app is still running, then try again.", true); }
      if (st.running) return toast("An import is already running. Progress shows in the sidebar.");
      if (!st.inbox) return toast(`The Inbox is empty. Drop photos into ${S?.inbox_path || "the Inbox folder"}, then try again.`, true);
      const r = await startImport();   // review.html: through the write queue; this tab opens the import when it's done
      if (r.error) return;
      return toast(`Importing ${fmt(st.inbox)} new ${plural(st.inbox, "photo")}. Progress shows in the sidebar.`);
    }
  }
  async function choose(i, alt = false) {
    const it = flat[i];
    if (!it) return;
    if (it.kind === "recent") { input.value = it.q; input.focus(); return run(); }
    if (it.kind === "clear-recent") { saveRecent([]); input.focus(); return run(); }
    const q = input.value.trim();
    if (q) remember(q);
    close();
    if (it.kind !== "photo") $("#modal")?.classList.remove("on");   // leaving the photo viewer for another page
    if (it.kind === "person") return go(`#/${alt && it.tree ? "tree" : "people"}/${enc(it.name)}`);
    if (it.kind === "more-people") { showAllPeopleSearch(it.q); return go("#/people"); }
    if (it.kind === "photo") { await ready(); return openPhotoPath(it.path); }
    if (it.kind === "page") return go(`#/${it.tab}`);
    if (it.kind === "action") return act(it.id);
  }

  // ---------- open / close ----------
  function open() {
    if (dlg.open) { input.focus(); input.select(); return; }
    if (document.querySelector("dialog[open]")) return;   // another dialog (upload, photo viewer) is in charge
    cache.clear();   // names may have changed since last time
    seq++; if (ctrl) ctrl.abort();   // drop any search still running from last time
    input.value = "";
    show(emptyGroups(), "");
    dlg.showModal();
    input.focus();
  }
  function close() { if (dlg.open) dlg.close(); }
  window.openSearch = open;

  trigger.addEventListener("click", open);
  // The close event arrives a moment after the dialog closes; if the palette was opened again
  // in between, it must not cancel the new search.
  dlg.addEventListener("close", () => { if (dlg.open) return; seq++; if (ctrl) ctrl.abort(); clearTimeout(imgTimer); status.textContent = ""; });
  dlg.addEventListener("click", e => { if (e.target === dlg || e.target.closest(".sp-close")) close(); });
  dlg.addEventListener("keydown", e => {
    e.stopPropagation();   // keys typed here are for the palette, not the page underneath
    if (e.key === "Escape") { e.preventDefault(); return close(); }
    if (e.target !== input) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); move(e.key === "ArrowDown" ? 1 : -1); }
    else if ((e.key === "PageDown" || e.key === "PageUp") && flat.length) {
      e.preventDefault(); active = Math.max(0, Math.min(flat.length - 1, active + (e.key === "PageDown" ? 5 : -5))); paint();
    } else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); choose(active, e.shiftKey); }
  });
  input.addEventListener("input", run);
  list.addEventListener("mousedown", e => { if (e.target.closest("[data-sp-i]")) e.preventDefault(); });   // keep focus in the field
  list.addEventListener("mousemove", e => {
    const el = e.target.closest("[data-sp-i]");
    if (el && +el.dataset.spI !== active) { active = +el.dataset.spI; paint(false); }
  });
  list.addEventListener("click", e => { const el = e.target.closest("[data-sp-i]"); if (el) choose(+el.dataset.spI, e.shiftKey); });

  window.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault(); e.stopPropagation();
      return dlg.open ? close() : open();
    }
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !dlg.open && !editable(e.target)) { e.preventDefault(); open(); }
  }, true);
})();
