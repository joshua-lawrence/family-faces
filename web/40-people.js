// People cleanup: header actions on People, possible duplicates (#/people/_duplicates), a side-by-side
// Compare dialog (used from the Map), and the person page ("Check these" first, then every face).
// Endpoints: api_people_tools.py. Merging uses the existing /api/rename, so labels, tree.json and
// people.json follow the same path as a rename. Every change goes through the page's ordered write queue
// (postJSON / queueWrite in review.html) and is one History entry; the Undo on its toast undoes that entry.

const PP = {
  dupes: {key: null, data: null, error: null, loading: null, loadingKey: null},
  dismissed: null, dismissedLoading: null,
  checks: {key: null, name: null, data: null}, checksFetch: null,
  facesFor: null, facesShown: 200, conflictsAll: false, lowAll: false, busy: false,
  ok: null, okLoading: null,      // "Both correct" photos: Map photo -> [Set of face ids]
  focusPair: null,                // after a re-render on Possible duplicates: {index} or {key} of the card to focus
};
const PP_FACES_PAGE = 200, PP_CONFLICTS_FIRST = 6, PP_LOW_FIRST = 36;
const ppJSON = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok || data.error) throw new Error(data.error || 'Something went wrong. Reload the page and try again.');
  return data;
};
// A change through the write queue: throws with the reason if it wasn't saved.
async function ppWrite(url, body) {
  const d = await postJSON(url, body, {quiet: true});
  if (d.error) throw new Error(d.status === 0 ? REACH_ERROR : d.error);
  return d;
}
// A toast for a saved change whose Undo takes back exactly that change; after(r) runs once it's undone.
function ppDone(msg, history, after) {
  toast(msg, {action: history ? {label: 'Undo', run: async () => {
    const r = await undoChange(history.id);
    if (r && !r.error && !r.nothing && after) after(r);
  }} : null});
}
// Undo/redo anywhere (Cmd-Z, History) may change what these pages cache: fetch it again.
document.addEventListener('app:saved', e => {
  if (e.detail?.kind !== 'undo' && e.detail?.kind !== 'redo') return;
  PP.dupes.key = null; PP.dismissed = null; PP.ok = null; PP.checks.key = null; PP.checksFetch = null;
  ppLoadOk();
});
const ppPairKey = (a, b) => [a, b].sort().join('\u0000');
const ppPlural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const ppPct = x => `${Math.round(Math.max(0, x) * 100)}%`;

// ---------- page header: "Possible duplicates" and "Ignored faces" ----------
function ppPageActions() {
  let el = $('#page-actions');
  if (!el) {
    el = document.createElement('div'); el.id = 'page-actions'; el.className = 'page-actions';
    $('.page-head').appendChild(el);
  }
  return el;
}
function ppDupKey() { return S ? `${S.v}|${S.labeled}|${Object.keys(S.people).length}` : ''; }
function ppDupes() { return PP.dupes.key === ppDupKey() ? PP.dupes.data : null; }
function ppLoadDupes() {
  const key = ppDupKey();
  if (PP.dupes.key === key && (PP.dupes.data || PP.dupes.error)) return Promise.resolve(PP.dupes.data);
  if (PP.dupes.loading && PP.dupes.loadingKey === key) return PP.dupes.loading;
  PP.dupes.loadingKey = key;
  PP.dupes.loading = ppJSON('/api/people/duplicates').then(d => {
    PP.dupes = {key, data: d, error: null, loading: null, loadingKey: null};
    PP.dismissed = new Set(d.dismissed.map(([a, b]) => ppPairKey(a, b)));
    return d;
  }).catch(err => {
    PP.dupes = {key, data: null, error: err.message, loading: null, loadingKey: null};
    return null;
  });
  return PP.dupes.loading;
}
function peopleHeaderActions() {
  const el = ppPageActions(), d = ppDupes();
  const count = v => v == null ? '<span class="pp-count" aria-hidden="true">…</span>' : `<span class="pp-count">${v.toLocaleString()}</span>`;
  el.innerHTML = `<button class="btn" data-open="_duplicates" ${d ? '' : 'aria-busy="true"'}>Possible duplicates ${count(d?.pairs.length)}</button>
    <button class="btn" data-open="_ignore">Ignored faces ${count(d?.ignored)}</button>`;
  if (!d && !PP.dupes.error) ppLoadDupes().then(() => { if (tab === 'people' && !person) peopleHeaderActions(); });
}
// The header slot belongs to the People list only: empty it whenever another page renders.
new MutationObserver(() => {
  if (!(tab === 'people' && !person) && $('#page-actions')?.childElementCount) $('#page-actions').replaceChildren();
  if (tab !== 'map') ppCloseCompare();
}).observe($('#main'), {childList: true});

// ---------- pair cards (duplicates page and Compare dialog) ----------
function ppSideHTML(s, inDialog) {
  const years = s.born || s.died ? `${s.born ?? '?'}–${s.died ?? ''}` : '';
  const facts = [s.in_tree ? 'In the family tree' : 'Not in the family tree', s.familysearch_id ? `FamilySearch ${esc(s.familysearch_id)}` : ''].filter(Boolean).join(' · ');
  const tile = (inner, attrs, label) => inDialog ? `<span class="pp-face">${inner}</span>` : `<button class="pp-face" ${attrs} aria-label="${label}">${inner}</button>`;
  const tiles = s.sample.length
    ? s.sample.map(id => tile(`<img loading="lazy" src="/thumbs/${id}.jpg?v=${S.v}" alt="">`, `data-pp-face="${id}"`, `Open a photo of ${esc(s.name)}`)).join('')
    : s.source_sample.length
      ? s.source_sample.map(p => tile(`<img loading="lazy" src="/gallery-image/${encodeURIComponent(p)}" alt="">`, `data-pp-path="${esc(p)}"`, `Open a FamilySearch photo of ${esc(s.name)}`)).join('')
      : '<div class="pp-noface">No photos yet</div>';
  const link = inDialog ? `<button class="pp-name-link" data-pp-person="${esc(s.name)}">${esc(s.name)}</button>`
    : `<a href="#/people/${encodeURIComponent(s.name)}" data-open="${esc(s.name)}">${esc(s.name)}</a>`;
  return `<section class="pp-side">
    <h3 class="pp-name">${link}</h3>
    <p class="meta"><b>${s.faces.toLocaleString()}</b> ${s.faces === 1 ? 'face' : 'faces'} · <b>${s.photos.toLocaleString()}</b> ${s.photos === 1 ? 'photo' : 'photos'}${years ? ` · <span class="pp-years">${years}</span>` : ''}</p>
    <p class="meta">${facts}</p>
    <div class="pp-faces ${s.source_sample.length && !s.sample.length ? 'pp-sources' : ''}">${tiles}</div>
  </section>`;
}
let ppUid = 0;
function ppPairHTML(p, inDialog = false) {
  const uid = ++ppUid;
  const sim = p.similarity == null ? '<span class="pp-sim-none">No faces to compare</span>'
    : p.similarity < 0.1 ? '<span class="pp-sim-none">Faces not alike</span>'
    : `<b>${ppPct(p.similarity)}</b><span>alike</span>`;
  return `<article class="pp-pair" tabindex="-1" data-pp-a="${esc(p.a.name)}" data-pp-b="${esc(p.b.name)}" aria-labelledby="pp-pair-${uid}">
    <h3 class="visually-hidden" id="pp-pair-${uid}">${esc(p.a.name)} and ${esc(p.b.name)}</h3>
    ${p.reasons.length ? `<div class="pp-why">${p.reasons.map(r => `<span class="pp-reason">${esc(r.text)}</span>`).join('')}</div>` : ''}
    <div class="pp-sides">${ppSideHTML(p.a, inDialog)}<div class="pp-vs" title="How alike their average faces are">${sim}</div>${ppSideHTML(p.b, inDialog)}</div>
    ${p.cautions.length ? `<ul class="pp-cautions" aria-label="Reasons to check first">${p.cautions.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    <div class="pp-actions">
      <fieldset class="pp-keep"><legend>If they’re the same person, keep the name</legend>
        ${[p.a.name, p.b.name].map(n => `<label><input type="radio" name="pp-keep-${uid}" value="${esc(n)}" ${n === p.keep ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}
      </fieldset>
      <div class="pp-buttons">${p.cautions.length
        // Evidence against a merge (siblings, two FamilySearch records, years apart): the safe choice leads.
        ? `<button class="btn primary" data-pp-different>Different people</button>
        <button class="btn" data-pp-merge>Same person — merge into ${esc(p.keep)}</button>`
        : `<button class="btn primary" data-pp-merge>Same person — merge into ${esc(p.keep)}</button>
        <button class="btn" data-pp-different>Different people</button>`}
      </div>
    </div>
    <div class="pp-confirm" role="group" aria-label="Confirm merge" hidden></div>
  </article>`;
}
function ppPairOf(el) {
  const card = el.closest('.pp-pair');
  const a = card.dataset.ppA, b = card.dataset.ppB;
  const keep = card.querySelector('.pp-keep input:checked')?.value || a;
  return {card, a, b, keep, drop: keep === a ? b : a};
}
function ppFindPair(a, b) {
  const key = ppPairKey(a, b);
  return ppDupes()?.pairs.find(p => ppPairKey(p.a.name, p.b.name) === key) || PP.comparing;
}
function ppConfirmHTML(keep, drop, pair) {
  const side = n => pair && (pair.a.name === n ? pair.a : pair.b.name === n ? pair.b : null);
  const d = side(drop), k = side(keep);
  const faces = d ? (d.faces ? `The ${ppPlural(d.faces, 'face')} named “${esc(drop)}” will be named “${esc(keep)}”. ` : `No faces are named “${esc(drop)}”. `) : '';
  const ids = d?.familysearch_id && k?.familysearch_id && d.familysearch_id !== k.familysearch_id
    ? `<p class="pp-warn">Only ${esc(keep)}’s FamilySearch record (${esc(k.familysearch_id)}) stays linked. ${esc(d.familysearch_id)} is kept in the merge backup.</p>` : '';
  return `<p><b>Merge “${esc(drop)}” into “${esc(keep)}”?</b> ${faces}Family tree links and FamilySearch details move to “${esc(keep)}”. A backup of both people is saved first.</p>${ids}
    <div class="pp-buttons"><button class="btn primary" data-pp-merge-go>Merge into ${esc(keep)}</button><button class="btn" data-pp-merge-cancel>Cancel</button></div>`;
}
async function ppMerge(keep, drop) {
  if (PP.busy) return;
  PP.busy = true;
  try {
    // Backup, then the merge: one queued action, so nothing (an undo, another change) can come in between.
    const r = await queueWrite(async () => {
      const b = await sendJSON('/api/people/merge-backup', {keep, drop}, {quiet: true});
      return b.error ? b : sendJSON('/api/rename', {old: drop, new: keep}, {quiet: true});
    });
    if (r.error) throw new Error(r.status === 0 ? REACH_ERROR : r.error);
    PP.dupes.key = null;
    ppDone(`Merged ${drop} into ${keep}.`, r.history, () => { PP.dupes.key = null; if (tab === 'people') render(); });
  } catch (err) {
    toast(`Couldn’t merge: ${err.message}`, true);
  } finally {
    PP.busy = false;
  }
}
async function ppMarkDifferent(a, b, undo = false) {
  const r = await ppWrite('/api/people/not-duplicate', {a, b, undo});
  const key = ppPairKey(a, b);
  PP.dismissed ||= new Set();
  undo ? PP.dismissed.delete(key) : PP.dismissed.add(key);
  const d = ppDupes();
  if (d && !undo) {
    d.pairs = d.pairs.filter(p => ppPairKey(p.a.name, p.b.name) !== key);
    d.dismissed = [...d.dismissed, [a, b].sort()];
  }
  if (undo) PP.dupes.key = null;
  return r;
}

// ---------- #/people/_duplicates ----------
function renderDuplicatesPage() {
  document.title = 'Possible duplicates · People · Family Faces';
  const d = ppDupes();
  if (!d && !PP.dupes.error) ppLoadDupes().then(() => { if (tab === 'people' && person === '_duplicates') ppFillDupes(); });
  if (d) queueMicrotask(ppRestoreFocus);
  // Opened from People (or a link): put keyboard focus on the page, not back at the top of the sidebar.
  queueMicrotask(() => { const a = document.activeElement; if (!a || a === document.body || !a.isConnected) $('#pp-dupes-title')?.focus({preventScroll: true}); });
  return `<div class="detail-head"><button class="btn" id="back">← All people</button><h2 id="pp-dupes-title" tabindex="-1">Possible duplicates</h2><span class="meta" id="pp-dupe-count"></span></div>
    <p class="help">Names that may belong to one person: the same name with different capitals, accents or punctuation, a spelling one or two letters apart, a name written last name first, a name with a FamilySearch ID added, or two people whose faces look very alike. Merging keeps one name and moves the other’s faces, family tree links and FamilySearch details to it.</p>
    <div id="pp-dupes">${d || PP.dupes.error ? ppDupesHTML() : '<div class="empty" role="status">Checking names and faces…</div>'}</div>`;
}
function ppDupesHTML() {
  const d = ppDupes();
  if (!d) return `<div class="empty" role="alert">${esc(PP.dupes.error || 'Couldn’t check for duplicates.')} <button class="btn" data-pp-retry>Try again</button></div>`;
  queueMicrotask(() => { const c = $('#pp-dupe-count'); if (c) c.textContent = ppPlural(d.pairs.length, 'pair'); });
  const list = d.pairs.length ? `<div class="pp-pairs">${d.pairs.map(p => ppPairHTML(p)).join('')}</div>`
    : `<div class="empty">No likely duplicates. Every name looks like a different person.</div>`;
  const dismissed = d.dismissed.length ? `<details class="pp-dismissed"><summary>Marked as different people <span class="pp-count">${d.dismissed.length}</span></summary>
    <ul>${d.dismissed.map(([a, b]) => `<li><span>${esc(a)} <span class="meta">and</span> ${esc(b)}</span><button class="btn" data-pp-undismiss data-a="${esc(a)}" data-b="${esc(b)}">Show again</button></li>`).join('')}</ul></details>` : '';
  return list + dismissed;
}
function ppFillDupes() {
  const box = $('#pp-dupes');
  if (box) { box.innerHTML = ppDupesHTML(); ppRestoreFocus(); }
}
// After a card goes (merged or marked different), keep keyboard and screen-reader users in the list:
// focus the card that took its place, else the one before it, else the page heading.
function ppRestoreFocus() {
  const want = PP.focusPair;
  if (!want || tab !== 'people' || person !== '_duplicates' || !ppDupes()) return;
  PP.focusPair = null;
  const cards = [...document.querySelectorAll('#pp-dupes .pp-pair')];
  const el = want.key ? cards.find(c => ppPairKey(c.dataset.ppA, c.dataset.ppB) === want.key)
    : cards[Math.min(want.index ?? 0, cards.length - 1)];
  (el || $('#pp-dupes-title'))?.focus();
}

// ---------- Compare dialog (Map lookalike pairs) ----------
function ppCompareDialog() {
  let dlg = $('#pp-compare');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'pp-compare'; dlg.className = 'pp-compare'; dlg.setAttribute('aria-labelledby', 'pp-compare-title');
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    // The map redraws its pair list while the dialog is open: return focus to the same pair.
    dlg.addEventListener('close', () => { if (PP.returnPair && tab === 'map') $(`#map-side [data-pair="${PP.returnPair}"]`)?.focus(); });
  }
  return dlg;
}
function ppCloseCompare() {
  const dlg = $('#pp-compare');
  if (dlg?.open) dlg.close();
}
// Back (or any route change) dismisses the dialog, as it would on a phone.
window.addEventListener('popstate', ppCloseCompare);
window.addEventListener('hashchange', ppCloseCompare);
async function openCompare(a, b) {
  const dlg = ppCompareDialog();
  PP.comparing = null;
  PP.returnPair = document.activeElement?.closest?.('[data-pair]')?.dataset.pair || null;
  dlg.innerHTML = `<header><h2 id="pp-compare-title">Same person?</h2><button class="btn" data-pp-close>Close</button></header>
    <div class="pp-compare-body" id="pp-compare-body"><div class="empty" role="status">Loading faces…</div></div>`;
  if (!dlg.open) dlg.showModal();
  $('[data-pp-close]', dlg).focus();
  try {
    const p = await ppJSON(`/api/people/compare?${new URLSearchParams({a, b, n: 6})}`);
    PP.comparing = p;
    $('#pp-compare-body').innerHTML = (p.dismissed ? `<p class="pp-note">You marked these as different people. <button class="btn" data-pp-undismiss data-a="${esc(p.a.name)}" data-b="${esc(p.b.name)}">Show in duplicates again</button></p>` : '')
      + ppPairHTML(p, true);
  } catch (err) {
    $('#pp-compare-body').innerHTML = `<div class="empty" role="alert">${esc(err.message)}</div>`;
  }
}

// ---------- the person page ----------
function renderPersonPage() {
  if (person === '_duplicates') return renderDuplicatesPage();
  const ignored = person === '_ignore';
  const title = ignored ? 'Ignored faces' : person;
  if (ignored) document.title = 'Ignored faces · People · Family Faces';
  const back = `<button class="btn" id="back">← All people</button>`;
  if (!P) return `<div class="detail-head">${back}<h2>${esc(title)}</h2></div><div class="empty">No faces have this name any more.</div>`;
  if (!ignored && P.alias_of && !P.faces.length && !P.photos) {   // an old name or bookmark: say who it means
    return `<div class="detail-head">${back}<h2>${esc(title)}</h2></div>
      <div class="empty">${esc(title)} is another name for <a href="#/people/${encodeURIComponent(P.alias_of)}" data-open="${esc(P.alias_of)}">${esc(P.alias_of)}</a>. Their faces and photos are listed there.</div>`;
  }
  const hasData = P.faces.length || P.photos || (P.source_photos || []).length;
  if (PP.facesFor !== person) Object.assign(PP, {facesFor: person, facesShown: PP_FACES_PAGE, conflictsAll: false, lowAll: false});
  const fit = new Map(P.faces.map(f => [f.id, f.fit]));
  let list = P.faces;
  if (personSort === 'photo') list = [...list].sort((a, b) => a.photo.localeCompare(b.photo) || a.id - b.id);
  const conf = ignored ? new Set() : ppConflictSet();   // two ignored faces in one photo are fine
  const nConf = conf.size, nFine = ignored ? 0 : ppMarkedFine();
  const low = ignored ? [] : P.faces.filter(f => !conf.has(f.id) && f.fit < 0.4).sort((a, b) => a.fit - b.fit);
  const head = `<div class="detail-head">${back}<h2>${esc(title)}</h2>
      <span class="meta"><b>${P.faces.length.toLocaleString()}</b> ${P.faces.length === 1 ? 'face' : 'faces'} · <b>${(P.photos || 0).toLocaleString()}</b> ${P.photos === 1 ? 'photo' : 'photos'}</span>
      ${ignored || !hasData ? '' : `<button class="btn" data-rename="${esc(person)}">Rename</button>${P.faces.length ? `<button class="btn" data-fs-upload-person="${esc(person)}">Upload to FamilySearch</button>` : ''}`}
    </div>${ignored ? '' : personContext(P.identity || {})}`;

  // 1. Check these: two faces with this name in one photo, then faces that look least like the rest.
  let checks = '';
  const fineNote = nFine ? `<p class="pp-fine meta">${nFine === 1 ? '1 photo you marked as correct is' : `${nFine} photos you marked as correct are`} hidden here. <button class="btn link" data-pp-unfine>Check ${nFine === 1 ? 'it' : 'them'} again</button></p>` : '';
  if (nConf || low.length) {
    const nPhotos = new Set(P.faces.filter(f => conf.has(f.id)).map(f => f.photo)).size;
    const conflictBlock = nConf ? `<div class="pp-sub"><h4>Same name twice in one photo <span class="pp-count">${nPhotos}</span></h4>
        <p class="help">Usually only one face in a photo can be ${esc(person)}. Keep the face that’s really them; the other loses the name and goes back to <b>Leftover faces</b>. If the photo really shows them more than once, like a framed portrait on the wall behind them, choose <b>Both correct</b>.</p>
        <div id="pp-conflicts">${ppConflictsHTML(fit)}</div>${fineNote}</div>` : '';
    const lowShown = PP.lowAll ? low : low.slice(0, PP_LOW_FIRST);
    const lowBlock = low.length ? `<div class="pp-sub"><h4>Look least like the rest <span class="pp-count">${low.length}</span></h4>
        <p class="help">These faces look least like ${esc(person)}’s other photos. Select any that aren’t them, then move them to the right person or remove the name.</p>
        <div class="toolbar"><button class="btn" data-pp-select-low>Select all ${low.length}</button></div>
        <div class="grid" data-pp-grid>${lowShown.map((f, i) => faceTile(f.id, {odd: true, tag: `${Math.round(f.fit * 100)}%`, focusable: i ? 'rest' : 'first'})).join('')}</div>
        ${low.length > lowShown.length ? `<div class="people-more"><button class="btn" data-pp-low-all>Show all ${low.length}</button></div>` : ''}</div>` : '';
    checks = `<section class="pt-section pp-check" aria-labelledby="pp-check-title"><h3 id="pp-check-title" tabindex="-1">Check these</h3>${conflictBlock}${lowBlock}${nConf ? '' : fineNote}</section>`;
  } else if (fineNote) checks = `<div class="pp-fine-only">${fineNote}</div>`;

  // 2. Every face, a page at a time (the biggest people have 700+).
  const help = ignored
    ? 'These faces are left out of the export. Select any that should be tagged (click or press Space) and move them to a person, or choose Stop ignoring.'
    : `Every face named ${esc(person)}. Select the wrong ones (click or press Space; Shift-click selects a range), then move them to the right person or remove the name. Removed faces go back to <b>Leftover faces</b>. Double-click a face, or press Enter on it, to see the whole photo.`;
  const shown = list.slice(0, PP.facesShown), left = list.length - shown.length;
  const faces = list.length ? `<section class="pp-all" aria-labelledby="pp-all-title">
      <div class="pp-section-head"><h3 class="section-title" id="pp-all-title">${ignored ? 'Faces' : 'All faces'} <span class="pp-count">${list.length.toLocaleString()}</span></h3>
        <span class="seg" role="group" aria-label="Order faces"><button data-sort="check" class="${personSort === 'check' ? 'on' : ''}" aria-pressed="${personSort === 'check'}">Likely mistakes first</button><button data-sort="photo" class="${personSort === 'photo' ? 'on' : ''}" aria-pressed="${personSort === 'photo'}">Album order</button></span></div>
      <p class="help">${help}</p>
      ${ignored ? '' : `<div class="legend">
        <span><i style="border:3px solid var(--danger)"></i>${nConf} in a photo with another ${esc(person)}</span>
        <span><i style="border:2px dashed var(--warn)"></i>${low.length} that look least like the rest</span></div>`}
      <div class="grid" data-pp-grid>${shown.map((f, i) => faceTile(f.id, {conflict: conf.has(f.id), odd: !ignored && !conf.has(f.id) && f.fit < 0.4, focusable: i ? 'rest' : 'first'})).join('')}</div>
      ${left > 0 ? `<div class="people-more"><button class="btn" data-pp-more-faces>Show ${Math.min(PP_FACES_PAGE, left).toLocaleString()} more</button><button class="btn" data-pp-all-faces>Show all ${list.length.toLocaleString()}</button><span class="meta">Showing ${shown.length.toLocaleString()} of ${list.length.toLocaleString()}</span></div>` : ''}
    </section>` : `<div class="empty">${P.photos ? `No faces in the album photos are named ${esc(person)} yet.` : 'No photos for this person yet.'}</div>`;

  // 3. FamilySearch photos.
  const src = P.source_photos || [];
  const fs = src.length ? `<section aria-labelledby="pp-fs-title"><h3 class="section-title" id="pp-fs-title">FamilySearch photos <span class="pp-count">${src.length}</span></h3>
      <p class="help">Photos attached to this person in FamilySearch Memories. Open a photo to see it in full.</p>
      <div class="source-gallery">${src.map(p => `<div class="source-photo">
        <button data-source-photo="${esc(p.path)}" aria-label="Open ${esc(p.caption || 'FamilySearch photo')}"><img loading="lazy" src="${photoURL(p.path)}" alt="${esc(p.caption || '')}"></button>
        <div class="nm">${esc(p.caption || 'Untitled photo')}</div>
        <a class="meta" href="${esc(p.source_url)}" target="_blank" rel="noopener noreferrer">View in FamilySearch ↗</a></div>`).join('')}</div></section>` : '';
  return head + (ignored || !window.faceSimilaritySection ? '' : window.faceSimilaritySection(person)) + (ignored || typeof personMatchesSection !== 'function' ? '' : personMatchesSection()) + checks + faces + fs;
}

// Conflict photos come from /api/people/checks (face boxes for the whole photo). The request starts
// as soon as a person is opened, alongside the page data, and is reused after Keep / Both wrong.
// "Both correct" photos (a photo of a photo really shows someone twice) stop counting as conflicts.
function ppLoadOk() {
  if (PP.okLoading) return PP.okLoading;
  PP.okLoading = ppJSON('/api/people/conflict-ok').then(d => {
    const was = PP.ok;
    PP.ok = new Map();
    for (const g of d.groups) {
      if (!PP.ok.has(g.photo)) PP.ok.set(g.photo, []);
      PP.ok.get(g.photo).push(new Set(g.faces));
    }
    // Drawn before the list arrived: draw again if it hides anything here.
    if (!was && tab === 'people' && !ppSpecial(person) && P && P.faces.some(f => f.conflict && PP.ok.has(f.photo))) render();
  }).catch(() => { PP.ok ||= new Map(); }).finally(() => { PP.okLoading = null; });
  return PP.okLoading;
}
function ppConflictGroups() {
  const by = new Map();
  for (const f of P.faces) if (f.conflict) { if (!by.has(f.photo)) by.set(f.photo, []); by.get(f.photo).push(f.id); }
  return by;
}
function ppIsFine(photo, ids) { return (PP.ok?.get(photo) || []).some(g => ids.every(id => g.has(id))); }
function ppConflictSet() {
  const out = new Set();
  for (const [photo, ids] of ppConflictGroups()) if (!ppIsFine(photo, ids)) ids.forEach(id => out.add(id));
  return out;
}
function ppMarkedFine() { let n = 0; for (const [photo, ids] of ppConflictGroups()) n += ppIsFine(photo, ids); return n; }
function ppConflictIds() { return [...ppConflictSet()].sort((a, b) => a - b); }
function ppDeriveChecks(data, ids) {
  const want = new Set(ids);
  const conflicts = data.conflicts.map(g => ({...g, faces: g.faces.map(f => ({...f, mine: f.mine && want.has(f.id)}))}))
    .filter(g => g.faces.filter(f => f.mine).length >= 2);
  const covered = new Set(conflicts.flatMap(g => g.faces.filter(f => f.mine).map(f => f.id)));
  return covered.size === want.size ? {conflicts} : null;   // a face we have no photo for: fetch again
}
function ppFetchChecks(name, key = null) {
  const F = PP.checksFetch;
  if (F && F.name === name && (F.promise || (F.data && F.key === key))) return;
  const fetchState = {name, key, data: null};
  fetchState.promise = ppJSON(`/api/people/checks?name=${encodeURIComponent(name)}`).then(data => {
    fetchState.data = data;
    if (tab === 'people' && person === name && P && $('#pp-conflicts')) $('#pp-conflicts').innerHTML = ppConflictsHTML(new Map(P.faces.map(f => [f.id, f.fit])));
  }).catch(err => {
    fetchState.error = err.message;
    if (tab === 'people' && person === name && $('#pp-conflicts')) $('#pp-conflicts').innerHTML = `<div class="empty" role="alert">${esc(err.message)}</div>`;
  }).finally(() => { fetchState.promise = null; });
  PP.checksFetch = fetchState;
}
function ppChecks() {
  const ids = ppConflictIds(), key = `${person}|${ids.join(',')}`;
  if (PP.checks.key === key) return PP.checks.data;
  for (const src of [PP.checks, PP.checksFetch]) {
    if (src?.name !== person || !src.data) continue;
    const data = ppDeriveChecks(src.data, ids) || (src === PP.checksFetch && src.key === key ? src.data : null);
    if (data) { PP.checks = {key, name: person, data}; return data; }
  }
  if (PP.checksFetch?.name === person && PP.checksFetch.error && PP.checksFetch.key === key) throw new Error(PP.checksFetch.error);
  ppFetchChecks(person, key);
  return null;
}
function ppConflictsHTML(fit) {
  let data;
  try { data = ppChecks(); } catch (err) { return `<div class="empty" role="alert">${esc(err.message)}</div>`; }
  if (!data) return '<div class="empty" role="status">Loading photos…</div>';
  const groups = PP.conflictsAll ? data.conflicts : data.conflicts.slice(0, PP_CONFLICTS_FIRST);
  return `<div class="pp-conflicts">${groups.map(g => ppConflictHTML(g, fit)).join('')}</div>
    ${data.conflicts.length > groups.length ? `<div class="people-more"><button class="btn" data-pp-conflicts-all>Show all ${data.conflicts.length} photos</button></div>` : ''}`;
}
function ppConflictHTML(g, fit) {
  const mine = g.faces.filter(f => f.mine), ids = mine.map(f => f.id).join(',');
  const two = mine.length === 2;
  const nth = i => ['1st', '2nd', '3rd'][i] || `${i + 1}th`;
  const labels = two ? ['Left', 'Right'] : mine.map((_, i) => `${nth(i)} from left`);
  const keeps = two ? ['Keep left', 'Keep right'] : mine.map((_, i) => `Keep ${nth(i)}`);
  const marks = two ? ['L', 'R'] : mine.map((_, i) => String(i + 1));
  const boxes = g.faces.map(f => `<span class="pp-box ${f.mine ? 'mine' : ''}" data-bbox="${f.bbox.join(',')}" data-w="${f.img_w || ''}" hidden>${f.mine ? `<i>${marks[mine.indexOf(f)]}</i>` : ''}</span>`).join('');
  return `<article class="pp-conflict" tabindex="-1" data-pp-photo="${esc(g.photo)}" aria-label="Photo with ${mine.length} faces named ${esc(person)}">
    <button class="pp-conflict-photo" data-pp-face="${mine[0].id}" aria-label="Open the whole photo"><span class="pp-photo-wrap"><img class="pp-photo" loading="lazy" src="/gallery-image/${encodeURIComponent(g.photo)}" alt="">${boxes}</span></button>
    <div class="pp-conflict-body">
      <div class="pp-crops">${mine.map((f, i) => `<figure><img src="/thumbs/${f.id}.jpg?v=${S.v}" alt="${labels[i]} face"><figcaption><b>${marks[i]}</b> ${labels[i]}<span class="meta"><b>${Math.round((fit.get(f.id) ?? 0) * 100)}%</b> like the rest</span></figcaption></figure>`).join('')}</div>
      ${g.caption ? `<p class="meta pp-caption">“${esc(g.caption)}”</p>` : ''}
      <div class="pp-buttons">${mine.map((f, i) => `<button class="btn" data-pp-keep="${f.id}" data-pp-group="${ids}" aria-label="Keep the ${labels[i].toLowerCase()} face as ${esc(person)}">${keeps[i]}</button>`).join('')}
        <button class="btn danger" data-pp-none="${ids}">${two ? 'Both wrong' : 'All wrong'}</button>
        <button class="btn quiet" data-pp-fine="${ids}" aria-label="${two ? 'Both' : `All ${mine.length}`} faces are ${esc(person)}, for example a photo of a photo">${two ? 'Both correct' : 'All correct'}</button></div>
    </div></article>`;
}
function ppPlaceBoxes(img) {
  const wrap = img.parentElement, nw = img.naturalWidth, nh = img.naturalHeight;
  if (!nw || !nh) return;
  for (const box of wrap.querySelectorAll('.pp-box')) {
    const [x1, y1, x2, y2] = box.dataset.bbox.split(',').map(Number), w = +box.dataset.w || nw, h = w * nh / nw;
    Object.assign(box.style, {left: `${x1 / w * 100}%`, top: `${y1 / h * 100}%`, width: `${(x2 - x1) / w * 100}%`, height: `${(y2 - y1) / h * 100}%`});
    box.hidden = false;
  }
}
document.addEventListener('load', e => { if (e.target.matches?.('img.pp-photo')) ppPlaceBoxes(e.target); }, true);

// Which conflict card to focus after the page redraws: the one that took this card's place.
function ppConflictIndex(card) { return [...document.querySelectorAll('#pp-conflicts .pp-conflict')].indexOf(card); }
function ppFocusConflict(index, photo = null) {
  const cards = [...document.querySelectorAll('#pp-conflicts .pp-conflict')];
  const el = (photo && cards.find(c => c.dataset.ppPhoto === photo)) || (index >= 0 && cards[Math.min(index, cards.length - 1)]);
  (el || $('#pp-check-title') || $('#pp-all-title') || $('#back'))?.focus();
}
async function ppRemoveNames(card, ids, message) {
  const name = person, index = ppConflictIndex(card), photo = card.dataset.ppPhoto;
  let res;
  try {
    res = await ppWrite('/api/people/remove-names', {name, faces: ids});
  } catch (err) {
    card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    return toast(`Couldn’t change the names: ${err.message}`, true);
  }
  // Undo is the History entry's own undo: the names and groups come back exactly as they were.
  ppDone(message, res.history, () => { if (tab === 'people' && person === name) ppFocusConflict(-1, photo); });
  await load();
  if (tab === 'people' && person === name) ppFocusConflict(index);
}
async function ppMarkFine(card, ids) {
  const name = person, index = ppConflictIndex(card), photo = card.dataset.ppPhoto;
  let res;
  try { res = await ppWrite('/api/people/conflict-ok', {name, photo, faces: ids}); } catch (err) {
    card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    return toast(`Couldn’t save that: ${err.message}`, true);
  }
  PP.ok ||= new Map();
  const list = (PP.ok.get(photo) || []).filter(g => ![...g].every(id => ids.includes(id)));
  list.push(new Set(ids));
  PP.ok.set(photo, list);
  PP.checks.key = null;
  render();
  ppFocusConflict(index);
  ppDone(`Marked as correct. This photo won’t be listed for ${name} again.`, res.history, async () => {
    PP.checksFetch = null;   // the server left this photo out of its list: fetch it again
    PP.ok = null; await ppLoadOk();
    if (tab === 'people' && person === name) { render(); ppFocusConflict(-1, photo); }
  });
}

// ---------- clicks ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-pp-face],[data-pp-path],[data-pp-merge],[data-pp-merge-go],[data-pp-merge-cancel],[data-pp-different],[data-pp-undismiss],[data-pp-retry],[data-pp-close],[data-pp-person],[data-pp-keep],[data-pp-none],[data-pp-fine],[data-pp-unfine],[data-pp-select-low],[data-pp-low-all],[data-pp-more-faces],[data-pp-all-faces],[data-pp-conflicts-all]');
  if (!t) return;
  const inDialog = Boolean(t.closest('#pp-compare'));
  if (t.dataset.ppFace) return openPhoto(+t.dataset.ppFace);
  if (t.dataset.ppPath) return openPhotoPath(t.dataset.ppPath);
  if (t.matches('[data-pp-close]')) return $('#pp-compare').close();
  if (t.dataset.ppPerson) { $('#pp-compare').close(); return openPersonView(t.dataset.ppPerson); }
  if (t.matches('[data-pp-retry]')) { PP.dupes.key = null; PP.dupes.error = null; return render(); }
  if (t.matches('[data-pp-merge]')) {
    const {card, keep, drop, a, b} = ppPairOf(t);
    const box = $('.pp-confirm', card);
    box.innerHTML = ppConfirmHTML(keep, drop, ppFindPair(a, b));
    box.hidden = false; $('.pp-actions', card).hidden = true;
    return $('[data-pp-merge-go]', box).focus();
  }
  if (t.matches('[data-pp-merge-cancel]')) {
    const card = t.closest('.pp-pair');
    $('.pp-confirm', card).hidden = true; $('.pp-actions', card).hidden = false;
    return $('[data-pp-merge]', card).focus();
  }
  if (t.matches('[data-pp-merge-go]')) {
    const {card, keep, drop} = ppPairOf(t);
    const index = [...document.querySelectorAll('#pp-dupes .pp-pair')].indexOf(card);
    t.disabled = true; t.textContent = 'Merging…';
    await ppMerge(keep, drop);
    if (inDialog) { $('#pp-compare').close(); mapPair = null; mapFocus = null; }
    else PP.focusPair = {index};
    return load();
  }
  if (t.matches('[data-pp-different]')) {
    const {card, a, b} = ppPairOf(t);
    t.disabled = true;
    let res;
    try { res = await ppMarkDifferent(a, b); } catch (err) { t.disabled = false; return toast(`Couldn’t save that: ${err.message}`, true); }
    if (inDialog) { $('#pp-compare').close(); if (tab === 'map') renderSide(); }
    else {
      PP.focusPair = {index: [...document.querySelectorAll('#pp-dupes .pp-pair')].indexOf(card)};
      card.remove(); ppFillDupes(); if ($('[data-open="_duplicates"] .pp-count')) peopleHeaderActions();
    }
    return ppDone(`Marked ${a} and ${b} as different people.`, res.history, () => {
      if (tab === 'map') return renderSide();
      if (tab === 'people' && person === '_duplicates') { PP.focusPair = {key: ppPairKey(a, b)}; ppLoadDupes().then(() => ppFillDupes()); }
    });
  }
  if (t.matches('[data-pp-undismiss]')) {
    try { await ppMarkDifferent(t.dataset.a, t.dataset.b, true); } catch (err) { return toast(`Couldn’t save that: ${err.message}`, true); }
    if (inDialog) { $('#pp-compare').close(); if (tab === 'map') renderSide(); return; }
    return render();
  }
  if (t.dataset.ppKeep || t.dataset.ppNone || t.dataset.ppFine) {
    const card = t.closest('.pp-conflict');
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (t.dataset.ppFine) return ppMarkFine(card, t.dataset.ppFine.split(',').map(Number));
    if (t.dataset.ppKeep) {
      const keep = +t.dataset.ppKeep, drop = t.dataset.ppGroup.split(',').map(Number).filter(id => id !== keep);
      return ppRemoveNames(card, drop, `Removed ${person} from ${ppPlural(drop.length, 'face')}. ${drop.length === 1 ? 'It’s' : 'They’re'} in Leftover faces now.`);
    }
    const ids = t.dataset.ppNone.split(',').map(Number);
    return ppRemoveNames(card, ids, `Removed ${person} from ${ppPlural(ids.length, 'face')}. They’re in Leftover faces now.`);
  }
  if (t.matches('[data-pp-unfine]')) {
    const name = person;
    t.disabled = true;
    try { await ppWrite('/api/people/conflict-ok', {name, undo: true}); } catch (err) { t.disabled = false; return toast(`Couldn’t save that: ${err.message}`, true); }
    PP.ok = null; PP.checks.key = null; PP.checksFetch = null;
    await ppLoadOk();
    if (tab === 'people' && person === name) { render(); $('#pp-check-title')?.focus(); }
    return;
  }
  if (t.matches('[data-pp-select-low]')) {
    for (const f of P.faces) if (!f.conflict && f.fit < 0.4) selected.add(f.id);
    PP.lowAll = true; return render();
  }
  if (t.matches('[data-pp-low-all]')) { PP.lowAll = true; return render(); }
  if (t.matches('[data-pp-conflicts-all]')) { PP.conflictsAll = true; return render(); }
  if (t.matches('[data-pp-more-faces]')) { PP.facesShown += PP_FACES_PAGE; return render(); }
  if (t.matches('[data-pp-all-faces]')) { PP.facesShown = Infinity; return render(); }
});
// Keyboard on the person page and Ignored faces: Tab reaches each grid of faces once; the arrow keys move between
// faces, Space (or X) selects, Shift+Space selects the range from the last one, Enter opens the whole photo.
document.addEventListener('keydown', e => {
  const tile = e.target.closest?.('[data-pp-grid] .face');
  if (!tile || tab !== 'people' || !person || e.metaKey || e.ctrlKey || e.altKey) return;
  const tiles = [...tile.parentElement.querySelectorAll('.face')], i = tiles.indexOf(tile);
  const move = j => {
    const to = tiles[Math.max(0, Math.min(tiles.length - 1, j))];
    if (!to || to === tile) return;
    tile.tabIndex = -1; to.tabIndex = 0; to.focus(); to.scrollIntoView({block: 'nearest'});
  };
  const perRow = Math.max(1, tiles.filter(t => t.offsetTop === tiles[0].offsetTop).length);
  switch (e.key) {
    case 'ArrowRight': e.preventDefault(); return move(i + 1);
    case 'ArrowLeft': e.preventDefault(); return move(i - 1);
    case 'ArrowDown': e.preventDefault(); return move(i + perRow);
    case 'ArrowUp': e.preventDefault(); return move(i - perRow);
    case 'Home': e.preventDefault(); return move(0);
    case 'End': e.preventDefault(); return move(tiles.length - 1);
    case 'Enter': e.preventDefault(); return openPhoto(+tile.dataset.face);
    case ' ': case 'x': case 'X':
      e.preventDefault();
      return tile.dispatchEvent(new MouseEvent('click', {bubbles: true, shiftKey: e.shiftKey, detail: 1}));
  }
});
// The same face can show in "Check these" and in "All faces": keep both tiles' selection in step.
document.addEventListener('click', e => {
  const tile = e.target.closest('.face');
  if (!tile || tab !== 'people' || !person || e.detail > 1) return;
  const id = +tile.dataset.face;
  document.querySelectorAll(`.face[data-face="${id}"]`).forEach(x => { x.classList.toggle('sel', selected.has(id)); x.setAttribute('aria-pressed', String(selected.has(id))); });
});
document.addEventListener('change', e => {
  if (!e.target.matches('.pp-keep input')) return;
  const card = e.target.closest('.pp-pair');
  $('[data-pp-merge]', card).textContent = `Same person — merge into ${e.target.value}`;
});

// ---------- Map: the lookalike pairs open the Compare dialog ----------
function ppLoadDismissed() {
  if (PP.dismissed || PP.dismissedLoading) return;
  PP.dismissedLoading = ppJSON('/api/people/not-duplicates').then(d => {
    PP.dismissed = new Set(d.pairs.map(([a, b]) => ppPairKey(a, b)));
    if (tab === 'map') renderSide();
  }).catch(() => {}).finally(() => { PP.dismissedLoading = null; });
}
function ppMapDismissed(a, b) {
  if (!PP.dismissed) { ppLoadDismissed(); return false; }
  return PP.dismissed.has(ppPairKey(a, b));
}

// Start fetching a person's conflict photos the moment they're opened, in parallel with the page data.
const ppSpecial = n => !n || n === '_ignore' || n === '_duplicates';
ppLoadOk();
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open],[data-openperson],[data-pp-person]');
  const name = t && (t.dataset.open || t.dataset.openperson || t.dataset.ppPerson);
  if (!ppSpecial(name)) ppFetchChecks(name);
}, true);
window.addEventListener('popstate', () => { if (tab === 'people' && !ppSpecial(person)) ppFetchChecks(person); });
if (typeof tab !== 'undefined' && tab === 'people' && !ppSpecial(person)) ppFetchChecks(person);

// Scripts can finish loading after the first data arrives: draw the People page again if it's showing.
if (typeof S !== 'undefined' && S && tab === 'people') render();
