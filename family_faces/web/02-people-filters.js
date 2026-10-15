const PEOPLE_FILTER_KEY = 'family-faces-people-filters';
const PEOPLE_FILTER_DEFAULTS = {source:'hide-familysearch-only', distance:'any', root:'', partners:true, sort:'name', hasPhotos:true};
let peopleFilters = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PEOPLE_FILTER_KEY) || '{}') || {}; } catch {}
  const value = {...PEOPLE_FILTER_DEFAULTS, ...saved};
  if (!['all','all-including-hidden','hidden','hide-familysearch-only','album','familysearch-only','none'].includes(value.source)) value.source = PEOPLE_FILTER_DEFAULTS.source;
  if (!['any','known','0','1','2','3','4','6','unknown'].includes(value.distance)) value.distance = 'any';
  if (!['name','photos','distance'].includes(value.sort)) value.sort = 'name';
  if (typeof value.root !== 'string') value.root = '';
  value.partners = value.partners !== false;
  value.hasPhotos = value.hasPhotos !== false;
  return value;
})();
let peopleRelations = null, peopleRelationsRequest = 0, peopleRelationsError = '', peopleRelationsBusy = false;
// The list can hold ~4,000 people: only the cards that match are built, a page at a time.
const PEOPLE_PAGE = 120;
let peopleShown = PEOPLE_PAGE, peopleCards = {S: null, map: new Map()}, peopleMoreObserver = null, peopleRestoreY = null;
const peopleCollator = new Intl.Collator(undefined, {sensitivity:'base', numeric:true});
const peopleFold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase();

function savePeopleFilters() {
  try { localStorage.setItem(PEOPLE_FILTER_KEY, JSON.stringify(peopleFilters)); } catch {}
}
function showAllPeopleSearch(query) {
  peopleFilter = query;
  peopleFilters = {...peopleFilters, source:'all-including-hidden', hasPhotos:false, distance:'any'};
  peopleShown = PEOPLE_PAGE;
  savePeopleFilters();
}
function peopleMoreOpen() {
  try { return localStorage.getItem('family-faces-people-more') === 'open'; } catch { return false; }
}
document.addEventListener('toggle', e => {
  if (!e.target.matches?.('.people-more-filters')) return;
  try { localStorage.setItem('family-faces-people-more', e.target.open ? 'open' : 'closed'); } catch {}
}, true);
function peopleListView() {
  const names = Object.keys({...S.people, ...S.hidden_people});
  peopleRestoreY = scrollY;   // render() restores the scroll before the cards exist; applyPeopleFilters does it after
  if (window.peopleHeaderActions) peopleHeaderActions();
  if (!names.length) return '<div class="empty">No one named yet.</div>';
  if (!S.people_tree_names.includes(peopleFilters.root)) peopleFilters.root = S.people_default_root || '';
  const options = (key, rows) => rows.map(([v,label]) => `<option value="${v}" ${peopleFilters[key] === v ? 'selected' : ''}>${label}</option>`).join('');
  const active = [peopleFilters.source !== 'hide-familysearch-only' && peopleFilters.source !== 'all', peopleFilters.distance !== 'any', !peopleFilters.partners].filter(Boolean).length;
  return `<div class="people-filters people-filters-main" aria-label="Find people">
      <label>Find a person<input id="people-search" type="search" placeholder="Search names…" value="${esc(peopleFilter)}" autocomplete="off"></label>
      <label>Sort by<select id="people-list-sort">${options('sort', [['name','Name'],['photos','Most photos'],['distance','Closest family connection']])}</select></label>
    </div>
    <details class="people-more-filters" ${peopleMoreOpen() ? 'open' : ''}>
      <summary>Filters${active ? ` <span class="filter-count">${active}</span>` : ''}</summary>
      <div class="people-filters" aria-label="People filters">
      <label>Photo source<select id="people-source">${options('source', [['all','All people'],['all-including-hidden','All people, including FamilySearch tag names'],['hidden','Only FamilySearch tag names'],['hide-familysearch-only','Hide FamilySearch-only people'],['album','Has album photos'],['familysearch-only','FamilySearch photos only'],['none','No photos yet']])}</select></label>
      <label>Related to<input id="people-root" list="people-root-options" placeholder="Choose a person…" value="${esc(peopleFilters.root)}" autocomplete="off" aria-describedby="people-distance-note"></label>
      <label>Relationship distance<select id="people-distance">${options('distance', [['any','Any distance'],['known','Has a known link'],['0','Selected person only'],['1','Within 1 family link'],['2','Within 2 family links'],['3','Within 3 family links'],['4','Within 4 family links'],['6','Within 6 family links'],['unknown','No known link']])}</select></label>
      <label>Connections<select id="people-connections"><option value="true" ${peopleFilters.partners ? 'selected' : ''}>Parents, children, and partners</option><option value="false" ${!peopleFilters.partners ? 'selected' : ''}>Parents and children only</option></select></label>
      </div>
      <p class="people-filter-note" id="people-distance-note">One parent, child, or partner connection is one family link. Siblings and grandparents are usually 2 links away; first cousins are usually 4. Distances use the saved tree.</p>
    </details>
    <datalist id="people-root-options">${S.people_tree_names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    ${Object.keys(S.hidden_people || {}).length ? `<p class="people-filter-note">${Object.keys(S.hidden_people).length.toLocaleString()} people named only in FamilySearch tags aren’t shown. Choose “Only FamilySearch tag names” in Photo source to see them.</p>` : ''}
    <p class="people-filter-error" id="people-filter-error" role="alert" hidden></p>
    <div class="people-filter-summary">
      <p id="people-filter-count" role="status"></p>
      <label class="pp-switch"><input type="checkbox" id="people-has-photos" ${peopleFilters.hasPhotos ? 'checked' : ''} ${peopleFilters.source === 'none' ? 'disabled' : ''}><span>Only people with photos</span></label>
      <button class="btn" id="people-clear-filters">Clear filters</button>
    </div>
    <div class="empty" id="people-filter-empty" hidden>No people match these filters. Change the photo source or relationship distance.</div>
    <div class="people" id="filtered-people"></div>
    <div class="people-more" id="people-more-row" hidden><button class="btn" id="people-more"></button><span class="meta" id="people-more-note"></span></div>`;
}
function peopleDistances() {
  return peopleRelations?.root === peopleFilters.root && peopleRelations.partners === peopleFilters.partners ? peopleRelations.distances : null;
}
// Names that pass every filter, sorted. Pure data work: ~4,000 names take a couple of milliseconds.
function peopleMatches(distances) {
  const source = peopleFilters.source, q = peopleFold(peopleFilter.trim());
  const hiddenSet = S.hidden_people || {};
  const pool = source === 'all-including-hidden' ? Object.keys({...S.people, ...hiddenSet})
    : source === 'hidden' ? Object.keys(hiddenSet) : Object.keys(S.people);
  const out = [];
  for (const name of pool) {
    const c = S.people_photo_counts[name] || {total:0, album:0, familysearch:0}, d = distances?.[name];
    const fsOnly = c.familysearch > 0 && c.album === 0;
    const sourceMatch = source === 'all-including-hidden' || source === 'hidden' || source === 'all'
      || (source === 'hide-familysearch-only' && !fsOnly) || (source === 'album' && c.album > 0)
      || (source === 'familysearch-only' && fsOnly) || (source === 'none' && c.total === 0);
    if (!sourceMatch) continue;
    if (peopleFilters.hasPhotos && source !== 'none' && c.total === 0) continue;
    const distanceMatch = peopleFilters.distance === 'any' || (distances && (
      (peopleFilters.distance === 'known' && d !== undefined) || (peopleFilters.distance === 'unknown' && d === undefined)
      || (/^\d+$/.test(peopleFilters.distance) && d !== undefined && d <= Number(peopleFilters.distance))));
    if (!distanceMatch) continue;
    // Other names count too ("Ann M. Ward" finds Ann Marie Ward), as in the search palette.
    if (q && !peopleFold(name).includes(q) && !(window.Naming?.aliasesOf?.(name) || []).some(a => peopleFold(a).includes(q))) continue;
    out.push(name);
  }
  const count = n => (S.people_photo_counts[n] || {total:0}).total;
  out.sort((a,b) => {
    if (peopleFilters.sort === 'photos') return count(b) - count(a) || peopleCollator.compare(a,b);
    if (peopleFilters.sort === 'distance' && distances) return (distances[a] ?? Infinity) - (distances[b] ?? Infinity) || peopleCollator.compare(a,b);
    return peopleCollator.compare(a,b);
  });
  return {names: out, total: pool.length};
}
function personCard(n) {
  const c = S.people_photo_counts[n] || {total:0, album:0, familysearch:0};
  const avatar = S.reps[n] != null ? `<img loading="lazy" decoding="async" src="/thumbs/${S.reps[n]}.jpg?v=${S.v}" alt="">`
    : S.source_reps?.[n] ? `<img loading="lazy" decoding="async" src="${photoURL(S.source_reps[n])}&thumbnail=1" alt="">`
    : `<div class="noface" aria-hidden="true">${esc(n.split(/\s+/).map(w => w[0] || '').join('').slice(0,2))}</div>`;
  const t = document.createElement('template');
  t.innerHTML = `<article class="person" data-name="${esc(n)}">${avatar}
    <a class="nm" href="#/people/${encodeURIComponent(n)}" data-open="${esc(n)}">${esc(n)}</a>
    <div class="meta person-sources"><b>${c.total.toLocaleString()}</b> ${c.total === 1 ? 'photo' : 'photos'}${c.total && c.familysearch ? `<br>${c.album.toLocaleString()} in albums · ${c.familysearch.toLocaleString()} from FamilySearch` : ''}</div>
    <div class="person-distance"></div><button class="btn link" data-rename="${esc(n)}" aria-label="Rename ${esc(n)}">Rename</button></article>`;
  return t.content.firstElementChild;
}
function applyPeopleFilters(resetPage = false) {
  if (tab !== 'people' || person || !$('#filtered-people')) return;
  if (resetPage) peopleShown = PEOPLE_PAGE;
  if (peopleCards.S !== S) peopleCards = {S, map: new Map()};
  const distances = peopleDistances();
  const {names, total} = peopleMatches(distances);
  const shown = names.slice(0, peopleShown);
  const els = shown.map(n => {
    let el = peopleCards.map.get(n);
    if (!el) { el = personCard(n); peopleCards.map.set(n, el); }
    const d = distances?.[n];
    $('.person-distance', el).textContent = distances ? (d === undefined ? 'No known link' : d === 0 ? 'Selected person' : `${d} family ${d === 1 ? 'link' : 'links'} away`) : '';
    return el;
  });
  $('#filtered-people').replaceChildren(...els);
  if (peopleRestoreY != null) { const y = peopleRestoreY; peopleRestoreY = null; if (y) scrollTo(0, y); }
  const left = names.length - shown.length;
  $('#people-more-row').hidden = left <= 0;
  $('#people-more').textContent = `Show ${Math.min(PEOPLE_PAGE, left).toLocaleString()} more`;
  $('#people-more-note').textContent = `Showing ${shown.length.toLocaleString()} of ${names.length.toLocaleString()}`;
  $('#people-filter-count').textContent = peopleRelationsBusy ? 'Loading family connections…' : `${names.length.toLocaleString()} of ${total.toLocaleString()} people`;
  $('#people-filter-empty').hidden = names.length > 0 || peopleRelationsBusy || Boolean(peopleRelationsError);
  $('#people-filter-error').hidden = !peopleRelationsError;
  $('#people-filter-error').textContent = peopleRelationsError;
  watchPeopleMore();
}
// Load the next page a little before the reader reaches the end of the list.
function watchPeopleMore() {
  if (!('IntersectionObserver' in window)) return;
  peopleMoreObserver?.disconnect();
  const row = $('#people-more-row');
  if (!row || row.hidden) return;
  peopleMoreObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting) && tab === 'people' && !person) { peopleShown += PEOPLE_PAGE; applyPeopleFilters(); }
  }, {rootMargin: '600px 0px'});
  peopleMoreObserver.observe(row);
}
async function initPeopleFilters() {
  const request = ++peopleRelationsRequest;
  peopleRelationsError = '';
  const cached = peopleRelations && peopleRelations.root === peopleFilters.root && peopleRelations.partners === peopleFilters.partners;
  peopleRelationsBusy = Boolean(peopleFilters.root) && !cached;
  if (!cached) peopleRelations = null;
  applyPeopleFilters();
  if (!peopleFilters.root) {
    if (peopleFilters.distance !== 'any' || peopleFilters.sort === 'distance') peopleRelationsError = 'Choose a person from the family tree.';
    applyPeopleFilters(); return;
  }
  const root = peopleFilters.root, partners = peopleFilters.partners;
  try {
    const response = await fetch(`/api/people-relations?${new URLSearchParams({root,partners:String(partners)})}`), data = await response.json();
    if (request !== peopleRelationsRequest) return;
    if (!response.ok || data.error) throw new Error(data.error || 'Could not load family connections. Open People again to try again.');
    peopleRelations = data;
  } catch(error) {
    if (request === peopleRelationsRequest) peopleRelationsError = error.message;
  } finally {
    if (request === peopleRelationsRequest) { peopleRelationsBusy = false; applyPeopleFilters(); }
  }
}
document.addEventListener('input', e => {
  if (e.target.id === 'people-search') { peopleFilter = e.target.value; applyPeopleFilters(true); }
  if (e.target.id === 'people-root') {
    const value = e.target.value.trim();
    const root = S.people_tree_names.find(n => n.toLocaleLowerCase() === value.toLocaleLowerCase());
    if (root && root !== peopleFilters.root) {
      peopleFilters.root = root; savePeopleFilters(); peopleShown = PEOPLE_PAGE; initPeopleFilters();
    }
  }
});
document.addEventListener('change', e => {
  const keys = {'people-source':'source','people-distance':'distance','people-list-sort':'sort'};
  if (keys[e.target.id]) {
    peopleFilters[keys[e.target.id]] = e.target.value; savePeopleFilters();
    if ($('#people-has-photos')) $('#people-has-photos').disabled = peopleFilters.source === 'none';
    peopleShown = PEOPLE_PAGE;
    if (!peopleFilters.root && (peopleFilters.distance !== 'any' || peopleFilters.sort === 'distance')) return initPeopleFilters();
    return applyPeopleFilters();
  }
  if (e.target.id === 'people-has-photos') { peopleFilters.hasPhotos = e.target.checked; savePeopleFilters(); return applyPeopleFilters(true); }
  if (e.target.id === 'people-root') {
    const value = e.target.value.trim(), root = S.people_tree_names.find(n => n.toLocaleLowerCase() === value.toLocaleLowerCase());
    if (!root) {
      peopleFilters.root = ''; peopleRelations = null; peopleRelationsError = 'Choose a person from the family tree.'; applyPeopleFilters(); return;
    }
    e.target.value = root;
    if (peopleFilters.root === root && !peopleRelationsError) return;
    peopleFilters.root = root; savePeopleFilters(); peopleShown = PEOPLE_PAGE; return initPeopleFilters();
  }
  if (e.target.id === 'people-connections') { peopleFilters.partners = e.target.value === 'true'; savePeopleFilters(); peopleShown = PEOPLE_PAGE; return initPeopleFilters(); }
});
document.addEventListener('click', e => {
  if (e.target.closest('#people-more')) { peopleShown += PEOPLE_PAGE; return applyPeopleFilters(); }
  if (!e.target.closest('#people-clear-filters')) return;
  peopleFilter = ''; peopleFilters = {...PEOPLE_FILTER_DEFAULTS, source:'all', root:S.people_default_root || ''};
  peopleShown = PEOPLE_PAGE; savePeopleFilters(); render();
});
// Person cards are real links (open in a new tab works); a plain click opens the person in place.
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-open]');
  if (!a) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) { e.stopPropagation(); return; }
  e.preventDefault();
}, true);
