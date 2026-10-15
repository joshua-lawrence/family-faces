/* Naming loop for Groups and Leftover faces: fast, keyboard-driven and forgiving.
 *
 * review.html delegates to window.Naming: renderGroups(), renderLeftovers(), saveGroup(),
 * rebuilding(), floating(mode); and calls window.namingKeydown(e) first in its keydown handler.
 *
 * - Acting on a card (save, use a suggestion, skip, ignore) collapses it at once and moves focus to
 *   the next card's name field, which slides into the same place. The save is one request, queued with
 *   every other write (postJSON in review.html), so saves, undos and other changes reach the app in the
 *   order they were made; if it fails the card comes back with an error toast. The page refreshes once the
 *   saves pause (refreshSoon), not after every save, so fast naming never builds a backlog.
 * - Background refreshes keep focus, caret, typed drafts and the scroll position, and keep the
 *   order of the cards stable until the sort or filters change.
 * - The name field says whether a name is a known person or new ("Did you mean ...?") and asks
 *   once before adding a brand-new name.
 */
(() => {
'use strict';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const session = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => matchMedia('(pointer: fine)').matches;
const touchScreen = () => matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(hover: hover)').matches);
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';
const isReviewTab = () => tab === 'groups' || tab === 'leftovers';
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const NM = {
  cur: null,                    // key of the current card: "group:12" or "face:345"
  hidden: new Map(),            // key -> {need}: acted-on cards kept out of view until the data catches up
  skipped: new Set(session.get('naming-skipped') || []),
  order: { group: null, face: null }, sig: { group: '', face: '' }, next: { group: 0, face: 0 }, splits: 0,
  lastS: null, sNum: 0,         // the state object last rendered, and the load() request that produced it
  confirm: new Map(),           // field key -> normalised new name waiting for a second Enter
  err: new Set(),               // field keys showing "Type a name first"
  filtersOpen: !!session.get('naming-filters-open'),
  rebuilding: false,
  names: null, namesV: null, vocab: new Set(), index: null, indexFor: null, indexNames: null,
  list: null,                   // open name list: {input, box, items, active}
  restore: null, autofocus: true, focusKey: null,
  recent: new Map(),            // branch-qualified key -> time of a confirmed save; if the card comes back (Undo), focus it
  kb: false,                    // focus was last moved by the keyboard: only then do letter keys on a card act
  actAt: 0,                     // when a card was last acted on (a second click of a double-click is ignored)
  armed: null,                  // {key, at}: I was pressed once on this card; a second I ignores it (when there's no Undo)
  seq: 0,                       // actions so far: a toast for an older action never covers a newer one's
  chips: new Map(),             // card key -> suggestions as last drawn
  steady: new Set(),            // cards near the one you're on: their suggestions don't change under you mid-burst
};

// Group ids are numbered separately for each family branch, so remembered group keys carry the branch.
const branchNow = () => (typeof S !== 'undefined' && S?.familysearch_matching?.branch) || reviewSettings.branch;
const qk = k => k.startsWith('group:') ? `${branchNow()}|${k}` : k;
const unq = q => { const i = q.indexOf('|'); return i < 0 ? q : q.slice(0, i) === branchNow() ? q.slice(i + 1) : null; };

// ---------- names: known people, album names, did-you-mean ----------

const FILLER = new Set(`add added album albums about all and article aunt baby babies back bishop birthday bottom boys
brass brother brothers by caption captions cc celebrating celebration children christmas church class classmates
colorized conference copy copied cousin cousins crop cropped dad daddy daughter daughters dental dr dsc dscn easter
edited elder elders enhanced family father friends front funeral girls grade graduating graduation grandchildren
granddaughter granddaughters grandfather grandkids grandma grandmother grandpa grandparents grandson group high home
house image img jpeg jpg jr kids left meeting miss mission missionary mom mommy mother mr mrs ms of our page pages
photo photograph photos pic picture pictures png portrait president primary relief restored reunion right row scan
scanitem scanned school seminary sister sisters slide slides society son sons sr stake temple the tif tiff title
titled top uncle unknown untitled ward wedding with yearbook`.split(/\s+/));

// Letters and digits in any script (Анна, 李小龙, Søren), accents removed, for matching names.
const deaccent = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '');
const norm = s => deaccent(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const wordsOf = s => deaccent(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
const tidy = s => String(s ?? '').trim().replace(/\s+/g, ' ');

// Album names and name words. Fetched as the page starts (alongside the state) and again when the data changes.
let namesReq = null;
function loadNames() {
  namesReq = namesReq || fetch('/api/naming/names').then(r => r.ok ? r.json() : Promise.reject())
    .then(doc => {
      NM.names = doc; NM.vocab = new Set(doc.vocab || []); NM.index = null;
      if (S && isReviewTab()) render();
    })
    .catch(() => {})
    .finally(() => { namesReq = null; });
  return namesReq;
}

function index() {
  if (NM.index && NM.indexFor === S.people && NM.indexNames === NM.names) return NM.index;
  const entries = Object.keys(S.people || {}).filter(n => !n.startsWith('_'))
    .map(name => ({ name, norm: norm(name), words: wordsOf(name), photos: S.people[name] || 0 }));
  const byNorm = new Map();
  for (const e of [...entries].sort((a, b) => a.photos - b.photos)) byNorm.set(e.norm, e.name);
  const aliases = [], aliasByNorm = new Map();
  for (const [alias, owner] of Object.entries(NM.names?.aliases || {})) {
    if (!(owner in (S.people || {})) || alias === owner) continue;
    const n = norm(alias);
    if (!n || byNorm.has(n)) continue;
    aliases.push({ alias, owner, norm: n, words: wordsOf(alias), photos: S.people[owner] || 0 });
    if (!aliasByNorm.has(n)) aliasByNorm.set(n, owner);
  }
  NM.indexFor = S.people; NM.indexNames = NM.names;
  return (NM.index = { entries, byNorm, aliases, aliasByNorm });
}

// Edit distance, giving up as soon as it must be more than `max`.
function distance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < low) low = cur[j];
    }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// What a typed name means: empty, a known person (canonical spelling), or a new name with near matches.
function lookup(text) {
  const t = tidy(text), n = norm(t) || t.toLowerCase();   // a name of only symbols (🎣) still counts
  if (!t) return { state: 'empty' };
  if (!t.startsWith('_') && S.people && Object.hasOwn(S.people, t)) return { state: 'known', name: t };   // exactly as saved
  const I = index(), known = I.byNorm.get(n);
  if (known) return { state: 'known', name: known };
  const near = new Map();
  const add = (name, rank) => { if (!near.has(name) || near.get(name) > rank) near.set(name, rank); };
  const owner = I.aliasByNorm.get(n);
  if (owner) add(owner, -1e9);
  if (n.length >= 4) {
    for (const e of I.entries) { const d = distance(n, e.norm); if (d <= 2) add(e.name, d * 1e6 - e.photos); }
    for (const a of I.aliases) { const d = distance(n, a.norm); if (d <= 2) add(a.owner, d * 1e6 - a.photos); }
  }
  if (!near.size) {
    const typed = wordsOf(t).filter(w => w.length > 1);
    if (typed.length) for (const e of I.entries) if (typed.every(w => e.words.includes(w))) add(e.name, 1e8 - e.photos);
  }
  const best = [...near].sort((a, b) => a[1] - b[1]).slice(0, 2).map(([name]) => name);
  return { state: 'new', name: t, near: best };
}

// Known people for the drop-down list: every typed word starts one of the person's name words.
function matches(text, limit = 6) {
  const typed = wordsOf(text);
  if (!typed.length) return [];
  const n = norm(text), I = index(), found = new Map();
  const fits = ws => typed.every(w => ws.some(x => x.startsWith(w)));
  const consider = (name, ws, full, photos, alias) => {
    if (!fits(ws)) return;
    const score = (full.startsWith(n) ? 4 : 0) + (ws[0].startsWith(typed[0]) ? 2 : 0) + (alias ? 0 : 1);
    const old = found.get(name);
    if (!old || old.score < score) found.set(name, { name, score, photos, alias });
  };
  for (const e of I.entries) consider(e.name, e.words, e.norm, e.photos, null);
  for (const a of I.aliases) consider(a.owner, a.words, a.norm, a.photos, a.alias);
  return [...found.values()].sort((a, b) => b.score - a.score || b.photos - a.photos || a.name.localeCompare(b.name)).slice(0, limit);
}

function initials(name) {
  const w = String(name).split(/\s+/).filter(Boolean);
  return esc(((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase());
}
function avatar(name) {
  const rep = S.reps?.[name];
  return rep != null ? `<img class="nm-av" src="/thumbs/${rep}.jpg?v=${S.v}" alt="">` : `<span class="nm-av nm-ini" aria-hidden="true">${initials(name)}</span>`;
}
const photoCount = name => { const n = S.people?.[name] || 0; return `<b>${n.toLocaleString()}</b> photo${n === 1 ? '' : 's'}`; };
const photosOf = name => { const n = S.people?.[name] || 0; return n ? plural(n, 'photo') : 'no photos yet'; };

function captionWords(c) {
  if (!NM.names) return [];
  return (c.hints || []).filter(([w]) => {
    const k = String(w).toLowerCase();
    return k.length > 1 && !FILLER.has(k) && NM.vocab.has(k) && !/^[A-Z]{2,5}$/.test(w) && w !== c.name;
  });
}

// ---------- order: stable while you work, reset when the sort or filters change ----------

function stable(kind, items, sig) {
  const key = it => `${kind}:${it.id}`;
  if (NM.sig[kind] !== sig || !NM.order[kind]) {
    const m = new Map(), later = [];
    let r = 0;
    for (const it of items) NM.skipped.has(qk(key(it))) ? later.push(it) : m.set(it.id, r++);
    for (const it of later) m.set(it.id, r++);
    NM.sig[kind] = sig; NM.order[kind] = m; NM.next[kind] = r;
  }
  const m = NM.order[kind];
  for (const it of items) if (!m.has(it.id)) m.set(it.id, NM.next[kind]++);
  return items.filter(it => !NM.hidden.has(key(it))).sort((a, b) => m.get(a.id) - m.get(b.id));
}
function moveToEnd(kind, id) { if (NM.order[kind]) NM.order[kind].set(id, NM.next[kind]++); }
function saveSkipped() { session.set('naming-skipped', [...NM.skipped].slice(-2000)); }

// ---------- page furniture: tip, filter summary, shortcut hint ----------

function tip(kind) {
  const touch = touchScreen();
  const [click, photo] = touch ? ['Tap', 'Tap a face twice to see the whole photo.'] : ['Click', 'Double-click a face, or press P, to see the whole photo.'];
  return kind === 'groups'
    ? `Each group is one person as the app sees them. Name the group, or ${click.toLowerCase()} faces that don’t belong and remove them. Give two groups the same name to merge them. Faces with a dashed orange edge fit the group least. ${photo}`
    : `These faces didn’t fit a group: blurry, side-on, small, or someone who appears only once. The best matches to people you’ve named come first. ${click} faces to select several at once. ${photo}`;
}
function tipHTML(kind) {
  if (store.get(`naming-tip-${kind}`) === 'dismissed') return '';
  return `<div class="nm-tip" role="note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>
    <p>${tip(kind)}</p><button type="button" class="btn" data-nm="tip" data-tip="${kind}">Got it</button></div>`;
}

function filterSummary(groups) {
  const bits = [];
  if (groups) bits.push({ match: 'Best match first', photos: 'Most photos first', faces: 'Most faces first' }[reviewSettings.sort]);
  bits.push(reviewSettings.minimum ? `${Math.round(reviewSettings.minimum * 100)}%+ match` : 'Any score');
  if (S?.familysearch_enabled !== false) bits.push({ maternal: 'Mom’s side', paternal: 'Dad’s side', all: 'All branches', none: 'Album photos only' }[reviewSettings.branch]);
  if (showFamilySearchOnly) bits.push('FamilySearch-only groups shown');
  if (groups && showNamed) bits.push('Named groups shown');
  return bits.join(' · ');
}

const ICONS = {
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  chev: '<path d="m6 9 6 6 6-6"/>', left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
};
const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function topHTML(kind, right) {
  const groups = kind === 'groups';
  const undo = `<span>·</span> <kbd>${MOD}</kbd><kbd>Z</kbd> undo`;
  const hint = groups
    ? `<kbd>Enter</kbd> save <span>·</span> <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> use a suggestion <span>·</span> <kbd>↑</kbd><kbd>↓</kbd> move between groups <span>·</span> <kbd>Esc</kbd> then <kbd>S</kbd> skip, <kbd>I</kbd> ignore, <kbd>→</kbd> faces, <kbd>P</kbd> photo, <kbd>X</kbd> select, <kbd>N</kbd> name selected ${undo}`
    : `<kbd>Enter</kbd> save <span>·</span> <kbd>1</kbd><kbd>2</kbd> use a suggestion <span>·</span> <kbd>↑</kbd><kbd>↓</kbd> move between faces <span>·</span> <kbd>Esc</kbd> then <kbd>S</kbd> skip, <kbd>I</kbd> ignore, <kbd>P</kbd> photo, <kbd>X</kbd> select, <kbd>N</kbd> name selected ${undo}`;
  const extra = (groups && reviewSettings.labels && S?.familysearch_enabled !== false ? `<p class="meta">The FamilySearch mark is on photos imported from FamilySearch. Unmarked photos are from your albums.</p>` : '') + (NM.rebuilding ? '' : sourceMatchingScope());
  return `<div class="nm-top">
    ${tipHTML(kind)}
    <div class="nm-bar">
      <button type="button" class="nm-filter-btn" data-nm="filters" aria-expanded="${NM.filtersOpen}" aria-controls="nm-filters">
        ${svg('sliders')}<span>Sort and filters</span><span class="nm-sum">${esc(filterSummary(groups))}</span>${svg('chev', 'nm-chev')}</button>
      <div class="nm-bar-right">${right}</div>
    </div>
    <div class="nm-filters" id="nm-filters" ${NM.filtersOpen ? '' : 'hidden'}>${reviewControls(groups)}${extra}</div>
    ${touchScreen() ? '' : `<p class="nm-keys"><span class="nm-keys-label">Keys</span> ${hint} <span>·</span> <button type="button" class="nm-link" data-nm="sheet"><kbd>?</kbd> all shortcuts</button></p>`}
  </div>`;
}

function statusHTML() {
  if (NM.rebuilding || S.matching_building) {
    const side = { maternal: 'Mom’s side', paternal: 'Dad’s side', all: 'all family branches', none: 'your album photos' }[reviewSettings.branch];
    return `<div class="nm-rebuild" role="status"><span class="nm-spinner" aria-hidden="true"></span>
      <div><b>Rebuilding groups…</b><span class="meta">Grouping faces for ${side}. The first time for a branch can take a minute.</span></div></div>`;
  }
  if (S.matching_error) return `<div class="empty" role="alert">${esc(S.matching_error)} <button class="btn" id="review-retry">Try again</button></div>`;
  return '';
}

// ---------- cards ----------

function field(kind, id, value, placeholder, label) {
  const k = `${kind}:${id}`, lid = `nm-list-${kind}-${id}`, sid = `nm-status-${kind}-${id}`;
  const attr = kind === 'group' ? `data-cl="${id}"` : `data-face-input="${id}"`;
  return `<div class="nm-field"><input class="name" ${attr} data-nm-key="${k}" value="${esc(value)}" placeholder="${placeholder}"
      aria-label="${esc(label)}" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list"
      aria-expanded="false" aria-controls="${lid}" aria-describedby="${sid}">
    <div class="nm-list" id="${lid}" role="listbox" aria-label="Known people" hidden></div>
    <div class="nm-status" id="${sid}" aria-live="polite"></div></div>`;
}

function pickChips(suggest, noun) {
  return (suggest || []).map(([n, s], i) => `<button type="button" class="chip sugg" data-nm="pick" data-name="${esc(n)}"
    aria-keyshortcuts="${i + 1}" aria-label="${esc(n)}, ${Math.round(s * 100)}% match (press ${i + 1})" title="Name this ${noun} ${esc(n)} (key ${i + 1})"><kbd class="nm-key" aria-hidden="true">${i + 1}</kbd>${esc(n)}<small aria-hidden="true">${Math.round(s * 100)}%</small></button>`).join('');
}
// The suggestions on the card you're on and the next two don't change for a moment after you act, so the
// chip you just read is the one a number key picks. They catch up once you pause (about a second).
let steadyTimer = null;
function steadyChips(key, suggest) {
  const keep = NM.steady.has(key) && performance.now() - NM.actAt < 1200 && NM.chips.has(key);
  const shown = keep ? NM.chips.get(key) : suggest || [];
  if (keep && JSON.stringify(shown) !== JSON.stringify(suggest || [])) {
    clearTimeout(steadyTimer);
    steadyTimer = setTimeout(() => { if (isReviewTab() && S && !document.querySelector('#main .nm-leaving:not([hidden])')) render(); }, 1300 - (performance.now() - NM.actAt));
  }
  NM.chips.set(key, shown);
  return shown;
}

function fsChips(hints, max, links) {
  if (!reviewSettings.hints || !hints?.length) return '';
  return hints.slice(0, max).map(h => `<span class="nm-fs"><button type="button" class="chip" data-nm="fill" data-name="${esc(h.name)}"
      title="FamilySearch photo link: ${h.photos} linked photo${h.photos === 1 ? '' : 's'}. Puts ${esc(h.name)} in the name field.">${esc(h.name)}<small>${h.photos}</small></button>${links && h.familysearch_id
      ? `<a class="nm-rec" href="https://www.familysearch.org/en/tree/person/details/${encodeURIComponent(h.familysearch_id)}" target="_blank" rel="noopener noreferrer" aria-label="FamilySearch record for ${esc(h.name)} (opens in a new tab)" title="FamilySearch record">↗</a>` : ''}</span>`).join('');
}

function groupCard(c) {
  const all = expanded.has(c.id), shown = all ? c.faces : c.faces.slice(0, 36);
  const grid = `<div class="grid">${shown.map(f => faceTile(f, { odd: c.sims[f] < 0.55, cluster: c.id, showSource: true })).join('')}</div>
    ${c.faces.length > 36 ? `<button class="btn more" data-expand="${c.id}">${all ? 'Show fewer' : `Show all ${c.faces.length}`}</button>` : ''}`;
  const counts = `${plural(c.faces.length, 'face')} · ${plural(c.photos, 'photo')}`;
  if (c.name && !c.unlabeled) {
    return `<section class="card done" id="cl-${c.id}"><div class="card-head"><span class="named">${esc(c.name)}</span>
      <span class="meta">${counts}</span><span style="margin-left:auto"></span><button class="btn" data-unname="${c.id}">Clear name</button></div>${grid}</section>`;
  }
  const chipsNow = steadyChips(`group:${c.id}`, c.suggest);
  const best = bestMatch({ suggest: chipsNow });
  const draft = reviewDrafts.get(reviewDraftKey('group', c.id)) ?? c.name ?? '';
  const sugg = pickChips(chipsNow, 'group');
  const caps = captionWords(c).map(([w, k]) => `<button type="button" class="chip nm-cap" data-nm="fill" data-nm-open="1" data-name="${esc(w)}"
    title="“${esc(w)}” is in ${k} of this group’s ${c.captioned} captioned photos. Shows known people called ${esc(w)}.">${esc(w)}<small>${k}</small></button>`).join('');
  const fs = fsChips(c.unlabeled ? c.source_hints : [], 3, true);
  return `<section class="card nm-card" id="cl-${c.id}" data-nm-card="group:${c.id}" tabindex="-1" role="group" aria-label="Unnamed group, ${counts}">
    <div class="nm-head">
      ${field('group', c.id, draft, 'Who is this?', `Name for this group of ${c.faces.length} faces`)}
      <div class="nm-acts">
        <button type="button" class="btn primary" data-nm="save">Save</button>
        <button type="button" class="btn" data-nm="skip" aria-keyshortcuts="S" title="Skip for now (S). The group moves to the end of the list.">Skip</button>
        <button type="button" class="btn danger" data-nm="ignore" aria-keyshortcuts="I" title="Not someone to tag: strangers, paintings, statues (I)">Ignore</button>
        ${c.name ? `<button type="button" class="btn" data-unname="${c.id}" title="Some faces here are already named ${esc(c.name)}. This clears every name in the group.">Clear name</button>` : ''}
      </div>
      <span class="meta nm-count">${counts}${best ? ` · <span class="match-score">Best match <b>${Math.round(best * 100)}%</b></span>` : ''}</span>
    </div>
    ${sugg ? `<div class="nm-row"><span class="nm-label">Looks like</span>${sugg}</div>` : ''}
    ${caps || fs ? `<div class="nm-row">${caps ? `<span class="nm-label">In captions</span>${caps}` : ''}${caps && fs ? '<span class="nm-sep" aria-hidden="true"></span>' : ''}${fs ? `<span class="nm-label">FamilySearch links</span>${fs}` : ''}</div>` : ''}
    ${grid}
  </section>`;
}

function faceCard(l) {
  const draft = reviewDrafts.get(reviewDraftKey('face', l.id)) ?? '';
  const shown = steadyChips(`face:${l.id}`, l.suggest);
  const chips = pickChips(shown, 'face') + fsChips(l.source_hints, 2, false);
  return `<div class="left nm-card" data-nm-card="face:${l.id}" tabindex="-1" role="group" aria-label="Unnamed face${shown?.[0] ? `, looks like ${esc(shown[0][0])}` : ''}">
    ${faceTile(l.id, { showSource: true })}
    ${field('face', l.id, draft, 'Name…', 'Name for this face')}
    ${chips ? `<div class="chips nm-chips">${chips}</div>` : ''}
    <div class="nm-mini">
      <button type="button" class="btn nm-sm" data-nm="save">Save</button>
      <button type="button" class="btn nm-sm" data-nm="skip" aria-keyshortcuts="S" title="Skip for now (S). The face moves to the end of the list.">Skip</button>
      <button type="button" class="btn nm-sm danger" data-nm="ignore" aria-keyshortcuts="I" title="Not someone to tag (I)">Ignore</button>
      <button type="button" class="btn nm-sm nm-photo" data-nm="photo" aria-keyshortcuts="P" aria-label="See the whole photo for this face" title="See the whole photo (P)"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/></svg></button>
      <button type="button" class="btn nm-sm nm-photo" data-rm-face="${l.id}" aria-label="Remove the photo this face is in from the library" title="Remove this photo from the library"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>
    </div>
  </div>`;
}

// ---------- rendering (called by review.html's renderGroups/renderLeftovers) ----------

function prepare() {
  if (S !== NM.lastS) {   // a load() just finished: its request number is the current reviewRequest
    NM.lastS = S; NM.sNum = reviewRequest;
    for (const [k, e] of NM.hidden) if (e.need <= NM.sNum) NM.hidden.delete(k);
    if (NM.rebuilding && S.familysearch_matching?.branch === reviewSettings.branch) NM.rebuilding = false;
    if (NM.namesV !== S.v) { if (NM.namesV != null || !NM.names) loadNames(); NM.namesV = S.v; }
  }
  capture();
  if (!NM.restorePending) { NM.restorePending = true; queueMicrotask(() => { NM.restorePending = false; restore(); }); }
}

function renderGroups() {
  prepare();
  const eligible = stable('group', reviewGroups().filter(c => showNamed || c.unlabeled),
    [reviewSettings.sort, reviewSettings.minimum, reviewSettings.branch, showFamilySearchOnly, showNamed].join('|'));
  const pages = Math.ceil(eligible.length / GROUP_PAGE_SIZE);
  groupPage = Math.max(0, Math.min(groupPage, pages - 1));
  const start = groupPage * GROUP_PAGE_SIZE, list = eligible.slice(start, start + GROUP_PAGE_SIZE);
  const busy = statusHTML();
  const range = eligible.length > GROUP_PAGE_SIZE
    ? `<span class="meta"><b>${(start + 1).toLocaleString()}–${Math.min(start + GROUP_PAGE_SIZE, eligible.length).toLocaleString()}</b> of ${eligible.length.toLocaleString()} groups</span>
       <button type="button" class="btn nm-icon" data-group-page="-1" aria-label="Previous groups" ${groupPage === 0 ? 'disabled' : ''}>${svg('left')}</button>
       <button type="button" class="btn nm-icon" data-group-page="1" aria-label="Next groups" ${start + GROUP_PAGE_SIZE >= eligible.length ? 'disabled' : ''}>${svg('right')}</button>`
    : `<span class="meta"><b>${eligible.length.toLocaleString()}</b> ${eligible.length === 1 ? 'group' : 'groups'}</span>`;
  const regroup = `<button type="button" class="btn" data-regroup title="Group the unnamed faces again from scratch. Names aren't changed.">${regrouping ? 'Regrouping…' : 'Regroup'}</button>`;
  const top = topHTML('groups', busy ? '' : `<div class="nm-pager">${regroup}${range}</div>`);
  if (busy) return top + busy;
  if (!list.length) return top + `<div class="empty">${eligible.length || !reviewGroups().length ? 'No groups match these filters. Change a filter or use Reset filters in Sort and filters.' : 'Every group on this list has a name.'}</div>`;
  const foot = eligible.length > GROUP_PAGE_SIZE ? `<div class="nm-foot">
      <button class="btn" data-group-page="-1" ${groupPage === 0 ? 'disabled' : ''}>Previous groups</button>
      <span class="meta">Groups ${(start + 1).toLocaleString()}–${Math.min(start + GROUP_PAGE_SIZE, eligible.length).toLocaleString()} of ${eligible.length.toLocaleString()}</span>
      <button class="btn" data-group-page="1" ${start + GROUP_PAGE_SIZE >= eligible.length ? 'disabled' : ''}>Next groups</button></div>` : '';
  return top + `<div class="nm-cards">${list.map(groupCard).join('')}</div>` + foot;
}

function renderLeftovers() {
  prepare();
  const visible = stable('face', reviewLeftovers(), [reviewSettings.minimum, reviewSettings.branch, showFamilySearchOnly].join('|'));
  const busy = statusHTML();
  const sure = strongMatches(visible).length;
  const right = busy ? '' : `<div class="nm-pager">${sure ? `<button type="button" class="btn primary" data-nm="accept" title="Names each of these faces after its first suggestion. Skipped faces are left out.">Accept ${sure.toLocaleString()} strong match${sure === 1 ? '' : 'es'} (≥ 50%)</button>` : ''}
    <span class="meta">Showing <b>${Math.min(leftLimit, visible.length).toLocaleString()}</b> of ${visible.length.toLocaleString()}</span></div>`;
  const top = topHTML('leftovers', right);
  if (busy) return top + busy;
  if (!visible.length) return top + `<div class="empty">No leftover faces match these filters.</div>`;
  return top + `<div class="left-grid nm-cards">${visible.slice(0, leftLimit).map(faceCard).join('')}</div>
    ${visible.length > leftLimit ? `<div class="nm-foot"><button class="btn more" id="left-more">Show more</button></div>` : ''}`;
}

// Before the page is rebuilt: remember focus, caret and where the working card sits on screen.
function capture() {
  if (typeof captureReviewDrafts === 'function') captureReviewDrafts();
  if (NM.restore) return;   // drawn twice in a row: the first capture saw the real focus
  const main = $('#main'), a = document.activeElement;
  let focus = null;
  if (a && a !== document.body && main.contains(a)) {
    const card = a.closest('[data-nm-card]');
    if (card) {
      focus = { key: card.dataset.nmCard, start: a.selectionStart, end: a.selectionEnd, list: NM.list?.input === a,
        what: a === card ? 'card' : a.matches('input.name') ? 'input'
          : a.matches('.face') ? `.face[data-face="${a.dataset.face}"]`
          : a.dataset.nm ? `[data-nm="${a.dataset.nm}"]${a.dataset.name ? `[data-name="${CSS.escape(a.dataset.name)}"]` : ''}`
          : a.dataset.expand ? `[data-expand="${a.dataset.expand}"]` : 'card' };
    } else if (a.id) focus = { id: a.id };
    else if (a.dataset.groupPage) focus = { sel: `.nm-bar [data-group-page="${a.dataset.groupPage}"]` };
    else if (a.dataset.nm) focus = { sel: `[data-nm="${a.dataset.nm}"]` };
  }
  let anchor = focus?.key ? cardEl(focus.key) : null;
  if (!anchor && NM.cur) { const c = cardEl(NM.cur); if (c && onScreen(c)) anchor = c; }
  if (!anchor) anchor = [...main.querySelectorAll('[data-nm-card]')].find(onScreen) || null;
  NM.restore = { focus, anchorKey: anchor?.dataset.nmCard || null, anchorTop: anchor ? settledTop(anchor) : 0 };
}

// After the page is rebuilt: same card in the same place, same field focused, same caret.
function restore() {
  const R = NM.restore;
  NM.restore = null;
  if (!R || !isReviewTab()) return;
  closeList(true);
  const live = liveCards();
  for (const [q, t] of NM.recent) {   // a saved card is back (Undo, or changed elsewhere): go to it
    const k = unq(q);
    if (Date.now() - t > 120000) NM.recent.delete(q);
    else if (k && !NM.hidden.has(k) && cardEl(k)) { NM.recent.delete(q); NM.focusKey = k; break; }
  }
  if (NM.focusKey && cardEl(NM.focusKey)) {
    const card = cardEl(NM.focusKey);
    NM.focusKey = null;
    focusCard(card, 'input', { scroll: true });
  } else {
    if (!NM.cur || !cardEl(NM.cur)) NM.cur = live[0]?.dataset.nmCard || null;
    markCurrent();
    if (R.anchorKey) {
      const el = cardEl(R.anchorKey);
      if (el) { const d = el.getBoundingClientRect().top - R.anchorTop; if (Math.abs(d) >= 1) scrollBy(0, d); }
    }
    const f = R.focus;
    if (f?.key && cardEl(f.key)) {
      const card = cardEl(f.key);
      const el = f.what === 'card' ? card : f.what === 'input' ? card.querySelector('input.name') : card.querySelector(f.what);
      if (el?.classList.contains('face')) el.tabIndex = -1;
      (el || card).focus({ preventScroll: true });
      if (el && f.what === 'input' && f.start != null) { try { el.setSelectionRange(f.start, f.end); } catch {} }
      if (el && f.list) suggest(el);
    } else if (f?.key && live.length) {   // the card you were on has gone: stay at the same place in the list
      focusCard(live.find(c => c.getBoundingClientRect().bottom > R.anchorTop) || live[live.length - 1], f.what === 'input' ? 'input' : 'card');
    } else if (f?.id) document.getElementById(f.id)?.focus({ preventScroll: true });
    else if (f?.sel) document.querySelector(f.sel)?.focus({ preventScroll: true });
    else if (NM.autofocus && live.length && finePointer() && (!document.activeElement || document.activeElement === document.body || document.activeElement.closest('nav'))) {
      focusCard(cardEl(NM.cur) || live[0], 'input');
    }
  }
  if (S && live.length) NM.autofocus = false;
  for (const input of document.querySelectorAll('#main input.name[data-nm-key]')) if (input.value || NM.err.has(input.dataset.nmKey)) updateStatus(input);
}

const cardEl = key => key ? document.querySelector(`#main [data-nm-card="${CSS.escape(key)}"]`) : null;
const liveCards = () => [...document.querySelectorAll('#main [data-nm-card]')].filter(c => !c.hidden && !c.classList.contains('nm-leaving'));
function onScreen(el) { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }
function settledTop(el) {   // where the element will sit once cards that are collapsing above it are gone
  let top = el.getBoundingClientRect().top;
  for (const c of document.querySelectorAll('#main .card.nm-leaving:not([hidden])')) {
    if (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) top -= c.getBoundingClientRect().height + (parseFloat(getComputedStyle(c).marginBottom) || 0);
  }
  return top;
}
function markCurrent() {
  for (const el of document.querySelectorAll('#main .nm-current')) {
    if (el.dataset.nmCard === NM.cur) continue;
    el.classList.remove('nm-current');
    const input = el.querySelector('input.name');
    if (input && !input.value) updateStatus(input);
  }
  const card = cardEl(NM.cur);
  if (card && !card.classList.contains('nm-current')) {
    card.classList.add('nm-current');
    const input = card.querySelector('input.name');
    if (input && !input.value) updateStatus(input);
  }
}
function focusCard(card, mode = 'input', { scroll = false } = {}) {
  if (!card) return;
  NM.cur = card.dataset.nmCard;
  markCurrent();
  const el = mode === 'input' ? card.querySelector('input.name') || card : card;
  el.focus({ preventScroll: true });
  if (scroll) reveal(card);
}
function reveal(card) {
  const r = card.getBoundingClientRect(), vh = innerHeight, behavior = reduceMotion() ? 'auto' : 'smooth';
  const bar = $('#floating')?.classList.contains('on') ? 80 : 0;
  if (card.classList.contains('left')) {
    if (r.top < 8) scrollBy({ top: r.top - 16, behavior });
    else if (r.bottom > vh - bar) scrollBy({ top: r.bottom - vh + bar + 16, behavior });
  } else if (r.top < 8 || r.top > vh * 0.45) scrollBy({ top: r.top - 16, behavior });
}

// ---------- the name field: status line, known-name list ----------

function statusBox(input) {
  return input.id === 'nm-sel-name' ? $('#nm-sel-status') : input.closest('.nm-field')?.querySelector('.nm-status');
}
function updateStatus(input) {
  const box = statusBox(input);
  if (!box || !S) return;
  const k = input.dataset.nmKey, r = lookup(input.value);
  let html = '', cls = '';
  if (r.state === 'empty') {
    if (NM.err.has(k)) { html = 'Type a name first'; cls = 'err'; }
    else if (k === NM.cur && k.startsWith('group:') && finePointer() && !touchScreen()) {   // a quiet how-to on the card you're on
      const first = input.closest('[data-nm-card]')?.querySelector('[data-nm="pick"]')?.dataset.name;
      html = `<span class="nm-hint" aria-hidden="true">${first ? `Type a name, or press <kbd class="nm-key">1</kbd> for ${esc(first)}` : 'Type a name, then press Enter'}</span>`;
    }
  } else if (r.state === 'known') {
    html = `${avatar(r.name)}<span class="nm-ok" aria-hidden="true">✓</span><span>${r.name !== tidy(input.value)
      ? `Saves as <b>${esc(r.name)}</b>` : 'Known person'} · ${photosOf(r.name)}</span>`;
    cls = 'ok';
  } else {
    const near = r.near.map(n => `<button type="button" class="nm-link" data-nm="fill" data-name="${esc(n)}">${esc(n)}</button>`).join(' or ');
    if (NM.confirm.get(k) === norm(r.name)) {
      html = `<span><b>New person.</b> Press Enter again to add “${esc(r.name)}”${near ? `, or use ${near}` : ''}.</span>`;
      cls = 'warn';
    } else html = `<span class="nm-new">New person</span>${near ? `<span>· Did you mean ${near}?</span>` : ''}`;
  }
  box.className = `${input.id === 'nm-sel-name' ? 'nm-sel-status' : 'nm-status'} ${cls}`;
  box.innerHTML = html;
  const save = input.id === 'nm-sel-name' ? $('#nm-sel-name-go') : input.closest('[data-nm-card]')?.querySelector('[data-nm="save"]');
  if (save) save.textContent = cls === 'warn' ? 'Add new person' : input.id === 'nm-sel-name' ? 'Name' : 'Save';
}

function suggest(input, { word = false } = {}) {
  const box = input.parentElement?.querySelector('.nm-list');
  if (!box || !S) return;
  const items = matches(input.value, word ? 8 : 6);
  if (!items.length || (!word && items.length === 1 && norm(items[0].name) === norm(input.value))) return closeList();
  if (NM.list && NM.list.input !== input) closeList();
  NM.list = { input, box, items, active: -1 };
  const typed = wordsOf(input.value);
  const mark = name => esc(name).replace(/[^\s]+/g, w => typed.some(t => norm(w).startsWith(t)) ? `<mark>${w}</mark>` : w);
  box.innerHTML = items.map((it, i) => `<div class="nm-opt" role="option" id="${box.id}-${i}" data-i="${i}" aria-selected="false">
    ${avatar(it.name)}<span class="nm-opt-name">${mark(it.name)}${it.alias ? `<span class="nm-opt-alias">also “${esc(it.alias)}”</span>` : ''}</span>
    <span class="nm-opt-meta">${photoCount(it.name)}</span></div>`).join('')
    + (word ? `<div class="nm-opt-note">Known people with “${esc(tidy(input.value))}” in their name. Pick one, or keep typing.</div>` : '');
  box.hidden = false;
  box.style.left = box.style.right = '';
  input.setAttribute('aria-expanded', 'true');
  input.removeAttribute('aria-activedescendant');
  const r = box.getBoundingClientRect();
  if (r.right > innerWidth - 8) { box.style.left = 'auto'; box.style.right = '0'; }
}
function closeList(silent) {
  const L = NM.list;
  if (!L) return;
  NM.list = null;
  L.box.hidden = true; L.box.innerHTML = '';
  L.input.setAttribute('aria-expanded', 'false');
  L.input.removeAttribute('aria-activedescendant');
}
function moveActive(d) {
  const L = NM.list;
  if (!L) return;
  const n = L.items.length;   // -1 means "no option chosen": the typed text stays as it is
  L.active = d > 0 ? (L.active + 1 >= n ? -1 : L.active + 1) : (L.active - 1 < -1 ? n - 1 : L.active - 1);
  L.box.querySelectorAll('.nm-opt').forEach((o, i) => o.setAttribute('aria-selected', String(i === L.active)));
  if (L.active >= 0) { L.input.setAttribute('aria-activedescendant', `${L.box.id}-${L.active}`); L.box.querySelector(`[data-i="${L.active}"]`)?.scrollIntoView({ block: 'nearest' }); }
  else L.input.removeAttribute('aria-activedescendant');
}
function fill(input, name, { open = false } = {}) {
  if (!input) return;
  input.value = name;
  const k = input.dataset.nmKey;
  NM.confirm.delete(k); NM.err.delete(k);
  input.focus({ preventScroll: true });
  try { input.setSelectionRange(name.length, name.length); } catch {}
  updateStatus(input);
  open ? suggest(input, { word: true }) : closeList();
}

// ---------- actions ----------

// A save's toast. Its Undo takes back exactly that save (by its History id), not whatever changed last.
function say(msg, history, seq) {
  toast(msg, { seq, action: history && typeof undoChange === 'function' ? { label: 'Undo', run: () => undoChange(history.id) } : null });
}
// Why a save failed, for the card's error toast ("" when the app answered with its own reason).
const failText = r => r.status === 0 ? REACH_ERROR : r.error || '';
// After a save the page has already shown: the acted-on cards stay hidden until a refresh that starts after the
// save has drawn the page (then the data itself decides), and a refresh is scheduled for when the saves pause.
function settle(keys) {
  const need = reviewRequest + 1;   // the next load() to start begins after this save
  let freed = false;
  for (const k of keys) {
    NM.recent.set(qk(k), Date.now());
    const e = NM.hidden.get(k);
    if (e) { e.need = need; if (NM.sNum >= need) { NM.hidden.delete(k); freed = true; } }
  }
  refreshSoon();
  if (freed && isReviewTab()) render();
}
function keyParts(key) { const [kind, id] = key.split(':'); return [kind, +id]; }

// Save the typed name: known names save at once; a brand-new name asks for a second Enter.
function saveCard(card, text) {
  const k = card.dataset.nmCard, input = card.querySelector('input.name');
  const r = lookup(text);
  if (r.state === 'empty') { NM.err.add(k); updateStatus(input); input?.focus({ preventScroll: true }); return; }
  const name = r.name;
  if (name.startsWith('_')) { toast('Names can’t start with an underscore.', true); return; }
  if (r.state === 'new' && NM.confirm.get(k) !== norm(name)) {
    NM.confirm.set(k, norm(name)); closeList(); updateStatus(input); input?.focus({ preventScroll: true }); return;
  }
  NM.confirm.delete(k);
  return act(card, { type: 'name', name });
}

function leave(card) {
  card.classList.add('nm-leaving');
  card.inert = true;
  const done = () => { card.hidden = true; };
  if (reduceMotion()) return done();
  if (card.classList.contains('left')) { setTimeout(done, 160); return; }
  card.style.height = `${card.offsetHeight}px`;
  void card.offsetHeight;
  card.classList.add('nm-collapse');
  Object.assign(card.style, { height: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', borderWidth: '0px', opacity: '0' });
  setTimeout(done, 230);
}

function neighbour(card) {
  const cards = liveCards(), i = cards.indexOf(card);
  return cards[i + 1] || cards[i - 1] || null;
}
function focusFallback() {
  NM.cur = null;
  ($('.nm-foot [data-group-page="1"]:not([disabled])') || $('#left-more') || $('[data-nm="filters"]'))?.focus({ preventScroll: true });
}
// The cards in `going` are about to leave: focus the first card after them (else the one before) in the list.
function focusAfter(going) {
  const live = liveCards(), gone = new Set(going.filter(Boolean));
  let i = live.findIndex(c => gone.has(c));
  if (i < 0) i = Math.max(0, live.indexOf(cardEl(NM.cur)));
  const target = live.slice(i).find(c => !gone.has(c)) || live.slice(0, i).reverse().find(c => !gone.has(c));
  if (target) focusCard(target, 'input', { scroll: !onScreen(target) });
  else focusFallback();
}
function unselect(ids) {
  let changed = false;
  for (const id of ids) if (selected.delete(id)) changed = true;
  if (changed) updateFloating();
}

async function act(card, op) {
  if (!card || card.classList.contains('nm-leaving') || !S) return;
  const k = card.dataset.nmCard, [kind, id] = keyParts(k);
  const faces = kind === 'group' ? S.clusters.find(c => c.id === id)?.faces || [] : [id];
  if (!faces.length) return;
  NM.actAt = performance.now(); NM.armed = null;
  const seq = ++NM.seq;
  const top = card.getBoundingClientRect().top;
  if (kind === 'group' && top < 0) scrollBy(0, top - 16);   // keep your eye where the next card will be
  const next = neighbour(card);
  closeList();
  if (op.type !== 'skip') NM.hidden.set(k, { need: Infinity });
  leave(card);
  if (next) focusCard(next, 'input');
  else focusFallback();
  unselect(faces);   // after focus has moved, so a closing selection bar never takes focus with it
  // The cards you're about to read keep the suggestions you see now until you pause.
  const live = liveCards(), i = next ? live.indexOf(next) : -1;
  NM.steady = new Set(i >= 0 ? live.slice(i, i + 3).map(c => c.dataset.nmCard) : []);

  if (op.type === 'skip') {
    NM.skipped.add(qk(k)); saveSkipped(); moveToEnd(kind, id);
    toast(kind === 'group' ? 'Skipped for now. The group is at the end of the list.' : 'Skipped for now. The face is at the end of the list.', { seq, action: null });
    setTimeout(() => { if (isReviewTab()) render(); }, reduceMotion() ? 0 : 240);
    return;
  }
  const name = op.type === 'ignore' ? '_ignore' : op.name;
  const what = kind === 'group' ? 'group' : 'face';
  // One request: a group names only its faces that still have no name (checked by the app as it saves).
  const r = await postJSON('/api/label', { faces, name, only_unnamed: kind === 'group' }, { quiet: true });
  if (r.error) {
    NM.hidden.delete(k);
    NM.focusKey = k;   // bring the card back where it was, with its field focused for another try
    if (isReviewTab()) render();
    const why = failText(r);
    toast(op.type === 'ignore' ? `Couldn’t ignore this ${what}${why ? `: ${why}` : '.'} It’s back in the list.`
      : `Couldn’t save “${name}”${why ? `: ${why}` : '.'} The ${what} is back in the list.`, true);
    return;
  }
  NM.skipped.delete(qk(k)); saveSkipped();
  reviewDrafts.delete(reviewDraftKey(kind, id));
  settle([k]);
  const n = (r.named || []).length;
  if (!n) toast('These faces already had names, so nothing changed.', { seq, action: null });
  else say(op.type === 'ignore' ? `Ignored ${plural(n, 'face')}. ${n === 1 ? 'It' : 'They'} won’t be tagged.`
    : `Named ${plural(n, 'face')} as ${name}.`, r.history, seq);
}

function move(card, dir, mode) {
  const cards = liveCards(), i = cards.indexOf(card), target = cards[i + dir];
  if (target) return focusCard(target, mode, { scroll: true });
  if (dir > 0) toast(tab === 'groups' ? ($('.nm-foot [data-group-page="1"]:not([disabled])') ? 'That’s the last group on this page. Use Next groups for more.' : 'That’s the last group.')
    : $('#left-more') ? 'That’s the last face shown. Use Show more for more.' : 'That’s the last face.');
}

// Arrow keys inside a group: from the card to its first face, between faces, and back to the card.
function moveFace(card, tile, dir) {
  const tiles = [...card.querySelectorAll('.grid .face')];
  if (!tiles.length) return;
  const i = tile ? tiles.indexOf(tile) + dir : dir > 0 ? 0 : tiles.length - 1;
  if (i < 0) return focusCard(card, 'card');
  focusTile(tiles[Math.min(i, tiles.length - 1)], tiles.length);
}
function focusTile(tile, count) {
  const tiles = [...tile.parentElement.children];
  tile.tabIndex = -1;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-pressed', String(selected.has(+tile.dataset.face)));
  const photo = S.face_photo?.[+tile.dataset.face];
  tile.setAttribute('aria-label', `Face ${tiles.indexOf(tile) + 1} of ${count || tiles.length}${photo ? `, ${photo.split('/').pop()}` : ''}`);
  tile.focus({ preventScroll: true });
  tile.scrollIntoView({ block: 'nearest' });
}
// P on a card: the whole photo of the face you're on (a leftover card's face, or a group's focused/first face).
function openCardPhoto(card, tile) {
  const face = tile || card.querySelector('.face');
  if (face) openPhoto(+face.dataset.face);
}

function pick(card, n) {
  const chip = card.querySelectorAll('[data-nm="pick"]')[n - 1];
  if (!chip) { toast(`There’s no suggestion ${n} for this ${tab === 'groups' ? 'group' : 'face'}.`, true); return; }
  act(card, { type: 'name', name: chip.dataset.name });
}

// I on a card: ignore at once when Undo is there to take it back; otherwise press I twice.
function ignoreKey(card) {
  const k = card.dataset.nmCard;
  if (typeof undoLast === 'function' || (NM.armed?.key === k && performance.now() - NM.armed.at < 4000)) {
    NM.armed = null;
    return act(card, { type: 'ignore' });
  }
  NM.armed = { key: k, at: performance.now() };
  const n = k.startsWith('group:') ? S.clusters.find(c => c.id === keyParts(k)[1])?.faces.length || 0 : 1;
  const box = card.querySelector('.nm-status');
  if (box) {
    box.className = 'nm-status warn';
    box.innerHTML = `<span>Press <kbd class="nm-key">I</kbd> again to ignore ${n === 1 ? 'this face' : `these ${n.toLocaleString()} faces`}: no one to tag.</span>`;
  }
}
function disarm() {
  if (!NM.armed) return;
  const input = cardEl(NM.armed.key)?.querySelector('input.name');
  NM.armed = null;
  if (input) updateStatus(input);
}

// ---------- selection bar (Groups and Leftover faces) ----------

function floating(mode) {
  NM.confirm.delete('sel'); NM.err.delete('sel');
  const nameField = `<span class="nm-field up nm-sel-field"><input class="name" id="nm-sel-name" data-nm-key="sel" placeholder="Name selected…"
      aria-label="Name the selected faces" aria-keyshortcuts="N" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list"
      aria-expanded="false" aria-controls="nm-list-sel" aria-describedby="nm-sel-status"><span class="nm-list" id="nm-list-sel" role="listbox" aria-label="Known people" hidden></span></span>
    <button class="btn" id="nm-sel-name-go">Name</button><span class="nm-sel-status" id="nm-sel-status" aria-live="polite"></span>`;
  return mode === 'leftovers'
    ? `${nameField}<button class="btn" id="nm-sel-skip">Skip selected</button><button class="btn" id="nm-sel-ignore" title="Not someone to tag">Ignore selected</button><button class="btn" id="nm-sel-rmphoto" title="Take the photos these faces are in out of the library">Remove their photos</button>`
    : `${nameField}<button class="btn" id="nm-sel-split">Split into new group</button><button class="btn" id="nm-sel-remove">Remove from group</button><button class="btn" id="nm-sel-rmphoto" title="Take the photos these faces are in out of the library">Remove their photos</button>`;
}

function fadeTiles(ids) {
  for (const id of ids) document.querySelectorAll(`#main .face[data-face="${id}"]`).forEach(t => t.classList.add('nm-gone'));
}
function afterBar(ids) {   // Groups: back to the name field of the group the faces came from
  const card = document.querySelector(`#main .face[data-face="${ids[0]}"]`)?.closest('[data-nm-card]');
  const target = card && !card.classList.contains('nm-leaving') ? card : cardEl(NM.cur) || liveCards()[0];
  if (target) focusCard(target, 'input', { scroll: !onScreen(target) });
  else focusFallback();
}
// Leftover faces: the selected cards leave; focus moves to the card after them.
function leaveSelected(ids) {
  const going = ids.map(id => cardEl(`face:${id}`));
  focusAfter(going);
  for (const c of going) if (c) leave(c);
}

async function nameSelected() {
  const input = $('#nm-sel-name');
  if (!input) return;
  const r0 = lookup(input.value);
  if (r0.state === 'empty') { NM.err.add('sel'); updateStatus(input); input.focus(); return; }
  const name = r0.name;
  if (name.startsWith('_')) { toast('Names can’t start with an underscore.', true); return; }
  if (r0.state === 'new' && NM.confirm.get('sel') !== norm(name)) { NM.confirm.set('sel', norm(name)); closeList(); updateStatus(input); return; }
  NM.confirm.delete('sel');
  const ids = [...selected], inGroups = tab === 'groups';
  NM.actAt = performance.now();
  const seq = ++NM.seq;
  closeList(); input.value = ''; updateStatus(input);
  if (inGroups) { afterBar(ids); fadeTiles(ids); }
  else { for (const id of ids) NM.hidden.set(`face:${id}`, { need: Infinity }); leaveSelected(ids); }
  selected.clear(); updateFloating();
  const keys = ids.map(id => `face:${id}`);
  // One request: in Groups the faces also leave their group (so the rest keeps its own name), in the same change.
  const r = await postJSON('/api/label', { faces: ids, name, reject: inGroups }, { quiet: true });
  if (r.error) {
    for (const k of keys) NM.hidden.delete(k);
    if (isReviewTab()) render();
    const why = failText(r);
    toast(`Couldn’t name the selected faces “${name}”${why ? `: ${why}` : '.'} Try again.`, true);
    return;
  }
  settle(keys);
  say(`Named ${plural(ids.length, 'face')} as ${name}.`, r.history, seq);
}

async function splitSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  const src = S.clusters.find(c => c.faces.includes(ids[0]))?.id;
  const btn = $('#nm-sel-split');
  if (btn) btn.disabled = true;
  try {
    const j = await postJSON('/api/naming/split', { branch: reviewSettings.branch, faces: ids }, { quiet: true });
    if (j.error) throw new Error(j.status === 0 ? REACH_ERROR : j.error);
    const r = src != null ? NM.order.group?.get(src) : null;
    if (r != null) NM.order.group.set(j.id, r + 0.001 * (++NM.splits % 900 + 1));
    NM.focusKey = `group:${j.id}`;
    afterBar(ids);   // focus stays in the page while the bar closes
    selected.clear(); updateFloating();
    const what = `Split ${plural(j.faces, 'face')} into a new group`;
    say(`${what}.`, j.history);
    await load();
    if (!cardEl(NM.focusKey) && NM.focusKey === `group:${j.id}`) {
      NM.focusKey = null;
      const back = cardEl(`group:${src}`) || cardEl(NM.cur) || liveCards()[0];
      if (back) focusCard(back, 'input', { scroll: !onScreen(back) });
      const c = S.clusters.find(c => c.id === j.id);
      const fsOnly = c && !showFamilySearchOnly && c.faces.every(f => familySearchFace(f));
      say(`${what}. Your filters hide it${fsOnly ? ' because all its photos are from FamilySearch. Turn on “Show groups made only of FamilySearch photos” to see it' : ''}.`, j.history);
    }
  } catch (err) {
    toast(err.message ? `Couldn’t split these faces into a new group: ${err.message}` : 'Couldn’t split these faces into a new group. Try again.', true);
  } finally { if (btn) btn.disabled = false; }
}

async function removeSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  NM.actAt = performance.now();
  const seq = ++NM.seq;
  afterBar(ids);
  selected.clear(); updateFloating(); fadeTiles(ids);
  const r = await postJSON('/api/reject', { faces: ids }, { quiet: true });
  if (r.error) {
    if (isReviewTab()) render();
    toast(`Couldn’t remove these faces from the group${failText(r) ? `: ${failText(r)}` : '.'} Try again.`, true);
    return;
  }
  settle([]);
  say(`Removed ${plural(ids.length, 'face')} from ${ids.length === 1 ? 'its group' : 'their groups'}. ${ids.length === 1 ? 'It’s' : 'They’re'} in Leftover faces now.`, r.history, seq);
}

function skipSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  NM.actAt = performance.now();
  leaveSelected(ids);
  selected.clear(); updateFloating();
  for (const id of ids) { NM.skipped.add(`face:${id}`); moveToEnd('face', id); }
  saveSkipped();
  toast(`Skipped ${plural(ids.length, 'face')} for now. ${ids.length === 1 ? 'It’s' : 'They’re'} at the end of the list.`);
  setTimeout(() => { if (isReviewTab()) render(); }, reduceMotion() ? 0 : 240);
}

async function ignoreSelected() {
  const ids = [...selected];
  if (!ids.length) return;
  NM.actAt = performance.now();
  const seq = ++NM.seq;
  const keys = ids.map(id => `face:${id}`);
  for (const k of keys) NM.hidden.set(k, { need: Infinity });
  leaveSelected(ids);
  selected.clear(); updateFloating();
  const r = await postJSON('/api/label', { faces: ids, name: '_ignore' }, { quiet: true });
  if (r.error) {
    for (const k of keys) NM.hidden.delete(k);
    if (isReviewTab()) render();
    toast(`Couldn’t ignore the selected faces${failText(r) ? `: ${failText(r)}` : '.'} Try again.`, true);
    return;
  }
  settle(keys);
  say(`Ignored ${plural(ids.length, 'face')}. ${ids.length === 1 ? 'It' : 'They'} won’t be tagged.`, r.history, seq);
}

// Leftover faces with a strong first suggestion (50% or more), leaving out faces you skipped.
function strongMatches(list) {
  return list.filter(l => l.suggest?.[0] && l.suggest[0][1] >= 0.5 && !NM.skipped.has(`face:${l.id}`));
}
// "Alice Jane Moore, Sam and Theo" (with a count only where someone gets more than one face).
function namesList(batch) {
  const parts = batch.map(b => b.faces.length > 1 ? `${b.name} (${b.faces.length.toLocaleString()})` : b.name);
  if (parts.length > 4) return `${parts.slice(0, 3).join(', ')} and ${plural(parts.length - 3, 'other')}`;
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}
async function acceptStrong(btn) {
  if (!S || NM.accepting) return;
  const rows = strongMatches(reviewLeftovers().filter(l => !NM.hidden.has(`face:${l.id}`)));
  if (!rows.length) return;
  const by = new Map();
  for (const l of rows) { const n = l.suggest[0][0]; by.has(n) ? by.get(n).push(l.id) : by.set(n, [l.id]); }
  const batch = [...by].map(([name, faces]) => ({ name, faces })).sort((a, b) => b.faces.length - a.faces.length);
  const keys = rows.map(l => `face:${l.id}`), going = keys.map(cardEl);
  NM.accepting = true; NM.actAt = performance.now();
  const seq = ++NM.seq;
  if (btn) btn.disabled = true;
  for (const k of keys) NM.hidden.set(k, { need: Infinity });
  const a = document.activeElement;
  if (!a || a === document.body || a === btn || going.includes(a.closest?.('[data-nm-card]'))) {
    const first = liveCards().find(c => !going.includes(c));
    if (first) focusCard(first, 'input'); else focusFallback();
  }
  for (const c of going) if (c) leave(c);
  unselect(rows.map(l => l.id));
  try {
    // One request, so History lists it once and Undo takes it all back; faces named meanwhile are left alone.
    const r = await postJSON('/api/label', { batch, only_unnamed: true }, { quiet: true });
    if (r.error) throw new Error(failText(r));
    settle(keys);
    const n = (r.named || []).length;
    say(!n ? 'These faces already had names, so nothing changed.'
      : batch.length === 1 ? `Named ${plural(n, 'face')} as ${batch[0].name}.` : `Named ${plural(n, 'face')}: ${namesList(batch)}.`, n ? r.history : null, seq);
  } catch (err) {
    for (const k of keys) NM.hidden.delete(k);
    if (isReviewTab()) render();
    toast(`Couldn’t accept the strong matches${err.message ? `: ${err.message}` : '.'} The faces are back in the list, so try again.`, true);
  } finally {
    NM.accepting = false;
    if (btn?.isConnected) btn.disabled = false;
  }
}

function toggleSelect(tile, e) {
  const id = +tile.dataset.face;
  if (e?.shiftKey && lastClicked != null) {
    const tiles = [...document.querySelectorAll('#main .left:not(.nm-leaving) .face')];
    const a = tiles.findIndex(x => +x.dataset.face === lastClicked), b = tiles.indexOf(tile);
    if (a >= 0 && b >= 0) {
      for (const x of tiles.slice(Math.min(a, b), Math.max(a, b) + 1)) { selected.add(+x.dataset.face); x.classList.add('sel'); }
      lastClicked = id; return updateFloating();
    }
  }
  selected.has(id) ? selected.delete(id) : selected.add(id);
  tile.classList.toggle('sel', selected.has(id));
  tile.setAttribute('aria-pressed', String(selected.has(id)));
  lastClicked = id;
  updateFloating();
}

// ---------- shortcuts sheet ----------

function openSheet() {
  let d = $('#nm-sheet');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'nm-sheet'; d.className = 'nm-sheet'; d.setAttribute('aria-labelledby', 'nm-sheet-title');
    document.body.appendChild(d);
    d.addEventListener('close', () => { const el = NM.sheetReturn; NM.sheetReturn = null; if (el?.isConnected) el.focus({ preventScroll: true }); });
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
  }
  NM.sheetReturn = document.activeElement;
  const dismissed = ['groups', 'leftovers'].some(k => store.get(`naming-tip-${k}`) === 'dismissed');
  const row = (keys, text) => `<dt>${keys.map(k => `<kbd>${k}</kbd>`).join(' ')}</dt><dd>${text}</dd>`;
  const twice = typeof undoLast === 'function' ? '' : ' Press it twice: the first press asks.';
  d.innerHTML = `<div class="nm-sheet-head"><h2 id="nm-sheet-title">Keyboard shortcuts</h2><button type="button" class="btn" data-nm="sheet-close">Close</button></div>
    <div class="nm-sheet-body">
      <h3>While typing a name</h3>
      <dl>${row(['Enter'], 'Save the name. A new name asks you to press Enter again.')}
        ${row(['1', '2', '3'], 'With the field empty: use that suggestion.')}
        ${row(['↑', '↓'], 'With the field empty: previous or next card. With text: choose from known people.')}
        ${row(['Esc'], 'Leave the field to use the card keys below.')}</dl>
      <h3>On a card, after Esc</h3>
      <dl>${row(['Enter'], 'Save the typed name, or go back to the name field.')}
        ${row(['1', '2', '3'], 'Use that suggestion.')}
        ${row(['S'], 'Skip for now. The card moves to the end of the list.')}
        ${row(['P'], 'See the whole photo of the face you’re on.')}
        ${row(['I'], `Ignore: not someone to tag (strangers, paintings, statues).${twice}`)}
        ${row(['J', '↓'], 'Next card.')}${row(['K', '↑'], 'Previous card.')}
        ${row(['→', '←'], 'Groups: move between the faces in the group. Leftover faces: next or previous face.')}
        ${row(['X'], 'Select or unselect the face you’re on.')}
        ${row(['N'], 'Name the selected faces, in the bar at the bottom of the window.')}
        ${row(['Enter'], 'On a face in a group: see the whole photo.')}
        ${row(['?'], 'Show this list.')}
        ${row(['A–Z'], 'Any other letter, or any capital letter, starts typing a name.')}</dl>
      <h3>Anywhere</h3>
      <dl>${row([MOD, 'Z'], 'Undo the last change, also from an empty name field.')}
        ${row(['⇧', MOD, 'Z'], 'Redo it.')}</dl>
      <h3>In the selection bar</h3>
      <dl>${row(['Enter'], 'Name the selected faces.')}
        ${row(['Esc'], 'Back to the card. Press Esc again to clear the selection.')}</dl>
      <p class="meta">With a mouse: click faces to select them, then use the bar at the bottom of the window to name, split or remove them. Double-click a face to see its photo.</p>
      ${dismissed ? '<button type="button" class="btn" data-nm="tips-reset">Show page tips again</button>' : ''}
    </div>`;
  d.showModal();
  d.querySelector('[data-nm="sheet-close"]')?.focus();
}

// ---------- events ----------

// Put the caret at the end of the card's name field; the key being pressed then types into it.
function toField(card) {
  const input = card.querySelector('input.name');
  if (!input) return null;
  focusCard(card, 'input');
  try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  return input;
}

function keydown(e) {
  if ($('#nm-sheet')?.open) return e.key === 'Escape';   // the sheet closes itself; don't also clear the selection
  if (!isReviewTab() || !S) return false;
  if ($('#modal')?.classList.contains('on') || document.querySelector('dialog[open]')) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const t = e.target, key = e.key;
  if (NM.armed && key !== 'i' && key !== 'Shift') disarm();
  const list = NM.list && NM.list.input === t ? NM.list : null;
  if (list) {
    if (key === 'ArrowDown' || key === 'ArrowUp') { e.preventDefault(); moveActive(key === 'ArrowDown' ? 1 : -1); return true; }
    if (key === 'Escape') { e.preventDefault(); closeList(); return true; }
    if (key === 'Enter' && list.active >= 0) { e.preventDefault(); fill(t, list.items[list.active].name); return true; }
    if (key === 'Tab') closeList();
  }
  if (t.id === 'nm-sel-name') {
    if (key === 'Enter') { e.preventDefault(); nameSelected(); return true; }
    if ((key === 'ArrowDown' || key === 'ArrowUp') && t.value.trim()) { e.preventDefault(); suggest(t); moveActive(key === 'ArrowDown' ? 1 : -1); return true; }
    if (key === 'Escape') {   // back to the card you were on; the selection stays
      const c = cardEl(NM.cur) || liveCards()[0];
      if (!c) return false;
      e.preventDefault(); NM.kb = true; focusCard(c, 'card', { scroll: !onScreen(c) }); return true;
    }
    return false;
  }
  const card = t.closest?.('#main [data-nm-card]');
  if (!card) {
    const typing = t.matches?.('input, select, textarea, [contenteditable]');
    if (key === '?' && !typing) { e.preventDefault(); openSheet(); return true; }
    if ((key === 'j' || key === 'k') && !typing && !t.closest?.('#floating, dialog')) {
      const c = cardEl(NM.cur) || liveCards()[0];
      if (c) { e.preventDefault(); NM.kb = true; focusCard(c, 'card', { scroll: true }); return true; }
    }
    return false;
  }
  if (card.classList.contains('nm-leaving')) { e.preventDefault(); return true; }
  if (t.matches('input.name')) {
    const empty = !t.value.trim();
    if (key === 'Enter') { e.preventDefault(); saveCard(card, t.value); return true; }
    if (key === 'Escape') { e.preventDefault(); NM.confirm.delete(card.dataset.nmCard); updateStatus(t); NM.kb = true; focusCard(card, 'card'); return true; }
    if (key === '?' && empty) { e.preventDefault(); openSheet(); return true; }   // otherwise "?" is part of a name: "Mary ? Smith"
    if (empty && /^[1-3]$/.test(key)) { e.preventDefault(); pick(card, +key); return true; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (empty) move(card, key === 'ArrowDown' ? 1 : -1, 'input');
      else { suggest(t); moveActive(key === 'ArrowDown' ? 1 : -1); }
      return true;
    }
    return false;   // typing
  }
  const tile = t.matches('.face') ? t : null;
  const onControl = t !== card && !tile && t.matches('button, a, input, select, textarea');
  if ((key === 'Enter' || key === ' ') && onControl) return false;   // buttons and links work as usual
  const printable = key.length === 1 && key !== ' ';
  // Letter keys act only on a card you reached with the keyboard (Esc, J/K, arrows, Tab). After a click,
  // keys behave as they do in the name field, so typing a name can never skip or ignore a card.
  if (printable && !NM.kb) {
    const input = toField(card);
    if (!input) return false;
    if (!input.value.trim() && (/^[1-3]$/.test(key) || key === '?')) { e.preventDefault(); key === '?' ? openSheet() : pick(card, +key); }
    return true;   // the key types into the field
  }
  if (printable && key !== '?' && key !== key.toLowerCase()) { toField(card); return true; }   // a capital letter starts a name
  switch (printable ? key.toLowerCase() : key) {
    case 'Enter': {
      e.preventDefault();
      if (tile) { openPhoto(+tile.dataset.face); return true; }
      const input = card.querySelector('input.name');
      if (input?.value.trim()) saveCard(card, input.value); else toField(card);
      return true;
    }
    case ' ':
      if (!tile) return false;
      e.preventDefault(); toggleSelect(tile); return true;
    case '1': case '2': case '3': e.preventDefault(); pick(card, +key); return true;
    case 's': e.preventDefault(); act(card, { type: 'skip' }); return true;
    case 'p': e.preventDefault(); openCardPhoto(card, tile); return true;
    case 'i': e.preventDefault(); ignoreKey(card); return true;
    case 'j': case 'ArrowDown': e.preventDefault(); move(card, 1, 'card'); return true;
    case 'k': case 'ArrowUp': e.preventDefault(); move(card, -1, 'card'); return true;
    case 'ArrowRight': case 'ArrowLeft': {
      e.preventDefault();
      const d = key === 'ArrowRight' ? 1 : -1;
      if (card.classList.contains('left')) move(card, d, 'card'); else moveFace(card, tile, d);
      return true;
    }
    case 'x': {
      e.preventDefault();
      const face = tile || card.querySelector('.face');
      if (!face) return true;
      if (!tile && !card.classList.contains('left')) focusTile(face);
      toggleSelect(face);
      return true;
    }
    case 'n':
      if (!selected.size || !$('#nm-sel-name')) break;
      e.preventDefault(); $('#nm-sel-name').focus(); return true;
    case '?': e.preventDefault(); openSheet(); return true;
  }
  if (printable) { toField(card); return true; }   // any other key starts typing a name
  return false;
}

document.addEventListener('pointerdown', () => { NM.kb = false; }, true);
document.addEventListener('keydown', e => { if (e.key === 'Tab') NM.kb = true; }, true);

document.addEventListener('click', e => {
  const sheetBtn = e.target.closest('#nm-sheet [data-nm]');
  if (sheetBtn) {
    if (sheetBtn.dataset.nm === 'sheet-close') $('#nm-sheet').close();
    if (sheetBtn.dataset.nm === 'tips-reset') { store.del('naming-tip-groups'); store.del('naming-tip-leftovers'); $('#nm-sheet').close(); if (isReviewTab()) render(); }
    return;
  }
  if (!isReviewTab() || !S) return;
  const opt = e.target.closest('.nm-opt');
  if (opt && NM.list) { fill(NM.list.input, NM.list.items[+opt.dataset.i].name); return; }
  const bar = e.target.closest('#nm-sel-name-go, #nm-sel-split, #nm-sel-remove, #nm-sel-skip, #nm-sel-ignore');
  if (bar) {
    if (bar.disabled) return;
    if (bar.id === 'nm-sel-name-go') return nameSelected();
    if (bar.id === 'nm-sel-split') return splitSelected();
    if (bar.id === 'nm-sel-remove') return removeSelected();
    if (bar.id === 'nm-sel-skip') return skipSelected();
    if (bar.id === 'nm-sel-ignore') return ignoreSelected();
  }
  const tile = tab === 'leftovers' && e.target.closest('#main .left .face');
  if (tile) { if (e.detail <= 1) toggleSelect(tile, e); return; }
  const photoBtn = e.target.closest('#main [data-nm="photo"]');
  if (photoBtn) { const c = photoBtn.closest('[data-nm-card]'); if (c) openCardPhoto(c); return; }
  const t = e.target.closest('[data-nm]');
  if (!t || !$('#main').contains(t) && !t.closest('#floating')) return;
  const card = t.closest('[data-nm-card]');
  // One action per click: the second click of a double-click lands on the card that slid into place.
  const acting = ['save', 'skip', 'ignore', 'pick'].includes(t.dataset.nm);
  if (acting && (e.detail > 1 || performance.now() - NM.actAt < 350)) return;
  switch (t.dataset.nm) {
    case 'save': return card && saveCard(card, card.querySelector('input.name')?.value || '');
    case 'skip': return card && act(card, { type: 'skip' });
    case 'ignore': return card && act(card, { type: 'ignore' });
    case 'pick': return card && act(card, { type: 'name', name: t.dataset.name });
    case 'fill': {
      const input = card ? card.querySelector('input.name') : $('#nm-sel-name');
      if (card) { NM.cur = card.dataset.nmCard; markCurrent(); }
      return fill(input, t.dataset.name, { open: t.dataset.nmOpen === '1' });
    }
    case 'accept': return acceptStrong(t);
    case 'tip': {
      store.set(`naming-tip-${t.dataset.tip}`, 'dismissed');
      const tip = t.closest('.nm-tip');
      $('[data-nm="filters"]')?.focus({ preventScroll: true });
      tip?.remove();
      return toast(finePointer() ? 'Tip hidden. Press ? to bring it back.' : 'Tip hidden.');
    }
    case 'filters': {
      NM.filtersOpen = !NM.filtersOpen;
      session.set('naming-filters-open', NM.filtersOpen);
      t.setAttribute('aria-expanded', String(NM.filtersOpen));
      $('#nm-filters').hidden = !NM.filtersOpen;
      return;
    }
    case 'sheet': return openSheet();
  }
});

document.addEventListener('mousedown', e => {
  if (e.target.closest('.nm-list')) return e.preventDefault();   // keep focus in the field
  if (!isReviewTab() || e.button !== 0 || !$('#main')?.contains(e.target)) return;
  if (e.target.closest('input, button, a, select, textarea, label, summary, [contenteditable]')) return;
  const card = e.target.closest('[data-nm-card]');
  if (card && !card.classList.contains('nm-leaving')) {
    // A click on a face or on the card itself never puts the card in "card keys" mode: with a mouse,
    // focus goes to (or stays in) its name field; on a touch screen it stays where it is (no keyboard pops up).
    e.preventDefault();
    if (finePointer() && document.activeElement !== card.querySelector('input.name')) toField(card);
    return;
  }
  if (performance.now() - NM.actAt < 600) e.preventDefault();   // the gap a card just left: keep focus on the next one
});

document.addEventListener('input', e => {
  const t = e.target;
  if (!t.matches?.('input.name[data-nm-key]') || !S) return;
  NM.confirm.delete(t.dataset.nmKey); NM.err.delete(t.dataset.nmKey);
  updateStatus(t);
  t.value.trim() ? suggest(t) : closeList();
});

document.addEventListener('focusin', e => {
  const card = e.target.closest?.('#main [data-nm-card]');
  if (card && !card.classList.contains('nm-leaving') && NM.cur !== card.dataset.nmCard) { NM.cur = card.dataset.nmCard; markCurrent(); }
  if (NM.list && NM.list.input !== e.target && !NM.list.box.contains(e.target)) closeList();
});
document.addEventListener('focusout', e => {
  if (NM.list && NM.list.input === e.target && !NM.list.box.contains(e.relatedTarget)) setTimeout(() => { if (NM.list?.input === e.target && document.activeElement !== e.target) closeList(); }, 0);
});
// Back / forward: review.html's listener (registered first) has drawn the page by now. As on a fresh
// load, put the caret in the current card's name field unless you're already somewhere in the page.
window.addEventListener('popstate', () => {
  if (!isReviewTab() || !S || !finePointer()) return;
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest('nav')) return;
  const c = cardEl(NM.cur) || liveCards()[0];
  if (c) focusCard(c, 'input');
});

// The branch filter re-groups faces on the server: say so at once instead of showing the old groups.
// Group ids belong to one branch, so anything remembered about a group card is dropped.
function rebuilding() {
  NM.rebuilding = true;
  NM.order = { group: null, face: null };
  for (const k of [...NM.hidden.keys()]) if (k.startsWith('group:')) NM.hidden.delete(k);
  for (const m of [NM.confirm, NM.err]) for (const k of [...m.keys()]) if (String(k).startsWith('group:')) m.delete(k);
  if (NM.cur?.startsWith('group:')) NM.cur = null;
  NM.armed = null;
  if (isReviewTab() && S) render();
}

async function saveGroup(id, name) {
  const card = cardEl(`group:${id}`);
  if (card) return saveCard(card, name);
}

loadNames();
// Other names a person goes by (album names, FamilySearch spellings), for pages that search names.
let aliasIndex = null, aliasFor = null;
function aliasesOf(name) {
  if (!NM.names) return [];
  if (aliasFor !== NM.names) {
    aliasIndex = new Map(); aliasFor = NM.names;
    for (const [alias, owner] of Object.entries(NM.names.aliases || {})) (aliasIndex.get(owner) || aliasIndex.set(owner, []).get(owner)).push(alias);
  }
  return aliasIndex.get(name) || [];
}
window.Naming = { renderGroups, renderLeftovers, saveGroup, rebuilding, floating, lookup, matches, aliasesOf };
window.namingKeydown = keydown;

// review.html may have drawn the page before this file loaded.
if (typeof S !== 'undefined' && S && isReviewTab()) render();
})();

// Regroup: rebuild the groups of unnamed faces now (an import does this at its end). Runs on the server like an
// import; the page polls /api/import until it's done, then reloads.
var regrouping = false;
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-regroup]");
  if (!b || regrouping) return;
  regrouping = true; b.disabled = true; b.textContent = "Regrouping…";
  try {
    const r = await postJSON("/api/regroup", {}, { quiet: true });
    if (r && r.error) throw new Error(r.error);
    toast("Regrouping the unnamed faces. This takes a minute or two.");
    let st;
    do {
      await new Promise(res => setTimeout(res, 1500));
      st = await fetch("/api/import").then(r => r.json());
    } while (st.running);
    if (st.error) throw new Error(st.error);
    groupPage = 0;
    await load();
    const g = st.regrouped || "";
    toast(g ? `Regrouped: ${g.split(";")[0].replace("clusters", "groups")}.` : "Regrouped.");
  } catch (err) {
    toast(`Couldn’t regroup. ${err.message || ""}`, true);
  } finally {
    regrouping = false;
    if (tab === "groups") render();
  }
});
