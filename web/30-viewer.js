// Photo viewer: replaces the read-only photo modal (openPhoto / openPhotoPath in review.html).
// A modal <dialog> with the photo, face boxes, a caption and date you can edit, and a list of
// faces left to right that you can name in place. Previous / next move through the photos the
// viewer was opened from (gallery, a group, a person, an import, leftovers), else library order.
//
// Other features can open it with a context of their own:
//   openPhotoViewer(path, {fid, items: [{path, fid?}], label: "My list", opener: element})
// or mark photo elements with data-photo-path="..." (and optionally data-photo-context on a container).
(() => {
  const ITEM_SEL = "[data-photo-path],[data-face],[data-gallery-open],[data-source-photo],[data-imp-open],[data-grow-jump]";
  const SCOPE_SEL = "[data-photo-context],.photo-gallery-grid,.source-gallery,.left-grid,.grid,.strip,.card";
  const GALLERY_PAGE = 120;
  const BOX_KEY = "photo-viewer-boxes";
  const V = {
    ctx: null, index: 0, path: null, fid: null, info: null, req: 0,
    opener: null, openerKey: null, dirty: false, history: false, escArmed: false,
    active: null, editing: null, details: false, undo: null, ignoring: false,
    infoCache: new Map(), preload: [], order: null, estimates: new Map(),
    hideBoxes: (() => { try { return localStorage.getItem(BOX_KEY) === "hidden"; } catch { return false; } })(),
  };
  let dlg = null, lastTarget = null, interactions = 0, swallowPops = 0;
  const HIST = "photoViewer";   // marks the history entry the viewer adds, so Back closes it
  const q = s => dlg.querySelector(s);
  const IGNORE = "_ignore";
  const isTyping = el => el && (el.matches("input, textarea, select") || el.isContentEditable);
  const plural = (n, one, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const baseName = path => path.split("/").pop();

  // Remember what the person last pointed at or pressed a key on: that's what opened the viewer.
  for (const type of ["pointerdown", "mousedown", "keydown", "click", "dblclick"])
    window.addEventListener(type, e => { interactions++; if (!dlg || !dlg.contains(e.target)) lastTarget = e.target; }, true);

  // ---------- markup ----------
  function ensureDialog() {
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.className = "pv";
    dlg.id = "photo-viewer";
    dlg.setAttribute("aria-labelledby", "pv-title");
    dlg.setAttribute("aria-describedby", "pv-keys");
    dlg.tabIndex = -1;
    dlg.innerHTML = `
      <div class="pv-stage">
        <div class="pv-bar">
          <p class="pv-pos" id="pv-pos" aria-live="polite"></p>
          <button class="btn pv-toggle" id="pv-boxes" type="button" aria-pressed="true">Face boxes</button>
          <button class="btn pv-close" id="pv-close" type="button" aria-label="Close photo viewer">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m4 4 8 8m0-8-8 8"/></svg>Close</button>
        </div>
        <div class="pv-view" id="pv-view">
          <button class="pv-nav pv-prev" id="pv-prev" type="button" aria-label="Previous photo">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>
          <div class="pv-frame" id="pv-frame">
            <img class="pv-img" id="pv-img" alt="" decoding="async">
            <div class="pv-boxes" id="pv-boxes-layer"></div>
          </div>
          <p class="pv-loading" id="pv-loading" role="status" hidden>Loading photo…</p>
          <button class="pv-nav pv-next" id="pv-next" type="button" aria-label="Next photo">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button>
        </div>
        <p class="pv-keys" id="pv-keys"><span><kbd aria-label="Left arrow">←</kbd> <kbd aria-label="Right arrow">→</kbd> Move between photos</span>
          <span><kbd>N</kbd> Name the next unnamed face</span><span><kbd>Esc</kbd> Close</span></p>
      </div>
      <div class="pv-panel" id="pv-panel">
        <section class="pv-details" id="pv-details" aria-label="Caption and date"></section>
        <section class="pv-faces" aria-labelledby="pv-faces-title">
          <div class="pv-faces-head"><h3 id="pv-faces-title">Faces, left to right</h3><span class="meta" id="pv-face-count"></span></div>
          <div class="pv-summary" id="pv-summary"></div>
          <p class="pv-status" id="pv-status" role="status" aria-live="polite"></p>
          <ol class="pv-list" id="pv-list"></ol>
        </section>
        <section class="pv-file" id="pv-file" aria-label="File"></section>
        <section class="pv-fs-tags" id="pv-fs-tags" aria-label="FamilySearch tags" hidden></section>
      </div>`;
    document.body.appendChild(dlg);
    wire();
    syncBoxToggle();
    return dlg;
  }

  // ---------- context: which photos previous / next walk through ----------
  function itemFor(el) {
    if (!el || typeof S === "undefined" || !S) return null;
    const d = el.dataset;
    if (d.photoPath) return { path: d.photoPath, fid: d.face != null && d.face !== "" ? +d.face : null };
    if (d.face !== undefined && d.face !== "") { const path = S.face_photo[+d.face]; return path ? { path, fid: +d.face } : null; }
    if (d.galleryOpen !== undefined) {
      const p = typeof photoGalleryData !== "undefined" && photoGalleryData?.photos?.[+d.galleryOpen];
      return p ? { path: p.path } : null;
    }
    if (d.sourcePhoto) return { path: d.sourcePhoto };
    if (d.impOpen) return { path: d.impOpen };
    if (d.growJump !== undefined) {
      const f = typeof grow !== "undefined" && grow?.frames?.[+d.growJump];
      return f && S.face_photo[f.id] ? { path: S.face_photo[f.id], fid: f.id } : null;
    }
    return null;
  }
  function keyFor(el) {
    const item = el && el.closest(ITEM_SEL);
    if (!item) return el && el.id ? `#${CSS.escape(el.id)}` : null;
    for (const [attr, key] of [["photoPath", "data-photo-path"], ["face", "data-face"], ["galleryOpen", "data-gallery-open"],
      ["sourcePhoto", "data-source-photo"], ["impOpen", "data-imp-open"], ["growJump", "data-grow-jump"]])
      if (item.dataset[attr] !== undefined) return `[${key}="${CSS.escape(item.dataset[attr])}"]`;
    return null;
  }
  function contextLabel(scope) {
    if (typeof tab === "undefined") return "This page";
    if (scope?.dataset?.photoContext) return scope.dataset.photoContext;
    if (tab === "people" && typeof person !== "undefined" && person)
      return scope?.classList.contains("source-gallery") ? `${person}: FamilySearch photos` : person === IGNORE ? "Ignored faces" : person;
    if (tab === "groups") {
      const card = scope?.closest(".card");
      const name = card?.querySelector(".named")?.textContent.trim() || card?.querySelector("input[data-cl]")?.value.trim();
      return name ? `Group: ${name}` : "This group";
    }
    if (tab === "imports" && typeof impBatch !== "undefined" && impBatch) return `Import ${impBatch}`;
    if (tab === "portraits" && scope?.classList.contains("strip")) return "Growing up";
    return (typeof TITLES !== "undefined" && TITLES[tab]) || "This page";
  }
  function listContext(items, label) {
    return { label, total: items.length, peek: i => items[i], get: async i => items[i] };
  }
  function domContext(opener) {
    const own = opener && opener.closest(ITEM_SEL);
    if (!own || !itemFor(own)) return null;
    if (own.dataset.galleryOpen !== undefined && typeof photoGalleryData !== "undefined" && photoGalleryData) return galleryContext();
    const scope = own.closest(SCOPE_SEL) || $("#main") || document.body;
    const seen = new Set(), items = [];
    for (const el of scope.querySelectorAll(ITEM_SEL)) {
      if (el.closest("dialog") || !el.getClientRects().length) continue;   // skip hidden copies
      const it = itemFor(el);
      if (it && !seen.has(it.path)) { seen.add(it.path); items.push(it); }
    }
    return items.length ? listContext(items, contextLabel(scope)) : null;
  }
  function galleryContext() {
    const d = photoGalleryData, items = new Array(d.total), pages = new Map();
    d.photos.forEach((p, i) => { items[d.offset + i] = { path: p.path }; });
    const fetchPage = start => {
      if (!pages.has(start)) {
        const query = new URLSearchParams({ mode: d.mode, source: d.source, offset: String(start), limit: String(GALLERY_PAGE) });
        for (const name of d.selected || []) query.append("person", name);
        pages.set(start, fetch(`/api/photo-gallery?${query}`).then(r => r.json()).then(page => {
          if (page.error) throw new Error(page.error);
          page.photos.forEach((p, i) => { items[start + i] = { path: p.path }; });
        }).catch(err => { pages.delete(start); throw err; }));
      }
      return pages.get(start);
    };
    return {
      label: "Gallery", total: d.total, peek: i => items[i],
      get: async i => { if (!items[i]) await fetchPage(Math.floor(i / GALLERY_PAGE) * GALLERY_PAGE); return items[i]; },
    };
  }
  async function libraryOrder() {
    if (!V.order || V.order.v !== S.v) {
      const r = await fetch("/api/viewer/order");
      if (!r.ok) throw new Error("Could not load the library order.");
      V.order = { v: S.v, paths: (await r.json()).paths };
    }
    return V.order.paths;
  }
  async function libraryContext(path) {
    const paths = await libraryOrder();
    return paths.includes(path) ? listContext(paths.map(p => ({ path: p })), "All photos, library order") : null;
  }

  // ---------- opening and closing ----------
  async function openPhotoViewer(path, opts = {}) {
    if (!path) return toast("This photo is no longer in the library.", true);
    ensureDialog();
    const opener = opts.opener || (lastTarget && lastTarget.isConnected && !dlg.contains(lastTarget) ? lastTarget : document.activeElement);
    if (!dlg.open) {
      V.opener = opener && opener !== document.body ? opener : null;
      V.openerKey = keyFor(V.opener);
      // Names, captions and dates may have changed on the page since the viewer was last open.
      V.infoCache.clear(); V.estimates.clear();
    }
    let ctx = opts.items ? listContext(opts.items, opts.label || "This list") : opts.context || domContext(opener);
    let index = ctx ? findIndex(ctx, path) : -1;
    if (index < 0) {   // nothing on the page to walk through: show the photo now, library order once it loads
      const single = ctx = listContext([{ path, fid: opts.fid ?? null }], "");
      index = 0;
      libraryContext(path).then(lib => {
        if (!lib || !dlg.open || V.ctx !== single) return;
        V.ctx = lib; V.index = findIndex(lib, path); V.ctx.peek(V.index).fid = opts.fid ?? null;
        renderPosition(); preloadNeighbours();
      }).catch(() => {});
    }
    if (opts.fid != null && ctx.peek(index)) ctx.peek(index).fid = opts.fid;
    V.ctx = ctx;
    if (!dlg.open) {
      dlg.showModal();
      document.documentElement.classList.add("pv-lock");
      if (!V.history) pushHistory();   // still set if it was closed a moment ago and its close event is pending
    }
    dlg.focus({ preventScroll: true });
    return show(index);
  }
  function findIndex(ctx, path) {
    for (let i = 0; i < ctx.total; i++) { const it = ctx.peek(i); if (it && it.path === path) return i; }
    return -1;
  }
  // Close unless a caption, date or name is typed but not saved (force: close anyway).
  function closeViewer(force = false) {
    if (!dlg?.open) return true;
    if (!force && blockedByEdits()) return false;
    dlg.close();
    popHistory();
    return true;
  }
  // ---------- history: Back (or a phone's back gesture) closes the viewer ----------
  function pushHistory() {
    try {
      const state = history.state && typeof history.state === "object" ? history.state : {};
      history.pushState({ ...state, [HIST]: true }, "", location.href);
      V.history = true;
    } catch { V.history = false; }
  }
  function popHistory() {   // the viewer closed itself: take its entry off the history too
    if (!V.history) return;
    V.history = false;
    if (history.state && history.state[HIST]) { swallowPops++; history.back(); }
  }
  // Back / Forward. Returns true when the move only concerned the viewer's own history entry,
  // so the page underneath must stay as it is (no re-render, no scroll to the top).
  function handlePop(state) {
    // Only ever keep the page as it is when it already shows the address we landed on;
    // anything else (say, a tab change that raced a closing viewer) is routed by the page as usual.
    const samePage = typeof currentRoute !== "function" || location.hash === currentRoute();
    if (swallowPops > 0) { swallowPops--; return samePage; }   // our own history.back()
    if (dlg?.open) {
      if (!V.history) { closeViewer(true); return false; }      // no entry of ours: close and let the page follow
      V.history = false;
      if (samePage && blockedByEdits()) pushHistory();          // keep the viewer and its entry; the message says why
      else closeViewer(true);
      return samePage;
    }
    if (state && state[HIST] && samePage) {   // Forward onto an old viewer entry: step back over it
      swallowPops++;
      history.back();
      return true;
    }
    return false;
  }
  // review.html's popstate handler asks this first (it was registered before this file loaded).
  let popAsked = false;
  window.popstateHandledByOverlay = () => { popAsked = true; return handlePop(history.state); };
  window.addEventListener("popstate", e => {   // fallback if the page's handler didn't ask
    if (popAsked) { popAsked = false; return; }
    handlePop(e.state);
  });

  function onClose() {
    // The close event arrives a moment after the dialog closes: if it was opened again in
    // between, it is still showing, so leave everything as it is.
    if (dlg.open) return;
    V.req++;
    document.documentElement.classList.remove("pv-lock");
    V.preload = [];
    V.escArmed = false;
    popHistory();
    const back = () => {
      let el = V.opener && V.opener.isConnected ? V.opener : null;
      if (!el && V.openerKey) el = document.querySelector(V.openerKey);
      if (!el) return false;
      const target = el.closest("button, a, input, [tabindex]") || el.closest(ITEM_SEL) || el;
      if (!target.matches("button, a[href], input, select, textarea, [tabindex]")) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      return true;
    };
    back();
    if (!V.dirty) return;
    V.dirty = false;
    const reloaded = typeof load === "function" ? load() : Promise.resolve();
    // The page re-renders after names change (some tabs a moment later, after their own fetch):
    // for a few seconds, put focus back on the same photo or face if the re-render dropped it,
    // unless the person has already moved on.
    const seen = interactions;
    let tries = 0;
    const watch = () => {
      if (dlg.open || interactions !== seen || ++tries > 40) return;
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) back();
      setTimeout(watch, 100);
    };
    Promise.resolve(reloaded).finally(watch);
  }

  // ---------- showing a photo ----------
  async function show(i) {
    const token = ++V.req;
    // The panel is about to be redrawn: don't let focus fall out of the viewer with it.
    if (q("#pv-panel").contains(document.activeElement)) dlg.focus({ preventScroll: true });
    V.index = i;
    V.active = null; V.editing = null; V.details = false; V.undo = null;
    q("#pv-status").textContent = "";
    renderPosition();
    let item;
    try { item = await V.ctx.get(i); } catch { item = null; }
    if (token !== V.req) return;
    if (!item) { setLoading(false, "Could not load this photo. Close the viewer and try again."); return; }
    V.path = item.path; V.fid = item.fid ?? null;
    const img = q("#pv-img");
    q("#pv-boxes-layer").innerHTML = "";
    setLoading(true);
    img.onload = () => { if (token === V.req) { setLoading(false); drawBoxes(); } };
    img.onerror = () => { if (token === V.req) setLoading(false, "This photo could not be loaded. The file may have been moved or deleted."); };
    img.alt = "";
    img.src = photoURL(item.path);
    if (img.complete && img.naturalWidth) setLoading(false);
    renderPanel(true);
    let info;
    try { info = await getInfo(item.path); }
    catch (err) {
      if (token !== V.req) return;
      V.info = null;
      q("#pv-details").innerHTML = `<p class="pv-error" role="alert">${esc(err.message || "Could not load this photo's details.")} <button class="btn" type="button" data-pv-retry>Try again</button></p>`;
      return;
    }
    if (token !== V.req) return;
    V.info = info;
    img.alt = info.caption ? `Photo: ${info.caption}` : `Photo ${baseName(info.path)}`;
    renderPanel();
    if (img.complete && img.naturalWidth) drawBoxes();
    preloadNeighbours();
    loadEstimate(item.path, token);
  }
  function setLoading(on, message) {
    const el = q("#pv-loading"), img = q("#pv-img");
    img.classList.toggle("loading", on);
    img.hidden = !!message;
    el.hidden = !on && !message;
    el.textContent = message || "Loading photo…";
    el.setAttribute("role", message ? "alert" : "status");
  }
  function branch() { return typeof reviewSettings !== "undefined" ? reviewSettings.branch || "" : ""; }
  function getInfo(path, fresh = false) {
    const hit = V.infoCache.get(path);
    // Only reused while the viewer stays open (cleared when it opens) and for this data version.
    if (!fresh && hit && hit.v === S.v && Date.now() - hit.at < 60000) return hit.promise;
    const promise = fetch(`/api/viewer/photo?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch())}`)
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.error) throw new Error(data.error || "Could not load this photo's details. Check that the app is still running.");
        return data;
      });
    promise.catch(() => V.infoCache.delete(path));
    V.infoCache.set(path, { at: Date.now(), v: S.v, promise });
    if (V.infoCache.size > 40) V.infoCache.delete(V.infoCache.keys().next().value);
    return promise;
  }
  function preloadNeighbours() {
    const i = V.index, ctx = V.ctx;
    V.preload = [];
    for (const j of [i + 1, i - 1, i + 2]) {
      if (j < 0 || j >= ctx.total) continue;
      Promise.resolve(ctx.get(j)).then(it => {
        if (!it || ctx !== V.ctx) return;
        const im = new Image(); im.decoding = "async"; im.src = photoURL(it.path); V.preload.push(im);
        if (j !== i + 2) getInfo(it.path).catch(() => {});
      }).catch(() => {});
    }
  }
  function loadEstimate(path, token, fresh = false) {
    const done = est => {
      const before = V.estimates.get(path);
      V.estimates.set(path, est);
      if (token === V.req && V.path === path && JSON.stringify(before ?? null) !== JSON.stringify(est)) renderDetails();
    };
    if (fresh) V.estimates.delete(path);
    else if (V.estimates.has(path)) return;
    fetch(`/api/viewer/date-estimate?path=${encodeURIComponent(path)}`).then(r => r.ok ? r.json() : null)
      .then(d => done(estimateOf(d?.estimate))).catch(() => done(null));
  }
  // {text, kind}: kind "estimated" (from faces' ages), "caption" (a year in the caption) or "yours".
  function estimateOf(e) {
    const text = estimateText(e);
    if (!text) return null;
    const src = e && typeof e === "object" ? String(e.source || "") : "";
    return { text, kind: src === "caption" ? "caption" : src && src !== "estimated" ? "yours" : "estimated" };
  }
  function estimateText(e) {
    if (e == null || e === false) return null;
    if (typeof e === "number") return String(Math.round(e));
    if (typeof e === "string") return e.trim() || null;
    if (typeof e === "object") {
      for (const k of ["label", "text", "year", "estimate", "date", "decade"]) {
        const v = estimateText(e[k]);
        if (v) return v;
      }
    }
    return null;
  }
  function step(d) {
    if (!V.ctx) return;
    const j = V.index + d;
    if (j < 0 || j >= V.ctx.total) return;
    if (blockedByEdits()) return;
    show(j);
  }
  function detailsChanged(form = q(".pv-details-form")) {
    return !!form && (form.caption.value !== form.caption.defaultValue || form.date.value !== form.date.defaultValue);
  }
  function nameTyped(ed = q(".pv-editor input")) {
    return !!ed && !!ed.value.trim() && ed.value !== ed.defaultValue;
  }
  function blockedByEdits() {
    if (V.ignoring) {
      q("#pv-status").textContent = "Saving Nobody else. Wait before leaving this photo.";
      return true;
    }
    if (window.FamilySearchTags?.isSubmitting()) {
      toast("Wait for the FamilySearch tag result before leaving this photo.", true);
      return true;
    }
    const form = q(".pv-details-form");
    if (detailsChanged(form)) {
      const msg = form.querySelector(".pv-form-msg");
      msg.textContent = "Save or cancel your caption and date changes first.";
      if (!form.contains(document.activeElement)) form.caption.focus();
      V.escArmed = false;
      return true;
    }
    const ed = q(".pv-editor input");
    if (nameTyped(ed)) {
      ed.closest(".pv-editor").querySelector(".pv-hint").textContent = "Save or cancel this name first.";
      ed.focus();
      return true;
    }
    return false;
  }

  // ---------- rendering ----------
  function renderPosition() {
    const ctx = V.ctx, total = ctx?.total || 0;
    const pos = q("#pv-pos");
    pos.innerHTML = total > 1 || ctx?.label
      ? `<b>${(V.index + 1).toLocaleString()}</b> of <b>${total.toLocaleString()}</b>${ctx.label ? `<span class="pv-ctx"> · ${esc(ctx.label)}</span>` : ""}`
      : "";
    const prev = q("#pv-prev"), next = q("#pv-next"), had = document.activeElement;
    prev.disabled = V.index <= 0;
    next.disabled = V.index >= total - 1;
    if ((had === prev || had === next) && had.disabled) (had === prev ? next : prev).disabled ? dlg.focus() : (had === prev ? next : prev).focus();
    q("#pv-prev").hidden = q("#pv-next").hidden = total <= 1;
  }
  function renderPanel(loading = false) {
    if (loading) {
      q("#pv-details").innerHTML = `<h2 class="pv-caption none" id="pv-title">${esc(baseName(V.path || ""))}</h2><p class="meta">Loading details…</p>`;
      q("#pv-face-count").textContent = "";
      q("#pv-summary").innerHTML = "";
      q("#pv-list").innerHTML = "";
      q("#pv-file").innerHTML = "";
      window.FamilySearchTags?.mount(q("#pv-fs-tags"), null);
      return;
    }
    renderDetails(); renderFaces(); renderFile();
  }
  function prettyDate(d) {
    const m = /^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(d);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
  }
  function estimateLine(est) {   // plain text for the date field's help line
    if (!est) return "";
    const about = /^(about|around|c\.|circa)\b/i.test(est.text) || /s\b|–|-/.test(est.text) ? est.text : `about ${est.text}`;
    return est.kind === "estimated" ? ` Estimated: ${about}.` : est.kind === "caption" ? ` The caption suggests ${est.text}.` : ` Your date: ${est.text}.`;
  }
  function renderDetails() {
    const info = V.info;
    if (!info) return;
    const est = V.estimates.get(info.path);
    const box = q("#pv-details");
    if (V.details) {
      const keep = box.querySelector(".pv-details-form");
      if (keep) { const hint = keep.querySelector(".pv-est"); if (hint) hint.textContent = estimateLine(est); return; }
      box.innerHTML = `<h2 class="pv-caption sr" id="pv-title">${esc(info.caption || baseName(info.path))}</h2>
        <form class="pv-details-form" novalidate>
          <label class="pv-field"><span>Caption</span>
            <textarea name="caption" rows="3" maxlength="2000" placeholder="Who, where, what's happening">${esc(info.caption)}</textarea></label>
          <label class="pv-field"><span>Date</span>
            <input name="date" maxlength="80" autocomplete="off" value="${esc(info.date)}" placeholder="1987, Summer 1952 or 1987-06-14" aria-describedby="pv-date-help"></label>
          <p class="meta" id="pv-date-help">Any wording works: a year, a season, or a full date.<span class="pv-est">${esc(estimateLine(est))}</span></p>
          <p class="pv-form-msg" role="alert"></p>
          <div class="pv-actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-pv-details-cancel>Cancel</button></div>
        </form>`;
      return;
    }
    const date = info.date
      ? `<span class="pv-date-v">${esc(prettyDate(info.date))}</span>`
      : est?.kind === "estimated" ? `<span class="pv-date-v est">${esc(/^(about|around|c\.|circa)\b/i.test(est.text) || /s\b|–|-/.test(est.text) ? est.text : `about ${est.text}`)}</span> <span class="meta">(estimated)</span>`
      : est ? `<span class="pv-date-v est">${esc(est.text)}</span> <span class="meta">(${est.kind === "caption" ? "from the caption" : "your date"})</span>`
      : `<span class="meta">No date</span>`;
    // Keep focus on the edit button if it had it (an estimate can arrive after the panel is drawn).
    const refocus = box.contains(document.activeElement) && document.activeElement.matches("[data-pv-details-edit]");
    box.innerHTML = `
      <h2 class="pv-caption ${info.caption ? "" : "none"}" id="pv-title"><span class="sr">${esc(baseName(info.path))}${info.caption ? ": " : ", no caption"}</span>${info.caption ? esc(info.caption) : `<span aria-hidden="true">No caption</span>`}</h2>
      <p class="pv-date">${date}</p>
      <button class="btn pv-edit" type="button" data-pv-details-edit>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 2.5 13.5 5 6 12.5H3.5V10z"/></svg>
        ${info.caption || info.date ? "Edit caption and date" : "Add caption and date"}</button>
      <button class="btn pv-remove" type="button" data-pv-remove="${esc(info.path)}" title="Take this photo out of the library (it goes to the Removed photos folder)">Remove photo…</button>`;
    if (refocus) q("[data-pv-details-edit]").focus({ preventScroll: true });
  }
  function faceState(f) { return !f.name ? "unnamed" : f.name === IGNORE ? "skipped" : "named"; }
  function renderFaces() {
    const info = V.info, faces = info.faces;
    const unnamed = faces.filter(f => !f.name).length;
    q("#pv-face-count").textContent = faces.length ? plural(faces.length, "face") : "";
    q("#pv-summary").innerHTML = !faces.length
      ? `<p class="meta">No faces were found in this photo.</p>`
      : unnamed
        ? `<p class="pv-unnamed"><b>${unnamed.toLocaleString()}</b> ${unnamed === 1 ? "face" : "faces"} unnamed</p>
           <div class="pv-actions"><button class="btn primary" type="button" data-pv-next-unnamed aria-keyshortcuts="N">Name next unnamed face</button>
             <button class="btn" type="button" data-pv-nobody-else aria-describedby="pv-nobody-help">Nobody else</button></div>
           <p class="meta pv-nobody-help" id="pv-nobody-help">Ignore the remaining unnamed faces. Keep existing names.</p>`
        : `<p class="pv-unnamed done">${doneText(faces)}</p>`;
    q("#pv-list").innerHTML = faces.map((f, k) => {
      const st = faceState(f), editing = V.editing === f.id;
      const top = f.suggest?.[0];
      const label = st === "named" ? `Face ${k + 1} of ${faces.length}: ${f.name}. Change or clear the name`
        : st === "skipped" ? `Face ${k + 1} of ${faces.length}: ignored. Name this face`
        : `Face ${k + 1} of ${faces.length}: unnamed. Name this face`;
      return `<li class="pv-face ${st} ${V.active === f.id ? "on" : ""} ${V.fid === f.id ? "me" : ""}" data-pv-fid="${f.id}">
        <button class="pv-face-btn" type="button" data-pv-face="${f.id}" aria-expanded="${editing}" aria-label="${esc(label)}">
          <span class="pv-num" aria-hidden="true">${k + 1}</span>
          <img src="/thumbs/${f.id}.jpg?v=${S.v}" alt="" loading="lazy">
          <span class="pv-face-text">
            ${st === "named" ? `<b>${esc(f.name)}</b>` : st === "skipped" ? `<b class="muted">Ignored</b><small>Not someone to tag</small>` : `<b class="muted">Unnamed</b>`}
            ${st === "unnamed" && top ? `<small class="pv-like"><span>Looks like ${esc(top[0])}</span><span class="pct">${Math.round(top[1] * 100)}%</span></small>` : ""}
            ${V.fid === f.id ? `<small class="pv-you">The face you opened</small>` : ""}
          </span>
          <span class="pv-act" aria-hidden="true">${st === "named" ? "Change" : "Name"}</span>
        </button>
        ${editing ? editorHTML(f, k) : ""}
      </li>`;
    }).join("");
    if (V.ignoring) dlg.querySelectorAll(".pv-faces button, .pv-faces input").forEach(el => { el.disabled = true; });
    if (V.undo) renderStatus();
  }
  function doneText(faces) {
    const skipped = faces.filter(f => f.name === IGNORE).length, named = faces.length - skipped;
    if (!skipped) return faces.length === 1 ? "The face is named" : `All ${faces.length} faces are named`;
    if (!named) return faces.length === 1 ? "The face is ignored" : `All ${faces.length} faces are ignored`;
    return `${named} named, ${skipped} ignored`;
  }
  function editorHTML(f, k) {
    const st = faceState(f);
    const sugg = (f.suggest || []).filter(([n]) => n !== f.name);
    return `<form class="pv-editor" data-pv-editor="${f.id}" novalidate>
      <label class="sr" for="pv-name-${f.id}">Name for face ${k + 1}</label>
      <input id="pv-name-${f.id}" class="pv-name" list="people-list" autocomplete="off" spellcheck="false"
             placeholder="Who is this?" value="${st === "named" ? esc(f.name) : ""}">
      ${sugg.length ? `<div class="pv-sugg"><span class="meta">Suggestions</span>${sugg.map(([n, s]) =>
        `<button class="chip sugg" type="button" data-pv-pick="${esc(n)}" aria-label="Save as ${esc(n)}, ${Math.round(s * 100)}% match">${esc(n)}<small>${Math.round(s * 100)}%</small></button>`).join("")}</div>` : ""}
      <p class="pv-hint meta" aria-live="polite"></p>
      <div class="pv-actions">
        <button class="btn primary" type="submit">Save name</button>
        ${st === "named" ? `<button class="btn danger" type="button" data-pv-clear>Clear name</button>` : ""}
        ${st === "unnamed" ? `<button class="btn" type="button" data-pv-skip title="Not someone to tag: leaves this face out of the export">Ignore face</button>` : ""}
        ${st === "skipped" ? `<button class="btn" type="button" data-pv-clear>Stop ignoring</button>` : ""}
        <button class="btn" type="button" data-pv-cancel>Cancel</button>
      </div>
    </form>`;
  }
  function renderFile() {
    const info = V.info;
    const original = `${photoURL(info.path)}&original=1`;
    const dl = info.original_available ? "Download original" : "Download image";
    q("#pv-file").innerHTML = `
      <div class="pv-links">
        <a class="btn" href="${original}" download="${esc(baseName(info.path))}">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10"/></svg>${dl}</a>
        ${info.source_url ? `<a class="btn" href="${esc(info.source_url)}" target="_blank" rel="noopener noreferrer">View in ${esc(info.source || "source")}
          <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h7v7M13 3 4 12"/></svg><span class="sr"> (opens in a new tab)</span></a>` : ""}
      </div>
      <p class="meta pv-path">${esc(info.path)}${info.original_available ? "" : " · The original file isn't stored here, so the download is the copy we have."}</p>`;
    window.FamilySearchTags?.mount(q("#pv-fs-tags"), info.familysearch_memory_id ? info.path : null);
  }
  function drawBoxes() {
    const layer = q("#pv-boxes-layer"), img = q("#pv-img"), info = V.info;
    layer.innerHTML = "";
    layer.hidden = V.hideBoxes;
    if (!info || !img.naturalWidth || info.path !== V.path) return;
    const n = info.faces.length;
    info.faces.forEach((f, k) => {
      const W = f.img_w || img.naturalWidth, H = W * img.naturalHeight / img.naturalWidth;
      // Detections can run past the photo's edge: keep the box on the photo.
      const clamp = (v, max) => Math.min(max, Math.max(0, v));
      const x1 = clamp(f.bbox[0], W), y1 = clamp(f.bbox[1], H), x2 = clamp(f.bbox[2], W), y2 = clamp(f.bbox[3], H);
      if (x2 - x1 < 1 || y2 - y1 < 1) return;
      const st = faceState(f);
      const b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;   // keyboard users move through faces in the list (Tab); boxes are for pointing
      b.className = `pv-box ${st}${V.fid === f.id ? " me" : ""}${V.active === f.id ? " on" : ""}${y1 / H < 0.06 ? " at-top" : ""}${y2 / H > 0.92 ? " at-bottom" : ""}`;
      b.dataset.pvFace = f.id;
      b.setAttribute("aria-label", st === "named" ? `Face ${k + 1} of ${n}: ${f.name}` : `Face ${k + 1} of ${n}: ${st === "skipped" ? "ignored" : st}`);
      Object.assign(b.style, { left: `${(x1 / W) * 100}%`, top: `${(y1 / H) * 100}%`, width: `${((x2 - x1) / W) * 100}%`, height: `${((y2 - y1) / H) * 100}%` });
      b.innerHTML = `<span class="pv-num">${k + 1}</span>${st === "named" ? `<span class="pv-tag">${esc(f.name)}</span>` : ""}`;
      layer.appendChild(b);
    });
  }
  function setActive(fid) {
    V.active = fid;
    for (const el of dlg.querySelectorAll("[data-pv-fid], .pv-box"))
      el.classList.toggle("on", fid != null && +(el.dataset.pvFid ?? el.dataset.pvFace) === fid);
  }
  function renderStatus() {
    const u = V.undo, el = q("#pv-status");
    if (!u) { el.innerHTML = ""; return; }
    el.innerHTML = `<span>${esc(u.message)}</span>${u.canUndo ? ` <button class="btn pv-undo" type="button" data-pv-undo>Undo</button>` : ""}`;
    el.classList.toggle("warn", !!u.warn);
  }

  // ---------- naming faces ----------
  function openEditor(fid, focus = true) {
    if (!V.info) return;
    if (V.editing !== fid && blockedByEdits()) return;
    V.editing = fid; V.active = fid;
    renderFaces(); drawBoxesState();
    const row = q(`[data-pv-fid="${fid}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "nearest" });
    if (focus) { const input = row.querySelector(".pv-name"); input.focus(); input.select(); }
    updateHint(row.querySelector(".pv-editor"));
  }
  function closeEditor(focusRow = true) {
    const fid = V.editing;
    V.editing = null;
    renderFaces();
    if (focusRow && fid != null) q(`[data-pv-face="${fid}"].pv-face-btn`)?.focus();
  }
  function drawBoxesState() { for (const b of dlg.querySelectorAll(".pv-box")) b.classList.toggle("on", +b.dataset.pvFace === V.active); }
  function knownName(typed) {
    const t = typed.trim().replace(/\s+/g, " ");
    if (!t) return { name: "", known: false };
    if (window.Naming && t !== IGNORE) {   // the naming loop's rules: usual spelling, near misses
      const r = Naming.lookup(t);
      if (r.state === "known") return { name: r.name, known: true, recased: r.name !== t };
      if (r.state === "new") return { name: r.name, known: false, near: r.near || [] };
    }
    if (S.people[t] !== undefined) return { name: t, known: true };
    const low = t.toLocaleLowerCase();
    const hit = Object.keys(S.people).find(n => n.toLocaleLowerCase() === low);
    return hit ? { name: hit, known: true, recased: true } : { name: t, known: false };
  }
  function updateHint(form) {
    if (!form) return;
    const input = form.querySelector(".pv-name"), hint = form.querySelector(".pv-hint");
    const { name, known, recased, near } = knownName(input.value);
    delete form.dataset.confirm;
    hint.textContent = !name ? "" : name === IGNORE ? "" : recased ? `Saves as ${name}, who is already in your people.`
      : known ? "" : `New person${near?.length ? `. Did you mean ${near.join(" or ")}?` : ""}`;
  }
  function nextUnnamed() {
    const faces = V.info?.faces || [];
    if (!faces.length) return;
    const start = Math.max(-1, faces.findIndex(f => f.id === (V.editing ?? V.active)));
    for (let k = 1; k <= faces.length; k++) {
      const f = faces[(start + k) % faces.length];
      if (!f.name) return openEditor(f.id);
    }
    q("#pv-status").textContent = "Every face in this photo is named or ignored.";
  }
  async function saveName(fid, rawName, { typed = false } = {}) {
    if (V.ignoring) return;
    const info = V.info, face = info?.faces.find(f => f.id === fid);
    if (!face) return;
    const k = info.faces.indexOf(face) + 1;
    let name = rawName;
    const form = q(`[data-pv-editor="${fid}"]`);
    if (name && name !== IGNORE) {
      const found = knownName(name);
      name = found.name;
      // As in Groups: a brand-new name asks for a second Enter, so a typo never adds a person.
      if (typed && !found.known && form && form.dataset.confirm !== name.toLowerCase()) {
        form.dataset.confirm = name.toLowerCase();
        form.querySelector(".pv-hint").textContent = `New person. Press Enter again to add “${name}”${found.near?.length ? `, or did you mean ${found.near.join(" or ")}?` : "."}`;
        return form.querySelector(".pv-name")?.focus();
      }
    }
    if (name === "") name = null;
    const before = face.name ?? null;
    if (name === before) { closeEditor(); return; }
    form?.querySelectorAll("button, input").forEach(el => { el.disabled = true; });
    // Through the page's ordered write queue, so an undo or another tab's change can't overtake it.
    const r = await postJSON("/api/label", { faces: [fid], name }, { quiet: true });
    if (r.error) {
      form?.querySelectorAll("button, input").forEach(el => { el.disabled = false; });
      V.undo = { message: r.status === 0 ? REACH_ERROR : `Couldn’t save the name: ${r.error}`, warn: true };
      renderStatus();
      form?.querySelector(".pv-name")?.focus();
      return;
    }
    face.name = name;
    V.dirty = true;
    V.infoCache.clear();
    V.infoCache.set(info.path, { at: Date.now(), v: S.v, promise: Promise.resolve(info) });
    const added = name && name !== IGNORE && S.people[name] === undefined ? name : null;
    if (added) {   // a brand-new person: offer the name in autocomplete straight away
      S.people[added] = 1;
      const opt = document.createElement("option"); opt.value = added;
      $("#people-list")?.appendChild(opt);
    }
    loadEstimate(info.path, V.req, true);   // a date estimate can depend on who is in the photo
    V.undo = { id: r.history?.id, fid, added, canUndo: !!r.history,
               message: name === IGNORE ? `Ignored face ${k}. It won’t be tagged.`
                 : name ? `Named face ${k} as ${name}.` : `Cleared the name from face ${k}.` };
    V.editing = null;
    renderFaces(); drawBoxes(); renderStatus();
    q(`.pv-face-btn[data-pv-face="${fid}"]`)?.focus();
  }

  async function nobodyElse() {
    if (V.ignoring || !V.info || blockedByEdits()) return;
    const info = V.info, path = info.path, request = V.req;
    const ids = info.faces.filter(face => !face.name).map(face => face.id);
    if (!ids.length) return;
    V.ignoring = true;
    dlg.querySelectorAll(".pv-faces button, .pv-faces input").forEach(el => { el.disabled = true; });
    q("#pv-status").textContent = "Saving Nobody else…";
    try {
      const result = await postJSON("/api/label", { faces: ids, name: IGNORE, only_unnamed: true }, { quiet: true });
      if (result.error) {
        V.undo = { message: result.status === 0 ? REACH_ERROR : `Could not save Nobody else: ${result.error}`, warn: true };
        return;
      }
      const changed = new Set(result.named || []);
      for (const face of info.faces) if (changed.has(face.id)) face.name = IGNORE;
      V.dirty = true;
      V.infoCache.clear();
      V.undo = { id: result.history?.id, canUndo: !!result.history,
        message: changed.size ? `${plural(changed.size, "face")} ignored. Existing names were kept.`
          : "No unnamed faces were changed. Existing names were kept." };
      V.editing = null;
      await refreshInfo(path, request);
    } finally {
      V.ignoring = false;
      if (dlg.open && V.path === path && V.req === request) {
        renderFaces(); drawBoxes(); renderStatus();
        (q("[data-pv-undo]") || q("[data-pv-nobody-else]") || q(".pv-face-btn") || dlg).focus({ preventScroll: true });
      }
    }
  }

  // ---------- caption and date ----------
  function editDetails() {
    if (!V.info) return;
    V.details = true;
    renderDetails();
    const ta = q(".pv-details-form textarea");
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function cancelDetails() {
    V.details = false; V.escArmed = false;
    renderDetails();
    q("[data-pv-details-edit]")?.focus();
  }
  async function saveDetails(form) {
    const info = V.info, msg = form.querySelector(".pv-form-msg");
    const caption = form.caption.value, date = form.date.value;
    if (date.trim().length > 80) { msg.textContent = "Keep the date under 80 characters."; return form.date.focus(); }
    form.querySelectorAll("button, input, textarea").forEach(el => { el.disabled = true; });
    msg.textContent = "";
    const data = await postJSON("/api/photo/edit", { path: info.path, caption, date }, { quiet: true });
    if (data.error) {
      form.querySelectorAll("button, input, textarea").forEach(el => { el.disabled = false; });
      msg.textContent = data.status === 0 ? REACH_ERROR : data.error;
      return;
    }
    info.caption = data.caption; info.date = data.date;
    if (data.changed) {
      V.dirty = true;
      loadEstimate(info.path, V.req, true);   // the estimate can come from the caption or the date
      for (const store of [S.captions, typeof STATIC !== "undefined" ? STATIC?.captions : null]) {
        if (!store) continue;
        if (data.caption) store[info.path] = data.caption; else delete store[info.path];
      }
      if (typeof photoGalleryData !== "undefined" && photoGalleryData)
        for (const p of photoGalleryData.photos) if (p.path === info.path) { p.caption = data.caption; p.date = data.date; }
    }
    V.details = false;
    renderDetails();
    q("#pv-img").alt = info.caption ? `Photo: ${info.caption}` : `Photo ${baseName(info.path)}`;
    V.undo = data.changed && data.history ? { id: data.history.id, message: "Saved the caption and date.", canUndo: true }
      : { message: data.changed ? "Saved the caption and date." : "No changes to save.", canUndo: false };
    renderStatus();
    q("[data-pv-details-edit]")?.focus();
  }

  // Undo in the viewer is the History entry's own undo (the same as Cmd-Z): the photo's names, caption and
  // date come back exactly as they were, and History shows the change as undone.
  async function undoHere(id) {
    if (id == null || typeof undoChange !== "function") return;
    const path = V.path, k = V.req;
    q("#pv-status").innerHTML = `<span>Undoing…</span>`;
    const r = await undoChange(id);
    if (!r || r.error || r.nothing) { V.undo = { message: r?.message || r?.error || "Couldn’t undo that.", warn: true }; renderStatus(); return; }
    V.dirty = true;
    await refreshInfo(path, k);
    V.undo = { message: `Undone: ${r.undone?.action || "the last change"}.`, canUndo: false };
    renderStatus();
  }
  // Fetch this photo's names, caption and date again (after an undo or redo made anywhere).
  async function refreshInfo(path = V.path, k = V.req) {
    if (!path) return;
    V.infoCache.delete(path);
    let info;
    try { info = await getInfo(path, true); } catch { return; }
    if (k !== V.req || V.path !== path) return;
    V.info = info; V.editing = null;
    const back = document.activeElement && dlg.contains(document.activeElement);
    renderDetails(); renderFaces(); drawBoxes();
    loadEstimate(path, V.req, true);
    if (back && !dlg.contains(document.activeElement)) dlg.focus({ preventScroll: true });
  }
  document.addEventListener("app:saved", e => {
    if (dlg?.open && (e.detail?.kind === "undo" || e.detail?.kind === "redo")) refreshInfo();
  });

  // ---------- events ----------
  function focusables() {
    return [...dlg.querySelectorAll("button, a[href], input, textarea, select, [tabindex]:not([tabindex='-1'])")]
      .filter(el => !el.disabled && el.tabIndex >= 0 && !el.hidden && el.getClientRects().length && !el.closest("[hidden]"));
  }
  function wire() {
    dlg.addEventListener("close", onClose);
    dlg.addEventListener("cancel", e => {
      // Escape (or a phone's back gesture) with something typed but not saved: keep it and say why.
      if (blockedByEdits()) { e.preventDefault(); return; }
      // Escape inside an open editor closes the editor, not the viewer.
      if (V.editing != null || V.details) { e.preventDefault(); V.details ? cancelDetails() : closeEditor(); return; }
      popHistory();   // the viewer is closing: take its history entry off now, not when the close event arrives
    });
    // Clicks and keys inside the viewer must not reach the page's own handlers underneath.
    dlg.addEventListener("click", e => { e.stopPropagation(); onClick(e); });
    dlg.addEventListener("dblclick", e => e.stopPropagation());
    dlg.addEventListener("keydown", e => { e.stopPropagation(); onKey(e); });
    dlg.addEventListener("input", e => {
      if (e.target.matches(".pv-name")) updateHint(e.target.closest(".pv-editor"));
      if (e.target.closest(".pv-details-form") && V.escArmed) { V.escArmed = false; e.target.form.querySelector(".pv-form-msg").textContent = ""; }
    });
    dlg.addEventListener("submit", e => {
      e.preventDefault();
      const form = e.target;
      if (form.matches(".pv-details-form")) return saveDetails(form);
      if (form.matches(".pv-editor")) {
        const value = form.querySelector(".pv-name").value.trim();
        if (!value) {
          form.querySelector(".pv-hint").textContent = "Type a name, pick a suggestion, or use Cancel.";
          return form.querySelector(".pv-name").focus();
        }
        return saveName(+form.dataset.pvEditor, value, { typed: true });
      }
    });
    dlg.addEventListener("mouseover", e => {
      const t = e.target.closest("[data-pv-fid], .pv-box");
      if (t && V.editing == null) setActive(+(t.dataset.pvFid ?? t.dataset.pvFace));
    });
    dlg.addEventListener("mouseout", e => {
      const t = e.target.closest("[data-pv-fid], .pv-box");
      if (t && !t.contains(e.relatedTarget) && V.editing == null && !dlg.querySelector(".pv-face-btn:focus")) setActive(null);
    });
    dlg.addEventListener("focusin", e => {
      const row = e.target.closest("[data-pv-fid]");
      if (row) setActive(+row.dataset.pvFid);
      else if (V.editing == null) setActive(null);
    });
    // Swipe left / right on the photo (touch screens).
    let sx = null, sy = 0;
    q("#pv-view").addEventListener("pointerdown", e => { if (e.pointerType === "touch") { sx = e.clientX; sy = e.clientY; } });
    q("#pv-view").addEventListener("pointerup", e => {
      if (sx == null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) step(dx < 0 ? 1 : -1);
    });
    q("#pv-view").addEventListener("pointercancel", () => { sx = null; });
    window.addEventListener("resize", () => { if (dlg.open) setActive(V.active); });
    // Safety net: if focus ever lands outside the viewer (e.g. on <body>) while it is open,
    // its keys still work and never reach the page underneath.
    document.addEventListener("keydown", e => {
      if (!dlg.open || dlg.contains(e.target)) return;
      e.stopPropagation();
      if (e.key !== "Escape") onKey(e);
    }, true);
  }
  function onClick(e) {
    const t = e.target;
    if (t.closest("#pv-close")) return closeViewer();
    if (t.closest("#pv-prev")) return step(-1);
    if (t.closest("#pv-next")) return step(1);
    if (t.closest("#pv-boxes")) {
      V.hideBoxes = !V.hideBoxes;
      try { localStorage.setItem(BOX_KEY, V.hideBoxes ? "hidden" : "shown"); } catch {}
      syncBoxToggle();
      return;
    }
    if (t.closest("[data-pv-retry]")) return show(V.index);
    if (t.closest("[data-pv-details-edit]")) return editDetails();
    if (t.closest("[data-pv-details-cancel]")) return cancelDetails();
    if (t.closest("[data-pv-nobody-else]")) return nobodyElse();
    if (t.closest("[data-pv-next-unnamed]")) return nextUnnamed();
    if (t.closest("[data-pv-undo]")) {
      const u = V.undo; if (!u?.canUndo) return;
      return undoHere(u.id);
    }
    const editor = t.closest(".pv-editor");
    if (editor) {
      const fid = +editor.dataset.pvEditor;
      const pick = t.closest("[data-pv-pick]");
      if (pick) return saveName(fid, pick.dataset.pvPick);
      if (t.closest("[data-pv-clear]")) return saveName(fid, null);
      if (t.closest("[data-pv-skip]")) return saveName(fid, IGNORE);
      if (t.closest("[data-pv-cancel]")) return closeEditor();
      return;
    }
    const face = t.closest("[data-pv-face]");
    if (face) {
      const fid = +face.dataset.pvFace;
      if (V.editing === fid && face.classList.contains("pv-face-btn")) return closeEditor();
      return openEditor(fid);
    }
  }
  function syncBoxToggle() {
    const b = q("#pv-boxes");
    b.setAttribute("aria-pressed", String(!V.hideBoxes));   // a toggle with a fixed name: "Face boxes", on or off
    b.textContent = "Face boxes";
    q("#pv-boxes-layer").hidden = V.hideBoxes;
  }
  function onKey(e) {
    if (e.key === "Tab") {   // keep focus inside the viewer
      const list = focusables();
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1], at = document.activeElement;
      if (e.shiftKey && (at === first || at === dlg)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || at === dlg)) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === "Escape") {
      if (e.target.closest(".pv-editor")) { e.preventDefault(); return closeEditor(); }
      const form = e.target.closest(".pv-details-form");
      if (form) {
        e.preventDefault();
        // A caption can take a while to type: the first Escape asks, the second discards it.
        if (detailsChanged(form) && !V.escArmed) {
          V.escArmed = true;
          form.querySelector(".pv-form-msg").textContent = "Press Escape again to discard your changes, or choose Save.";
          return;
        }
        return cancelDetails();
      }
      return;   // the dialog closes itself
    }
    V.escArmed = false;
    if (isTyping(e.target)) {
      if (e.key === "Enter" && e.target.matches(".pv-details-form textarea") && !e.shiftKey) {
        e.preventDefault(); e.target.form.requestSubmit();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key.toLowerCase() === "z" || (e.key.toLowerCase() === "y" && e.ctrlKey && !e.metaKey))) {
      // Cmd-Z / Shift-Cmd-Z work here as anywhere else in the app (outside a text box).
      e.preventDefault();
      if (e.repeat || typeof undoLast !== "function") return;
      return e.shiftKey || e.key.toLowerCase() === "y" ? redoLast() : undoLast();
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); return step(e.key === "ArrowRight" ? 1 : -1); }
    if (e.key === "Home" && V.ctx) { e.preventDefault(); if (!blockedByEdits()) show(0); return; }
    if (e.key === "End" && V.ctx) { e.preventDefault(); if (!blockedByEdits()) show(V.ctx.total - 1); return; }
    if ((e.key === "n" || e.key === "N") && V.info) { e.preventDefault(); return nextUnnamed(); }
  }

  // ---------- open from the page ----------
  // Gallery tiles, FamilySearch photos on a person page and import photos open the viewer directly
  // (before the page's own handlers), so a photo without faces opens too. These are buttons and
  // images, not links, so a modified click opens the viewer as well.
  window.addEventListener("click", e => {
    if (e.button !== 0 || (dlg && dlg.contains(e.target))) return;
    const el = e.target.closest("[data-gallery-open],[data-source-photo],[data-imp-open]");
    if (!el) return;
    const item = itemFor(el);
    if (!item) return;
    e.preventDefault(); e.stopPropagation();
    lastTarget = el;
    openPhotoViewer(item.path, { opener: el.closest("button, a") || el });
  }, true);

  // Captions edited earlier (while this server has been running) aren't in the page's cached
  // /api/static copy yet: patch them in once the page has loaded its data.
  (async () => {
    for (let i = 0; i < 150 && (typeof S === "undefined" || !S); i++) await new Promise(r => setTimeout(r, 200));
    if (typeof S === "undefined" || !S) return;
    const d = await fetch("/api/viewer/caption-edits").then(r => r.ok ? r.json() : null).catch(() => null);
    if (!d || !Object.keys(d.captions || {}).length) return;
    const stores = new Set([S.captions, typeof STATIC !== "undefined" ? STATIC?.captions : null].filter(Boolean));
    for (const store of stores)
      for (const [path, caption] of Object.entries(d.captions)) { if (caption) store[path] = caption; else delete store[path]; }
  })();

  window.openPhotoViewer = openPhotoViewer;
  // The gallery's own simpler viewer (photo-gallery.js) is replaced by this one everywhere.
  window.openPhotoGalleryImage = (index, opener = null) => {
    const d = typeof photoGalleryData !== "undefined" ? photoGalleryData : null;
    const p = d?.photos?.[index];
    if (!p) return;
    const el = opener || document.querySelector(`[data-gallery-open="${index}"]`);
    return openPhotoViewer(p.path, { opener: el, context: galleryContext() });
  };
  window.openPhoto = fid => openPhotoViewer(S.face_photo[fid], { fid: fid == null ? null : +fid });
  window.openPhotoPath = (photo, fid = null) => openPhotoViewer(photo, { fid });
  window.closePhotoViewer = closeViewer;
})();
