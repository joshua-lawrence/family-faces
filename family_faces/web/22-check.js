// Check names: named faces that are probably wrong, most suspicious first (server: api/check.py).
// Changing or removing a name goes through /api/label via the ordered write queue (postJSON), so Cmd-Z and
// History undo it; "Looks right" is remembered in data/check-ok.json and hides the face until its name changes.
(() => {
  const PAGE = 20;
  const WINDOWS = [["day", "Named today"], ["week", "Last 7 days"], ["all", "All names"]];
  const SORTS = [["suspicious", "Most likely wrong"], ["recent", "Recently named"], ["fit", "Least like their person"],
                 ["name", "Name (A–Z)"], ["other", "Looks like (A–Z)"], ["photo", "Photo"]];
  const CK = { window: "week", sort: "suspicious", data: null, items: [], active: null, limit: PAGE, skipped: [], busy: false, timer: null };
  const fmt = n => Number(n || 0).toLocaleString();
  const pct = s => `${Math.round(s * 100)}%`;
  const first = n => String(n).trim().split(/\s+/)[0];
  const root = () => $("#ck-root");
  const thumb = id => `/thumbs/${id}.jpg?v=${S ? S.v : ""}`;
  const REASON = {
    conflict: it => `${esc(it.name)} is on two faces in this photo, so one of them is wrong.`,
    other: it => `Looks more like ${esc(it.other_name)} (${pct(it.other)}) than like ${esc(first(it.name))}’s other photos (${pct(it.fit)}).`,
    weak: it => `Doesn’t look much like ${esc(first(it.name))}’s other photos (${pct(it.fit)}).`,
  };

  async function fetchQueue() {
    clearTimeout(CK.timer);
    const r = await fetch(`/api/check?window=${CK.window}&sort=${CK.sort}&limit=${CK.limit + CK.skipped.length + 40}`).then(r => r.json()).catch(() => null);
    if (!r) { CK.data = { error: "The app isn’t answering. Check that it’s still running." }; return paint(); }
    CK.data = r;
    const skip = new Set(CK.skipped);
    CK.items = [...r.items.filter(i => !skip.has(i.face)), ...r.items.filter(i => skip.has(i.face))];
    if (!CK.items.some(i => i.face === CK.active)) CK.active = CK.items[0]?.face ?? null;
    paint();
    if (r.building) CK.timer = setTimeout(fetchQueue, 1200);
  }

  function refs(name) {
    const ids = (CK.data?.refs?.[name] || []).slice(0, 4);
    return ids.map(id => `<img src="${thumb(id)}" alt="" loading="lazy">`).join("") || `<span class="meta">No other photos</span>`;
  }

  function card(it) {
    const on = it.face === CK.active;
    return `<article class="ck-card ${on ? "on" : ""}" data-ck="${it.face}" tabindex="-1" aria-label="${esc(it.name)}, ${it.reason === "conflict" ? "name used twice in one photo" : "possible mistake"}">
      <button class="ck-face" data-ck-open="${it.face}" title="Open the photo"><img src="${thumb(it.face)}" alt="The face named ${esc(it.name)}"></button>
      <div class="ck-body">
        <div class="ck-title">Named <b>${esc(it.name)}</b></div>
        <p class="ck-why">${REASON[it.reason](it)}</p>
        <div class="ck-compare">
          <div><span class="ck-label">${esc(it.name)}</span><div class="ck-refs">${refs(it.name)}</div></div>
          <div><span class="ck-label">${esc(it.other_name)} <span class="ck-num">${pct(it.other)}</span></span><div class="ck-refs">${refs(it.other_name)}</div></div>
        </div>
        <div class="ck-actions">
          <button class="btn primary" data-ck-act="ok" data-face="${it.face}">Looks right <kbd>K</kbd></button>
          <button class="btn" data-ck-act="other" data-face="${it.face}">Change to ${esc(first(it.other_name))} <kbd>C</kbd></button>
          <button class="btn" data-ck-act="remove" data-face="${it.face}">Remove name <kbd>R</kbd></button>
          <span class="ck-rename"><input class="name" list="people-list" placeholder="Someone else…" data-ck-name="${it.face}" aria-label="Correct name for this face"></span>
          <button class="btn link" data-ck-act="skip" data-face="${it.face}">Skip <kbd>S</kbd></button>
        </div>
      </div>
    </article>`;
  }

  function shell() {
    return `<div id="ck-root">
      <p class="help">Faces whose name looks wrong: they look more like someone else, barely like the person they’re named as, or share a name with another face in the same photo. Keys: <kbd>K</kbd> looks right · <kbd>C</kbd> change to the closer match · <kbd>R</kbd> remove the name · <kbd>S</kbd> skip · <kbd>↑</kbd><kbd>↓</kbd> move.</p>
      <div class="toolbar"><span class="seg" role="group" aria-label="Which names to check">${WINDOWS.map(([k, l]) => `<button data-ck-window="${k}" class="${CK.window === k ? "on" : ""}">${l}</button>`).join("")}</span>
        <label class="ck-sort">Sort <select data-ck-sort aria-label="Sort the queue">${SORTS.map(([k, l]) => `<option value="${k}" ${CK.sort === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <span class="meta" id="ck-count"></span></div>
      <div id="ck-list"></div></div>`;
  }

  function paint() {
    if (!root()) return;
    document.querySelectorAll("[data-ck-window]").forEach(b => b.classList.toggle("on", b.dataset.ckWindow === CK.window));
    const sel = $("[data-ck-sort]"); if (sel) sel.value = CK.sort;
    const d = CK.data, list = $("#ck-list"), count = $("#ck-count");
    if (!d) { list.innerHTML = `<div class="empty">Looking for likely mistakes…</div>`; return; }
    if (d.error && !d.items?.length) { list.innerHTML = `<div class="empty">${esc(d.error)}</div>`; return; }
    if (d.building && !d.items.length) { list.innerHTML = `<div class="empty">Comparing every named face with its person… a few seconds.</div>`; return; }
    const c = d.counts || {};
    count.innerHTML = `<span class="ck-num">${fmt(c.shown)}</span> to check${CK.window !== "all" ? ` · ${fmt(c.all)} in all names` : ""}`;
    const n = $("#n-check"); if (n) n.textContent = c.shown ? fmt(c.shown) : "";
    if (!CK.items.length) {
      list.innerHTML = `<div class="empty">${CK.window === "all" ? "No likely mistakes. Every name looks like the person it’s on." : `No likely mistakes in ${CK.window === "day" ? "today’s" : "this week’s"} names. <button class="btn" data-ck-window="all">Check all names</button>`}</div>`;
      return;
    }
    const shown = CK.items.slice(0, CK.limit);
    list.innerHTML = shown.map(card).join("") +
      (CK.items.length > CK.limit ? `<button class="btn more" data-ck-more>Show more</button>` : "");
  }

  function focusActive() {
    const el = document.querySelector(`.ck-card[data-ck="${CK.active}"]`);
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: "nearest" }); }
  }
  function move(delta) {
    const i = CK.items.findIndex(x => x.face === CK.active);
    const next = CK.items[Math.max(0, Math.min(CK.items.length - 1, i + delta))];
    if (next) { CK.active = next.face; paint(); focusActive(); }
  }
  function drop(face) {
    const i = CK.items.findIndex(x => x.face === face);
    CK.items.splice(i, 1);
    CK.active = (CK.items[i] || CK.items[i - 1] || {}).face ?? null;
    if (CK.data?.counts) CK.data.counts.shown = Math.max(0, (CK.data.counts.shown || 1) - 1);
    paint(); focusActive();
  }

  async function act(kind, face, typed) {
    const it = CK.items.find(x => x.face === face);
    if (!it || CK.busy) return;
    if (kind === "skip") { CK.skipped.push(face); CK.items.push(CK.items.splice(CK.items.indexOf(it), 1)[0]); move(0); return; }
    CK.busy = true;
    try {
      let out, msg;
      if (kind === "ok") { out = await postJSON("/api/check/ok", { faces: [face] }, { quiet: true }); msg = `Kept ${it.name}.`; }
      else if (kind === "remove") { out = await postJSON("/api/label", { faces: [face], name: null }, { quiet: true }); msg = `Removed the name ${it.name}.`; }
      else {
        const name = kind === "other" ? it.other_name : typed;
        out = await postJSON("/api/label", { faces: [face], name }, { quiet: true });
        msg = `Renamed to ${name}.`;
      }
      if (out && out.error) throw new Error(out.error);
      drop(face);
      const canUndo = kind !== "ok" && typeof undoLast === "function";
      toast(msg, canUndo ? { action: { label: "Undo", run: async () => { await undoLast(); fetchQueue(); } } } : undefined);
    } catch (e) {
      toast(`Couldn’t save that. ${e.message || ""}`, true);
    } finally { CK.busy = false; }
  }

  document.addEventListener("click", e => {
    if (tab !== "check") return;
    const t = e.target.closest("[data-ck-window],[data-ck-act],[data-ck-open],[data-ck-more],.ck-card");
    if (!t) return;
    if (t.dataset.ckWindow) { CK.window = t.dataset.ckWindow; CK.limit = PAGE; CK.skipped = []; CK.items = []; CK.data = null; syncURL(); paint(); return fetchQueue(); }
    if (t.dataset.ckMore !== undefined) { CK.limit += PAGE; return fetchQueue(); }
    if (t.dataset.ckOpen) return openPhoto(+t.dataset.ckOpen);
    if (t.dataset.ckAct) return act(t.dataset.ckAct, +t.dataset.face);
    if (t.classList.contains("ck-card") && +t.dataset.ck !== CK.active) { CK.active = +t.dataset.ck; paint(); focusActive(); }
  });
  document.addEventListener("change", e => {
    if (tab !== "check" || !e.target.matches?.("[data-ck-sort]")) return;
    CK.sort = e.target.value; CK.limit = PAGE; CK.skipped = []; CK.items = []; CK.data = null; CK.active = null;
    syncURL(); paint(); fetchQueue();
  });
  document.addEventListener("keydown", e => {
    if (tab !== "check" || e.metaKey || e.ctrlKey || e.altKey) return;
    const input = e.target.closest?.("[data-ck-name]");
    if (input) {
      if (e.key === "Enter" && input.value.trim()) { e.preventDefault(); act("rename", +input.dataset.ckName, input.value.trim()); }
      if (e.key === "Escape") input.blur();
      return;
    }
    if (e.target.matches?.("input, textarea, select") || CK.active == null) return;
    const k = e.key.toLowerCase();
    const map = { k: "ok", c: "other", r: "remove", s: "skip" };
    if (map[k]) { e.preventDefault(); act(map[k], CK.active); }
    else if (e.key === "ArrowDown" || k === "j") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
  });

  registerTab("check", {
    title: "Check names", group: "Name faces", countId: "n-check",
    icon: '<path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
    render(main) {
      $("#page-title").textContent = "Check names";
      if (!root()) { main.innerHTML = shell(); paint(); }
      fetchQueue();
    },
    getRoute() { return { sub: null, params: { window: CK.window === "week" ? "" : CK.window, sort: CK.sort === "suspicious" ? "" : CK.sort } }; },
    setRoute({ params }) {
      const w = WINDOWS.some(([k]) => k === params.window) ? params.window : "week";
      const s = SORTS.some(([k]) => k === params.sort) ? params.sort : "suspicious";
      if (w !== CK.window || s !== CK.sort) { CK.window = w; CK.sort = s; CK.items = []; CK.data = null; CK.skipped = []; }
    },
  });
})();
