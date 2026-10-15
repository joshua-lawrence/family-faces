// History tab, undo and redo (server side: api/history.py).
//   undoChange(id)  undoes one History entry (for an "Undid" entry: redoes it); undoLast() the latest change.
//   Cmd/Ctrl-Z undoes and Shift-Cmd/Ctrl-Z (or Ctrl-Y) redoes, anywhere outside a text field (also in the
//   photo viewer). Every write goes through postJSON (review.html), so the redo stack is cleared by any new
//   change, and an undo always goes out after the changes made before it.
//   undoChange resolves to the server's answer; it fires "app:saved" (kind undo/redo) like any write, so pages
//   that keep their own lists (Suggested names, the viewer) can refresh.

let redoStack = [];   // undo entries made on this page, newest last
const undoPending = new Set();   // entry ids with an undo on its way, so a double click sends one
document.addEventListener("app:saved", e => { if (e.detail.kind === "change") redoStack = []; });

async function undoChange(id = null) {
  if (id != null) {
    if (undoPending.has(id)) return { pending: true };
    undoPending.add(id);
    redoStack = redoStack.filter(x => x !== id);
  }
  let r;
  try { r = await postJSON("/api/undo", id == null ? {} : { id }); }
  finally { if (id != null) undoPending.delete(id); }
  if (r.error || r.nothing) {   // errors are already shown as a warning toast
    if (r.nothing) toast(r.message, { action: null });
    if (tab === "history") renderHistory($("#main"));   // so the list shows why
    return r;
  }
  const h = r.history;
  if (h) {
    if (h.kind === "undo") redoStack.push(h.id);
    toast(h.action, { action: { label: h.kind === "undo" ? "Redo" : "Undo", run: () => undoChange(h.id) } });
  } else {
    toast("Nothing needed changing: it was already like that.", { action: null });
  }
  // A rename or merge that was undone: follow the person to the name they have now.
  const moved = r.people || {};
  if (person && !person.startsWith("_") && moved[person]) person = moved[person];
  await load();
  if (person && !person.startsWith("_") && S && !(person in S.people) && !(person in (S.hidden_people || {}))) {
    person = null; P = null; render();   // e.g. undid the naming of someone's only faces
  }
  return r;
}
function undoLast() { return undoChange(null); }
function redoLast() {
  const id = redoStack.pop();
  if (id == null) { toast("Nothing to redo.", { action: null }); return Promise.resolve(null); }
  return undoChange(id);
}

document.addEventListener("keydown", e => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.defaultPrevented) return;
  const k = e.key.toLowerCase();
  const redo = (k === "z" && e.shiftKey) || (k === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey);
  if (k !== "z" && !redo) return;
  const t = e.target;
  // The field undoes its own typing. Exception: the naming loop (web/10-naming.js) moves focus into the
  // next card's empty name box after each save, so there Cmd-Z means "undo that save".
  const namingBox = t.matches?.("input[data-nm-key]") && !t.value;
  if (!namingBox && (t.isContentEditable || t.closest?.("textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=range])"))) return;
  const open = [...document.querySelectorAll("dialog[open]")];
  if (open.some(d => d.id !== "photo-viewer")) return;   // other dialogs keep Cmd-Z to themselves
  e.preventDefault();
  if (e.repeat) return;
  redo ? redoLast() : undoLast();
});

// ---------- History tab ----------
const HIST = { limit: 50, req: 0, focus: null };
const HIST_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

registerTab("history", {
  title: "History", group: "Library", boot: true,
  icon: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/>',
  render: main => renderHistory(main),
  getRoute: () => ({ sub: null, params: {} }),
  setRoute() { HIST.limit = 50; },
});

async function renderHistory(main) {
  $("#page-title").textContent = "History";
  const req = ++HIST.req;
  if (!main.querySelector(".hist")) main.innerHTML = `<div class="hist"><p class="empty" role="status">Loading your changes…</p></div>`;
  let d;
  try {
    const r = await fetch(`/api/history?limit=${HIST.limit}`);
    d = await r.json();
    if (!r.ok) throw new Error(d.error || "");
  } catch (err) {
    if (req === HIST.req && tab === "history")
      main.innerHTML = `<div class="hist"><p class="empty" role="alert">Couldn’t load the history${err.message ? ` (${esc(err.message)})` : ""}. <button class="btn" id="hist-retry">Try again</button></p></div>`;
    return;
  }
  if (req !== HIST.req || tab !== "history") return;
  main.innerHTML = histPage(d);
  const row = HIST.focus != null && main.querySelector(`[data-hid="${HIST.focus}"]`);
  if (row) { (row.querySelector("button") || row).focus(); HIST.focus = null; }
}

function histDay(t) {
  const day = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return t.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", ...(t.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
const histTime = t => t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function histCounts(c = {}) {
  const n = (k, one, many) => c[k] ? `<b>${c[k].toLocaleString()}</b> ${c[k] === 1 ? one : many}` : "";
  return [n("faces", "face", "faces"), n("tree", "tree change", "tree changes"),
          n("people", "person’s details", "people’s details"), n("photos", "photo", "photos")].filter(Boolean).join(" · ");
}

function histRow(e) {
  const t = new Date(e.time), isUndo = e.kind === "undo";
  const verb = isUndo ? "Redo" : "Undo";
  const more = (e.counts?.faces || 0) - (e.faces?.length || 0);
  const faces = e.faces?.length ? `<div class="hist-faces" aria-hidden="true">${e.faces.map(id =>
    `<img loading="lazy" src="/thumbs/${id}.jpg?v=${S?.v ?? 0}" alt="">`).join("")}${more > 0 ? `<span class="hist-more">+${more.toLocaleString()}</span>` : ""}</div>` : "";
  const what = isUndo ? e.action.replace(/^(Undid|Redid): /, "") : e.action;
  const act = e.can_undo
    ? `<button class="btn" data-hist-undo="${e.id}" aria-label="${verb}: ${esc(what)}">${verb}</button>`
    : e.undone ? `<span class="hist-status">${isUndo ? "Redone" : "Undone"}</span>` : "";
  const reason = !e.can_undo && !e.undone && e.reason ? `<p class="hist-reason">Can’t ${verb.toLowerCase()}: ${esc(e.reason.charAt(0).toLowerCase() + e.reason.slice(1))}</p>` : "";
  const counts = histCounts(e.counts);
  return `<li class="hist-row${e.undone ? " is-undone" : ""}${isUndo ? " is-undo" : ""}" data-hid="${e.id}" tabindex="-1">
    <time class="hist-time" datetime="${esc(e.time)}">${esc(histTime(t))}</time>
    <div class="hist-body"><p class="hist-action">${esc(e.action)}${e.undone ? `<span class="hist-sr"> (${isUndo ? "redone" : "undone"})</span>` : ""}</p>
      ${counts ? `<p class="meta hist-counts">${counts}</p>` : ""}${reason}${faces}</div>
    <div class="hist-do">${act}</div>
  </li>`;
}

function histBackups(s) {
  if (!s) return "";
  const latest = s.latest ? new Date(s.latest) : null;
  const when = latest ? `${histDay(latest) === "Today" ? "today" : histDay(latest) === "Yesterday" ? "yesterday" : histDay(latest)} at ${histTime(latest)}` : "";
  return `<section class="hist-backups" aria-labelledby="hist-backups-title">
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/></svg>
    <div><h2 id="hist-backups-title">Backups</h2>
      <p class="meta">${latest ? `Last backup: ${esc(when)}. ${s.count === 1 ? "1 backup" : `${s.count} backups`} kept in the <code>${esc(s.folder)}</code> folder.` : `The first backup is being saved now, in the <code>${esc(s.folder)}</code> folder.`}</p>
      <p class="meta">A copy of your names, family tree, people and photo details is saved when the app starts and every ${s.every_minutes} minutes while you make changes. The newest 48 are kept, plus one a day for a month.</p></div>
  </section>`;
}

function histPage(d) {
  const mod = HIST_MAC ? "⌘" : "Ctrl", shift = HIST_MAC ? "⇧" : "Shift";
  const intro = `<p class="help">Every change you make is listed here, newest first: names, groups, suggestions you turned down, the family tree, people’s details, and photo captions and dates. <b>Undo</b> puts back exactly what was there before, as long as nothing has changed it since.</p>
    <p class="meta hist-keys">Press <kbd>${mod}</kbd><kbd>Z</kbd> to undo your last change, or <kbd>${shift}</kbd><kbd>${mod}</kbd><kbd>Z</kbd> to redo it, anywhere outside a text box.</p>`;
  if (!d.entries.length)
    return `<div class="hist">${intro}${histBackups(d.snapshots)}<p class="empty">No changes yet. Name some faces or edit the family tree, and each change will be listed here, ready to undo.</p></div>`;
  const days = [];
  for (const e of d.entries) {
    const label = histDay(new Date(e.time));
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, items: [] });
    days[days.length - 1].items.push(e);
  }
  return `<div class="hist">${intro}${histBackups(d.snapshots)}
    ${days.map(g => `<h2 class="hist-day">${esc(g.label)}</h2><ol class="hist-list">${g.items.map(histRow).join("")}</ol>`).join("")}
    ${d.more ? `<button class="btn" id="hist-more">Show older changes</button>` : ""}
  </div>`;
}

document.addEventListener("click", async e => {
  if (tab !== "history") return;
  const u = e.target.closest("[data-hist-undo]");
  if (u) { u.disabled = true; HIST.focus = +u.dataset.histUndo; return undoChange(+u.dataset.histUndo); }
  if (e.target.closest("#hist-more")) { HIST.limit += 50; return renderHistory($("#main")); }
  if (e.target.closest("#hist-retry")) return renderHistory($("#main"));
});
