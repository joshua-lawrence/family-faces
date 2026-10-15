// Suggested names: a review queue of names the app can fill in, each with its evidence.
// Server side: api/suggest.py (GET /api/suggest, POST /api/suggest/accept|reject). Every answer is one History entry,
// sent through the page's ordered write queue (postJSON), so Cmd-Z, History and U all undo the same thing.
(() => {
  const FETCH_STEP = 300, PAGE = 20;
  const SOURCES = [["all", "All"], ["tag", "FamilySearch tags"], ["only", "Last face left"], ["alike", "Look-alikes"]];
  const SG = {
    data: null,            // last /api/suggest response
    items: [],             // the queue: server order, with skipped items moved to the end
    source: "all",
    active: null,          // key of the item the keys act on
    limit: PAGE,           // cards on the page
    fetchLimit: FETCH_STEP, // items asked from the server (grows as you work down the list)
    skipped: [],           // keys skipped in this visit, in order
    flip: new Map(),       // batch key -> Set of face ids clicked away from their default (sure = selected)
    undo: [],              // newest last: {text, undone, run, id}: id = the History entry U undoes
    inflight: 0,           // label/reject requests still running
    loading: false,        // a new source is on its way: don't show an empty state yet
    guardUntil: 0,         // cards just moved: clicks until then would land on the next card
    lastToggle: null,      // {face, at}: the click a double-click on a face takes back
    req: 0, syncTimer: null, loadTimer: null, pollTimer: null, focusTimer: null, dirty: false, error: null,
  };

  const fmt = n => Number(n || 0).toLocaleString();
  const pct = s => `${Math.round(s * 100)}%`;
  const first = name => String(name).trim().split(/\s+/)[0];
  const poss = name => `${first(name)}’${first(name).endsWith("s") ? "" : "s"}`;
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root = () => $("#sg-root");
  const byKey = key => SG.items.find(i => i.key === key);
  const visibleItems = () => SG.items.filter(i => SG.source === "all" || i.kind === SG.source);
  // Look-alikes follow the FamilySearch matching branch chosen on Groups and Leftovers.
  const branch = () => (typeof reviewSettings !== "undefined" && reviewSettings.branch) || "";
  const isSure = row => row[3] !== false;
  let uidN = 0;
  const uid = () => `sg-h-${++uidN}`;

  function initials(name) {
    const w = String(name).replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
    return ((w[0] || "?")[0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
  }
  function avatar(name, cls = "") {
    const rep = S && S.reps ? S.reps[name] : null;
    return rep != null
      ? `<img class="sg-av ${cls}" src="/thumbs/${rep}.jpg?v=${S.v}" alt="">`
      : `<span class="sg-av sg-initials ${cls}" aria-hidden="true">${esc(initials(name))}</span>`;
  }

  // A change through the app's ordered write queue (postJSON in review.html); throws with the reason if not saved.
  async function save(url, body) {
    const out = await postJSON(url, body, { quiet: true });
    if (out.error) throw new Error(out.status === 0 ? REACH_ERROR : out.error);
    return out;
  }

  // ---------- counts
  function counts() {
    const c = { ...(SG.data?.counts || { tag: 0, only: 0, alike: 0 }) };
    c.all = c.tag + c.only + c.alike;
    return c;
  }
  function setSidebarCount(n) {
    const el = $("#n-suggest");
    if (el) el.textContent = n ? fmt(n) : "";
  }
  let countBusy = false, countTimer = null;
  const refreshCountSoon = () => { clearTimeout(countTimer); countTimer = setTimeout(refreshCount, 1500); };
  async function refreshCount() {
    if (countBusy || tab === "suggest") return;
    countBusy = true;
    try {
      const d = await (await fetch(`/api/suggest?count=1&branch=${encodeURIComponent(branch())}`)).json();
      setSidebarCount(d.faces);
      if (d.building) setTimeout(refreshCount, 1500);
    } catch {} finally { countBusy = false; }
  }

  // ---------- loading the queue
  async function fetchQueue() {
    clearTimeout(SG.pollTimer);
    if (SG.inflight) { SG.pollTimer = setTimeout(fetchQueue, 250); return; }   // let saves land first
    const req = ++SG.req;
    let d;
    try {
      const r = await fetch(`/api/suggest?source=${SG.source}&limit=${SG.fetchLimit}&branch=${encodeURIComponent(branch())}`);
      d = await r.json();
      if (!r.ok) throw new Error(d.error);
    } catch (e) {
      if (req !== SG.req) return;
      SG.loading = false;
      SG.error = "Couldn’t load suggestions. Check that the app is still running, then try again.";
      return paint();
    }
    if (req !== SG.req || SG.inflight) return;
    SG.loading = false;
    SG.error = d.error && !d.items.length ? `Couldn’t work out suggestions: ${d.error}` : null;
    SG.data = d;
    const fresh = d.items, keys = new Set(fresh.map(i => i.key));
    const shownKeys = () => visibleItems().slice(0, SG.limit).map(i => i.key).join("\n");
    const was = shownKeys();
    SG.skipped = SG.skipped.filter(k => keys.has(k));
    const skipped = new Set(SG.skipped);
    SG.items = fresh.filter(i => !skipped.has(i.key)).concat(SG.skipped.map(k => fresh.find(i => i.key === k)));
    if (was && shownKeys() !== was) SG.guardUntil = performance.now() + 400;   // cards moved under the pointer
    for (const k of [...SG.flip.keys()]) if (!keys.has(k)) SG.flip.delete(k);
    if (!byKey(SG.active)) SG.active = visibleItems()[0]?.key ?? null;
    setSidebarCount(d.faces);
    paint();
    if (d.building) SG.pollTimer = setTimeout(fetchQueue, d.items.length ? 2000 : 1000);
  }

  // After changes: refresh the queue soon, and the rest of the app (progress, groups) once things are quiet.
  function scheduleSync() {
    SG.dirty = true;
    clearTimeout(SG.syncTimer); clearTimeout(SG.loadTimer);
    SG.syncTimer = setTimeout(fetchQueue, 1200);
    SG.loadTimer = setTimeout(() => { if (tab === "suggest" && SG.dirty && !SG.inflight) { SG.dirty = false; load(); } }, 6000);
  }

  // ---------- page
  function shell() {
    return `<div id="sg-root" class="sg">
      <p class="help">Names the app can fill in for you, each with the reason it thinks so. Check the face and the photo, then accept or reject. Rejected suggestions don’t come back.</p>
      <div class="sg-bar">
        <div class="seg sg-sources" role="group" aria-label="Show suggestions from"></div>
        <p class="sg-keys meta">Keys: <kbd>Y</kbd> yes · <kbd>N</kbd> no · <kbd>S</kbd> skip · <kbd>J</kbd> <kbd>K</kbd> next and previous · <kbd>U</kbd> or <kbd>${/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl"}</kbd><kbd>Z</kbd> undo · double-click a face for the whole photo</p>
      </div>
      <div class="sg-status" id="sg-status" role="status" aria-live="polite"></div>
      <ol class="sg-list" id="sg-list" aria-label="Suggested names"></ol>
      <div class="sg-foot" id="sg-foot"></div>
    </div>`;
  }

  function paintSources() {
    const el = $(".sg-sources", root()); if (!el) return;
    const c = counts();
    if (!el.children.length)     // built once and updated in place, so keyboard focus stays put
      el.innerHTML = SOURCES.map(([k, label]) => `<button type="button" data-sg-src="${k}">${label} <span class="sg-n"></span></button>`).join("");
    for (const btn of el.children) {
      const k = btn.dataset.sgSrc;
      btn.classList.toggle("on", SG.source === k);
      btn.setAttribute("aria-pressed", String(SG.source === k));
      btn.lastElementChild.textContent = SG.data ? fmt(c[k]) : "–";
    }
    const on = $(".on", el);      // on a phone the row scrolls: keep the chosen source in view
    if (on) {
      const a = el.getBoundingClientRect(), b = on.getBoundingClientRect();
      if (b.right > a.right || b.left < a.left) el.scrollLeft += b.left - a.left - 8;
    }
  }

  let statusMsg = "";
  function paintStatus() {
    const el = $("#sg-status"); if (!el) return;
    const last = SG.undo[SG.undo.length - 1];
    const building = SG.data?.building && SG.data.items.length ? `<span class="meta">Updating suggestions…</span>` : "";
    const button = label => `<button type="button" class="btn sg-undo" data-sg-undo aria-keyshortcuts="U">${label} <kbd aria-hidden="true">U</kbd></button>`;
    el.innerHTML = (statusMsg ? `<span>${statusMsg}</span>${last ? " " + button("Undo again") : ""}`
      : last ? `<span>${last.text}</span> ${button("Undo")}` : "") + building;
    el.classList.toggle("on", !!(last || statusMsg || building));
  }

  function paint() {
    if (!root()) return;
    if (typeof S === "undefined" || !S) {   // drawn early (boot): the cards need the app's state; it's on its way
      paintSources();
      $("#sg-foot").innerHTML = `<div class="empty sg-wait">Loading suggestions…</div>`;
      return;
    }
    paintSources(); paintStatus();
    const list = $("#sg-list"), foot = $("#sg-foot");
    const items = visibleItems();
    if (SG.error) {
      list.innerHTML = "";
      foot.innerHTML = `<div class="empty">${esc(SG.error)}<br><button type="button" class="btn" data-sg-retry>Try again</button></div>`;
      return;
    }
    if (!SG.data || (SG.data.building && !items.length) || (SG.loading && !items.length)) {
      list.innerHTML = "";
      foot.innerHTML = SG.data && !SG.data.building ? `<div class="empty sg-wait">Loading suggestions…</div>`
        : `<div class="empty sg-wait">Finding suggestions… This takes a few seconds after names or photos change.</div>`;
      return;
    }
    const shown = items.slice(0, SG.limit);
    const existing = new Map([...list.children].map(li => [li.dataset.key, li]));
    shown.forEach((item, i) => {
      let li = existing.get(item.key);
      const ver = version(item);
      if (li && li.dataset.ver !== ver) { li.remove(); li = null; }
      if (!li) {
        li = document.createElement("li");
        li.className = "sg-item"; li.dataset.key = item.key; li.dataset.ver = ver;
        li.innerHTML = item.kind === "alike" ? batchCard(item) : singleCard(item);
        wire(li, item);
      }
      existing.delete(item.key);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    for (const li of existing.values()) li.remove();
    for (const li of list.children) li.firstElementChild.classList.toggle("is-active", li.dataset.key === SG.active);
    if (!items.length) {
      const any = counts().all > 0;
      foot.innerHTML = SG.source !== "all" && any
        ? `<div class="empty">No suggestions from this source right now.<br><button type="button" class="btn" data-sg-src="all">Show all suggestions</button></div>`
        : `<div class="empty">No suggestions right now. They appear as you name more people or import tagged photos.</div>`;
    } else {
      const total = Math.max(items.length, SG.data.total_items ?? items.length);
      foot.innerHTML = total > shown.length
        ? `<button type="button" class="btn sg-more" data-sg-more>Show ${Math.min(PAGE, total - shown.length)} more</button>
           <span class="meta">${fmt(shown.length)} of ${fmt(total)} shown</span>` : "";
    }
    moreFromServer();
  }
  // Ask the server for the next part of the list before the page runs out of loaded items.
  function moreFromServer() {
    if (!SG.data || SG.data.building || SG.inflight) return;
    if ((SG.data.total_items ?? 0) > SG.data.items.length && SG.limit + PAGE >= SG.items.length) {
      SG.fetchLimit = SG.data.items.length + FETCH_STEP;
      clearTimeout(SG.pollTimer); SG.pollTimer = setTimeout(fetchQueue, 0);
    }
  }

  function version(item) {
    return item.kind === "alike" ? item.faces.map(r => r[0]).join(",") + "/" + item.total : String(item.sim);
  }

  // ---------- cards
  function why(item) {
    const n = esc(item.name);
    if (item.kind === "tag") {
      const alias = item.tag_name && item.tag_name !== item.name ? ` (saved here as ${n})` : "";
      return `<span class="sg-badge">FamilySearch tag</span> This face is inside the FamilySearch tag box for <b>${esc(item.tag_name || item.name)}</b>${alias}.${copies(item)}`;
    }
    if (item.kind === "only") {
      if (!item.from_tag && item.caption)
        return `<span class="sg-badge">Last face left</span> The caption “${esc(item.caption)}” mentions <b>${esc(first(item.name))}</b>, and this is the only face still unnamed.${copies(item)}`;
      const others = (item.tagged || []).length - 1;
      return `<span class="sg-badge">Last face left</span> FamilySearch says <b>${n}</b>${others > 0 ? ` and ${plural(others, "other person", "other people")}` : ""} ${others > 0 ? "are" : "is"} in this photo${others > 0 ? ". The others are already on faces, and this" : ", and this"} is the only face still unnamed.${copies(item)}`;
    }
    return "";
  }
  // The same image imported twice (two FamilySearch memories): one card names the face in every copy.
  function copies(item) {
    const n = (item.copies || []).length;
    return n ? ` <span class="sg-copies">The same photo was imported ${n === 1 ? "twice" : `${n + 1} times`}; this names the face in ${n === 1 ? "both copies" : "every copy"}.</span>` : "";
  }
  function matchLine(item) {
    if (item.best) {
      const vs = item.sim != null ? ` than ${esc(first(item.name))} (<b class="sg-num">${pct(item.sim)}</b>)` : "";
      return `<p class="sg-match sg-warn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3zM12 10v5M12 18h.01"/></svg><span>Looks more like <b>${esc(item.best[0])}</b> (<b class="sg-num">${pct(item.best[1])}</b>)${vs}. Check the photo before you accept.</span></p>`;
    }
    if (item.sim != null) return `<p class="sg-match">Looks <b class="sg-num">${pct(item.sim)}</b> like ${esc(poss(item.name))} named faces.</p>`;
    return `<p class="sg-match">No named faces of ${esc(first(item.name))} yet, so there’s no face match to compare.</p>`;
  }
  function links(item) {
    const out = [];
    if (item.pid) out.push(`<a href="https://www.familysearch.org/en/tree/person/details/${encodeURIComponent(item.pid)}" target="_blank" rel="noopener noreferrer">FamilySearch record ↗</a>`);
    if (item.source_url) out.push(`<a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">Memory on FamilySearch ↗</a>`);
    return out.length ? `<p class="sg-links meta">${out.join(" · ")}</p>` : "";
  }
  function singleCard(item) {
    const tagBox = item.box ? `<span class="sg-box sg-box-tag" style="left:${item.box[0] * 100}%;top:${item.box[1] * 100}%;width:${(item.box[2] - item.box[0]) * 100}%;height:${(item.box[3] - item.box[1]) * 100}%"></span>` : "";
    const hid = uid();
    return `<article class="sg-card sg-single" tabindex="-1" aria-labelledby="${hid}">
      <div class="sg-visual">
        <div class="face sg-crop" data-face="${item.face}" title="Double-click to see the whole photo"><img src="/thumbs/${item.face}.jpg?v=${S.v}" alt="The face to name"></div>
        <button type="button" class="sg-photo" data-sg-open="${item.face}" aria-label="See the whole photo" title="See the whole photo">
          <span class="sg-frame"><img loading="lazy" decoding="async" src="/gallery-image/${encodeURIComponent(item.photo)}?v=${S.v}" alt="" data-w="${item.img_w || ""}" data-bbox="${item.bbox.join(",")}">${tagBox}<span class="sg-box sg-box-face" hidden></span></span>
        </button>
      </div>
      <div class="sg-body">
        <div class="sg-who">${avatar(item.name)}<h3 class="sg-name" id="${hid}"><span class="sg-q">Is this</span> ${esc(item.name)}?</h3></div>
        <p class="sg-why">${why(item)}</p>
        ${matchLine(item)}
        ${links(item)}
        <div class="sg-actions">
          <button type="button" class="btn primary" data-sg="yes" aria-keyshortcuts="Y">Yes, it’s ${esc(first(item.name))} <kbd aria-hidden="true">Y</kbd></button>
          <button type="button" class="btn" data-sg="no" aria-keyshortcuts="N">Not ${esc(first(item.name))} <kbd aria-hidden="true">N</kbd></button>
          <button type="button" class="btn" data-sg="skip" aria-keyshortcuts="S">Skip <kbd aria-hidden="true">S</kbd></button>
        </div>
      </div>
    </article>`;
  }
  // Faces to name: the sure ones, unless clicked away, plus less sure ones clicked in.
  function picked(item) {
    const flip = SG.flip.get(item.key) || new Set();
    return item.faces.filter(r => isSure(r) !== flip.has(r[0])).map(r => r[0]);
  }
  function nameButton(item) {
    const n = picked(item).length;
    return n ? `Name ${plural(n, "face", "faces")} as ${esc(item.name)}` : "Choose faces to name";
  }
  function batchCard(item) {
    const sel = new Set(picked(item)), name = esc(item.name), who = esc(first(item.name));
    const avg = item.faces.reduce((a, r) => a + r[1], 0) / item.faces.length;
    const sure = item.faces.filter(isSure), less = item.faces.filter(r => !isSure(r));
    const n = item.faces.length, hid = uid();
    const title = !sure.length ? (n === 1 ? `This face might be ${name}` : `These <b class="sg-num">${fmt(n)}</b> faces might be ${name}`)
      : sure.length === 1 ? `This face is probably ${name}` : `These <b class="sg-num">${fmt(sure.length)}</b> faces are probably ${name}`;
    const help = !sure.length ? `None selected yet. Click the ones that are ${who}.`
      : less.length ? `The likely ${sure.length === 1 ? "one is" : "ones are"} selected. Click a face to leave it out or add it.`
      : n === 1 ? "Click the face to leave it out." : "All selected. Click a face to leave it out.";
    const tile = ([id, s, , ok], i) => `<button type="button" class="face sg-pick${ok === false ? " is-less" : ""}" data-face="${id}" aria-pressed="${sel.has(id)}" aria-label="Face ${i + 1}, ${pct(s)} match${ok === false ? ", less sure" : ""}" title="${pct(s)} match. Click to select or leave out, double-click to see the photo"><img loading="lazy" src="/thumbs/${id}.jpg?v=${S.v}" alt=""><span class="sg-tick" aria-hidden="true"></span><span class="tag">${pct(s)}</span></button>`;
    return `<article class="sg-card sg-batch" tabindex="-1" aria-labelledby="${hid}">
      <div class="sg-batch-head">
        ${avatar(item.name, "lg")}
        <div>
          <h3 class="sg-name" id="${hid}">${title}</h3>
          <p class="sg-why"><span class="sg-badge">Look-alikes</span> ${n === 1 ? "It looks" : "Each one looks"} most like ${who}, at least 10 points ahead of anyone else. Average match <b class="sg-num">${pct(avg)}</b>.</p>
        </div>
      </div>
      <div class="sg-batch-body">
        ${item.refs.length ? `<figure class="sg-refs"><figcaption class="meta">Named faces of ${esc(first(item.name))}</figcaption>
          <div class="sg-ref-grid">${item.refs.map(id => `<div class="face sg-ref" data-face="${id}" title="Double-click to see the whole photo"><img loading="lazy" src="/thumbs/${id}.jpg?v=${S.v}" alt=""></div>`).join("")}</div></figure>` : ""}
        <div class="sg-picks-wrap">
          <p class="meta sg-pick-help">${help} Faces you leave out won’t be suggested as ${who} again.</p>
          ${sure.length ? `<div class="sg-picks" role="group" aria-label="Faces to name ${name}">${sure.map(tile).join("")}</div>` : ""}
          ${less.length && sure.length ? `<p class="meta sg-less"><b>Less sure</b> A lower match or a small face, so not selected. Click any that are ${who}.</p>` : ""}
          ${less.length ? `<div class="sg-picks" role="group" aria-label="${sure.length ? "Less sure faces" : `Faces that might be ${name}`}">${less.map((r, i) => tile(r, sure.length + i)).join("")}</div>` : ""}
          ${item.total > n ? `<p class="meta">Showing ${fmt(n)} of ${fmt(item.total)}. The rest come next.</p>` : ""}
        </div>
      </div>
      <div class="sg-actions">
        <button type="button" class="btn primary" data-sg="yes" aria-keyshortcuts="Y" ${picked(item).length ? "" : "disabled"}>${nameButton(item)} <kbd aria-hidden="true">Y</kbd></button>
        <button type="button" class="btn" data-sg="no" aria-keyshortcuts="N">${n === 1 ? "Not" : "None are"} ${esc(first(item.name))} <kbd aria-hidden="true">N</kbd></button>
        <button type="button" class="btn" data-sg="skip" aria-keyshortcuts="S">Skip <kbd aria-hidden="true">S</kbd></button>
      </div>
    </article>`;
  }

  // Place the face box on the photo once its size is known (face boxes are in pixels of the full photo).
  function wire(li, item) {
    if (item.kind === "alike") return;
    const img = $(".sg-photo img", li), box = $(".sg-box-face", li);
    const place = () => {
      const w = +img.dataset.w || img.naturalWidth, h = w * img.naturalHeight / img.naturalWidth;
      if (!w || !h) return;
      img.parentElement.style.setProperty("--r", (img.naturalWidth / img.naturalHeight).toFixed(4));
      const [x1, y1, x2, y2] = img.dataset.bbox.split(",").map(Number);
      Object.assign(box.style, { left: `${x1 / w * 100}%`, top: `${y1 / h * 100}%`, width: `${(x2 - x1) / w * 100}%`, height: `${(y2 - y1) / h * 100}%` });
      box.hidden = false;
    };
    if (img.complete && img.naturalWidth) place(); else img.addEventListener("load", place, { once: true });
    img.addEventListener("error", () => li.querySelector(".sg-photo").classList.add("is-missing"), { once: true });
  }

  // ---------- moving around
  function setActive(key, { scroll = true, focus = true } = {}) {
    SG.active = key;
    const list = $("#sg-list"); if (!list) return;
    let card = null;
    for (const li of list.children) {
      const on = li.dataset.key === key;
      li.firstElementChild.classList.toggle("is-active", on);
      if (on) card = li.firstElementChild;
    }
    if (!card) return;
    if (scroll) card.scrollIntoView({ block: "nearest", behavior: reduced() ? "auto" : "smooth" });
    if (focus && !card.contains(document.activeElement)) card.focus({ preventScroll: true });
  }
  function move(step) {
    const items = visibleItems();
    if (!items.length) return;
    let i = items.findIndex(it => it.key === SG.active);
    i = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + step));
    if (i >= SG.limit) { SG.limit = i + PAGE; paint(); }
    setActive(items[i].key);
  }
  // Remove items from the queue (optimistically) and make the next one active. Returns how to put them back.
  function takeOut(pred, after) {
    SG.guardUntil = performance.now() + 400;
    const before = SG.items.slice(), vis = visibleItems();
    const idx = vis.findIndex(i => i.key === SG.active);
    SG.items = SG.items.filter(i => !pred(i));
    const rest = visibleItems();
    if (!byKey(SG.active)) SG.active = (rest[Math.min(Math.max(idx, 0), rest.length - 1)] || {}).key ?? null;
    if (after) after();
    paint(); setActive(SG.active, { scroll: true });
    return () => { SG.items = before; };
  }
  function pushUndo(text, undone, run, id = null) {
    SG.undo.push({ text, undone, run, id });
    if (SG.undo.length > 30) SG.undo.shift();
    statusMsg = "";
    paintStatus();
  }
  function adjustCounts(kind, n) {
    if (SG.data) { SG.data.counts[kind] = Math.max(0, SG.data.counts[kind] - n); SG.data.faces = Math.max(0, SG.data.faces - n); setSidebarCount(SG.data.faces); }
  }
  function bumpProgress(faces, sign) {
    if (!S) return;
    S.labeled += sign * faces.length;
    if (S.album_labeled != null) S.album_labeled += sign * faces.filter(f => S.photo_sources?.[S.face_photo[f]] !== "FamilySearch").length;
    try { header(); } catch {}
    setSidebarCount(SG.data?.faces);
  }

  async function run(work, restore, failText) {
    SG.inflight++;
    try { await work(); }
    catch (e) { restore(); paint(); toast(`${failText} ${e.message}`, true); scheduleSync(); return false; }
    finally { SG.inflight--; }
    scheduleSync();
    return true;
  }

  async function accept(item) {
    const chosen = item.kind === "alike" ? picked(item) : [item.face];
    if (!chosen.length) return toast(`Choose at least one face, or press N if none of them are ${first(item.name)}.`, true);
    const faces = chosen.concat((item.copies || []).map(c => c.face));   // the same face in copies of the photo
    const leftOut = item.kind === "alike" ? item.faces.map(r => r[0]).filter(f => !chosen.includes(f)) : [];
    const name = item.name, set = new Set(faces), photos = new Set(faces.map(f => S.face_photo[f]));
    adjustCounts(item.kind, chosen.length);
    // The person is now placed in these photos, so other suggestions of them there go too
    // (batches are copied, not changed in place, so a failed save can put them back).
    const restore = takeOut(i => i === item || (i.kind !== "alike" && (set.has(i.face) || (i.name === name && photos.has(i.photo)))),
      () => {
        SG.items = SG.items.map(b => {
          if (b.kind !== "alike") return b;
          const keep = b.faces.filter(r => !set.has(r[0]) && !(b.name === name && photos.has(S.face_photo[r[0]])));
          return keep.length === b.faces.length ? b : { ...b, faces: keep, total: b.total - (b.faces.length - keep.length) };
        }).filter(b => b.kind !== "alike" || b.faces.length);
      });
    let r = null;
    // One request: names the faces that still have no name (a page left open mustn't overwrite a name set elsewhere)
    // and remembers the faces left out of a batch, as one change that one Undo takes back.
    const ok = await run(async () => { r = await save("/api/suggest/accept", { faces, name, reject: leftOut }); }, restore, "Couldn’t save that name.");
    if (!ok) return;
    const named = r.named || [];
    const kept = faces.length - named.length;
    if (kept) toast(faces.length === 1 ? "That face already has a name now, so it was left as it is."
      : `${kept === faces.length ? "All" : fmt(kept)} of these faces already had names, so ${kept === 1 ? "it was" : "they were"} left as they are.`, true);
    if (!r.history) return;
    bumpProgress(named, 1);
    pushUndo(named.length ? `Named ${plural(named.length, "face", "faces")} as <b>${esc(name)}</b>${leftOut.length ? `, and won’t suggest ${esc(first(name))} for the ${plural(leftOut.length, "face", "faces")} you left out` : ""}.`
        : `Won’t suggest <b>${esc(name)}</b> for ${leftOut.length === 1 ? "that face" : `those ${fmt(leftOut.length)} faces`} again.`,
      named.length ? `Took the name <b>${esc(name)}</b> off ${named.length === 1 ? "that face" : `those ${fmt(named.length)} faces`} again.`
        : `<b>${esc(name)}</b> is back in the list.`, async () => {
      const u = await undoChange(r.history.id);
      if (!u || u.error || u.nothing) throw new Error(u?.message || "");
      bumpProgress(named, -1);
      return item.key;
    }, r.history.id);
  }

  async function reject(item) {
    const faces = (item.kind === "alike" ? item.faces.map(r => r[0]) : [item.face]).concat((item.copies || []).map(c => c.face));
    adjustCounts(item.kind, item.kind === "alike" ? item.faces.length : 1);
    const restore = takeOut(i => i === item);
    let r = null;
    const ok = await run(async () => { r = await save("/api/suggest/reject", { faces, name: item.name }); }, restore, "Couldn’t save that.");
    if (!ok || !r.history) return;
    pushUndo(`Won’t suggest <b>${esc(item.name)}</b> for ${faces.length === 1 ? "that face" : `those ${fmt(faces.length)} faces`} again.`,
      `<b>${esc(item.name)}</b> is back in the list.`, async () => {
      const u = await undoChange(r.history.id);
      if (!u || u.error || u.nothing) throw new Error(u?.message || "");
      return item.key;
    }, r.history.id);
  }

  function skip(item) {
    const items = visibleItems(), idx = items.indexOf(item);
    SG.guardUntil = performance.now() + 400;
    SG.skipped = SG.skipped.filter(k => k !== item.key).concat(item.key);
    SG.items = SG.items.filter(i => i !== item).concat(item);
    const rest = visibleItems().filter(i => i !== item);
    SG.active = (rest[Math.min(idx, rest.length - 1)] || item).key;
    paint(); setActive(SG.active);
    pushUndo(`Skipped ${esc(item.name)} for now. It’s at the end of the list.`, `<b>${esc(item.name)}</b> is back in its place.`, async () => {
      SG.skipped = SG.skipped.filter(k => k !== item.key);
      SG.items = [item].concat(SG.items.filter(i => i !== item));
      return item.key;
    });
  }

  let undoing = false;
  async function undo() {
    const last = SG.undo.pop();
    if (!last || undoing) { if (last) SG.undo.push(last); return; }
    undoing = true;
    SG.inflight++;
    try {
      const key = await last.run();
      statusMsg = `Undone. ${last.undone}`;
      SG.active = key;
    } catch (e) {
      if (e.message) toast(`Couldn’t undo that. ${e.message}`, true);   // the app's own message is already shown
    } finally { SG.inflight--; undoing = false; }
    paintStatus();
    clearTimeout(SG.syncTimer);
    await fetchQueue();
    // Back to the card that came back (or the one you were on), so the keys keep working where you are.
    if (!byKey(SG.active)) SG.active = visibleItems()[0]?.key ?? null;
    if (SG.active) {
      const i = visibleItems().findIndex(it => it.key === SG.active);
      if (i >= SG.limit) { SG.limit = i + PAGE; paint(); }
      setActive(SG.active);
    }
    scheduleSync();
  }

  function act(kind, item) {
    if (!item) return;
    if (kind === "yes") return accept(item);
    if (kind === "no") return reject(item);
    if (kind === "skip") return skip(item);
  }

  function setSource(src) {
    if (!SOURCES.some(([k]) => k === src) || src === SG.source) return;
    SG.source = src; SG.limit = PAGE; SG.fetchLimit = FETCH_STEP; SG.active = null; SG.data = SG.data && { ...SG.data, items: [] }; SG.items = [];
    SG.loading = true;
    syncURL();
    paint(); fetchQueue();
  }

  // ---------- events
  document.addEventListener("click", e => {
    if (tab !== "suggest" || !root()) return;
    const src = e.target.closest("[data-sg-src]");
    if (src) return setSource(src.dataset.sgSrc);
    if (e.target.closest("[data-sg-undo]")) return e.detail > 1 ? undefined : undo();   // a double-click undoes once
    if (e.target.closest("[data-sg-retry]")) { SG.error = null; paint(); return fetchQueue(); }
    if (e.target.closest("[data-sg-more]")) { SG.limit += PAGE; return paint(); }
    const li = e.target.closest(".sg-item");
    if (!li) return;
    const item = byKey(li.dataset.key);
    if (!item) return;
    if (SG.active !== item.key) setActive(item.key, { scroll: false, focus: false });
    const open = e.target.closest("[data-sg-open]");
    if (open) return openPhoto(+open.dataset.sgOpen);
    // A double-click, or a click just after the cards moved, would land on the next card: ignore those.
    // (Keyboard presses have e.detail 0 and always count.)
    const stray = e.detail > 1 || (e.detail > 0 && performance.now() < SG.guardUntil);
    const pick = e.target.closest(".sg-pick");
    if (pick) {
      if (stray) return;                 // the second click of a double-click opens the photo instead
      togglePick(li, item, pick);
      SG.lastToggle = { face: +pick.dataset.face, at: performance.now() };
      return;
    }
    const btn = e.target.closest("[data-sg]");
    if (btn && !btn.disabled && !stray) act(btn.dataset.sg, item);
  });
  function togglePick(li, item, pick) {
    const id = +pick.dataset.face;
    const flip = SG.flip.get(item.key) || new Set();
    flip.has(id) ? flip.delete(id) : flip.add(id);
    SG.flip.set(item.key, flip);
    pick.setAttribute("aria-pressed", String(picked(item).includes(id)));
    const yes = $('[data-sg="yes"]', li);
    yes.innerHTML = `${nameButton(item)} <kbd aria-hidden="true">Y</kbd>`;
    yes.disabled = !picked(item).length;
  }
  // Tabbing into a card makes it the one the keys act on.
  document.addEventListener("focusin", e => {
    if (tab !== "suggest") return;
    const li = e.target.closest && e.target.closest(".sg-item");
    if (li && li.dataset.key !== SG.active && byKey(li.dataset.key)) setActive(li.dataset.key, { scroll: false, focus: false });
  });
  document.addEventListener("dblclick", e => {
    if (tab !== "suggest") return;
    // Double-clicking a face opens the photo: take back the toggle its first click made.
    const pick = e.target.closest(".sg-pick"), last = SG.lastToggle;
    if (!pick || !last || last.face !== +pick.dataset.face || performance.now() - last.at > 800) return;
    SG.lastToggle = null;
    const li = pick.closest(".sg-item"), item = li && byKey(li.dataset.key);
    if (item) togglePick(li, item, pick);
  });
  document.addEventListener("keydown", e => {
    if (tab !== "suggest" || !root() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if ($("#modal")?.classList.contains("on") || document.querySelector("dialog[open]")) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable=true]")) return;
    // The letter keys belong to the suggestion list: not to the sidebar, the page header or a control elsewhere.
    if (e.target.closest?.("aside, nav, .page-head, #floating, .toast") || (e.target.matches?.("a, button") && !e.target.closest("#sg-root"))) return;
    const k = e.key.toLowerCase();
    if (!["y", "n", "s", "j", "k", "u"].includes(k)) return;
    e.preventDefault();
    if (k === "j") return move(1);
    if (k === "k") return move(-1);
    if (k === "u") return undo();
    const item = byKey(SG.active) || visibleItems()[0];
    if (!item) return;
    if (k === "y" && item.kind === "alike" && !picked(item).length) return toast(`Choose at least one face, or press N if none of them are ${first(item.name)}.`, true);
    act({ y: "yes", n: "no", s: "skip" }[k], item);
  });
  // Undo or redo anywhere (Cmd-Z, a toast, History): forget U entries for changes that are now undone, and
  // refresh the queue at once so what was taken back reappears.
  document.addEventListener("app:saved", e => {
    const h = e.detail || {};
    if (h.kind !== "undo" && h.kind !== "redo") return;
    if (h.kind === "undo" && h.undoes != null) {
      const before = SG.undo.length;
      SG.undo = SG.undo.filter(u => u.id !== h.undoes);
      if (SG.undo.length !== before && !undoing) { statusMsg = ""; }
    }
    if (tab === "suggest" && root()) { paintStatus(); clearTimeout(SG.syncTimer); fetchQueue(); }
  });
  // Coming back to the window: names may have changed in another tab, so refresh the queue.
  const onReturn = () => {
    if (tab !== "suggest" || !root() || document.visibilityState !== "visible") return;
    clearTimeout(SG.focusTimer); SG.focusTimer = setTimeout(fetchQueue, 50);
  };
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("focus", onReturn);
  // Leaving the page after naming faces: bring the rest of the app up to date.
  const leave = () => { if (tab !== "suggest" && SG.dirty) { SG.dirty = false; clearTimeout(SG.loadTimer); setTimeout(load, 0); } };
  document.addEventListener("click", e => { if (e.target.closest("[data-tab]")) setTimeout(leave, 0); });
  window.addEventListener("popstate", () => setTimeout(leave, 0));

  // Keep the sidebar count fresh when names change anywhere in the app.
  const baseLoad = load;
  load = async function (...args) { const r = await baseLoad.apply(this, args); refreshCountSoon(); return r; };

  registerTab("suggest", {
    title: "Suggested names", group: "Name faces", first: true, countId: "n-suggest", boot: true,
    icon: '<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    render(main) {
      $("#page-title").textContent = "Suggested names";
      if (!root()) {
        main.innerHTML = shell();
        SG.limit = PAGE; SG.error = null; statusMsg = "";
        paint();
      }
      fetchQueue();
    },
    getRoute() { return { sub: null, params: { source: SG.source === "all" ? "" : SG.source } }; },
    setRoute({ params }) {
      const src = SOURCES.some(([k]) => k === params.source) ? params.source : "all";
      if (src !== SG.source) { SG.source = src; SG.limit = PAGE; SG.fetchLimit = FETCH_STEP; SG.active = null; SG.items = []; SG.loading = true; }
    },
  });
  refreshCount();
})();
