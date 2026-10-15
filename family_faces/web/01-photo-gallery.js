// Gallery: browse full photos by the people linked to them.
// Filters and page live in the address bar (#/gallery?people=A|B&mode=and&source=album&page=2), so they
// survive a reload and work with back and forward.
const PHOTO_GALLERY_PAGE = 60;
let photoGallerySettings = { mode: 'and', source: 'all', people: [] };
let photoGalleryData = null, photoGalleryOffset = 0, photoGalleryRequest = 0, photoGalleryViewerIndex = 0;
let photoGalleryOpener = null, photoGalleryViewerBusy = false;
const photoGalleryUnknown = new Set();   // names checked and found to match no one
let photoGalleryAdded = '';
let photoGalleryTyped = '';              // a name typed in "Add a person" that matched no one
const photoGalleryDialog = document.querySelector('#photo-gallery-viewer');

function galleryPhotoTitle(photo) {
  return photo.caption || photo.path.split('/').pop();
}
function galleryPhotoDate(raw) {
  const m = String(raw || '').match(/^(\d{4})[:-](\d{2})[:-](\d{2})/);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31
    ? `${+m[3]} ${months[+m[2]-1]} ${m[1]}` : raw;
}

function photoGalleryParams() {
  const s = photoGallerySettings, params = {};
  if (s.people.length) params.people = s.people.join('|');
  if (s.mode !== 'and') params.mode = s.mode;   // AND is the default, so #/gallery?people=X is already complete
  if (s.source !== 'all') params.source = s.source;
  const page = Math.floor(photoGalleryOffset / PHOTO_GALLERY_PAGE) + 1;
  if (page > 1) params.page = String(page);
  return params;
}
function setPhotoGalleryRoute({ params = {} } = {}) {
  const people = String(params.people || '').split('|').map(n => n.trim()).filter(Boolean);
  photoGallerySettings = { mode: params.mode === 'or' ? 'or' : 'and',
    source: ['album', 'familysearch'].includes(params.source) ? params.source : 'all',
    people: [...new Set(people)].slice(0, 100) };
  photoGalleryOffset = (Math.max(1, Math.floor(Number(params.page)) || 1) - 1) * PHOTO_GALLERY_PAGE;
  photoGalleryTyped = '';
}
// Record a filter change in the address bar (a new history entry, so Back undoes it), then redraw.
function updatePhotoGallery(replace = false) {
  syncURL(replace);
  return renderPhotoGallery();
}
registerTab('gallery', { title: 'Gallery', group: 'Library', render: () => renderPhotoGallery(),
  getRoute: () => ({ sub: null, params: photoGalleryParams() }), setRoute: setPhotoGalleryRoute });

// ---------- names that match no one ----------
function photoGalleryPool() {
  const hidden = S.hidden_people || {}, pool = new Map();
  for (const [name, count] of Object.entries(S.people || {})) if (count > 0 && name !== '_ignore' && !(name in hidden)) pool.set(name, count);
  for (const [name, count] of Object.entries(photoGalleryData?.people || {})) if (count > 0) pool.set(name, Math.max(count, pool.get(name) || 0));
  return pool;
}
function galleryEditDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function galleryClosestNames(typed, pool, limit = 4) {
  const norm = x => x.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(typed), qWords = q.split(' ').filter(Boolean);
  if (!q) return [];
  const wordGap = (w, x) => x.startsWith(w) ? 0.1 * (1 - w.length / x.length) : galleryEditDistance(w, x) / Math.max(w.length, x.length);
  const scored = [];
  for (const [name, count] of pool) {
    const n = norm(name);
    let score;
    if (n.startsWith(q)) score = 0;
    else if (n.includes(q)) score = 0.05;
    else {
      const words = n.split(' ');
      const byWord = qWords.reduce((sum, w) => sum + Math.min(...words.map(x => wordGap(w, x))), 0) / qWords.length;
      score = Math.min(galleryEditDistance(q, n) / Math.max(q.length, n.length), byWord + 0.1);
    }
    scored.push([score, -count, name]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
  return scored.slice(0, limit).map(([, , name]) => name);
}
function photoGalleryMessages() {
  const pool = photoGalleryPool(), chosen = new Set(photoGallerySettings.people);
  const block = (name, fromLink) => {
    const options = galleryClosestNames(name, [...pool].filter(([n]) => !chosen.has(n)));
    return `<div class="gallery-nomatch">
      <p><b>No one is called “${esc(name)}”.</b> ${fromLink ? 'This name came from the link, so it isn’t filtering the photos.' : 'Pick one of the closest names, or check the spelling.'}</p>
      <div class="gallery-suggest">${options.length ? `<span class="meta">Closest names:</span>` : ''}
        ${options.map(n => `<button class="btn" data-gallery-swap="${esc(n)}" data-gallery-for="${fromLink ? esc(name) : ''}" aria-label="Use ${esc(n)}">${esc(n)} <small>${(pool.get(n) || 0).toLocaleString()}</small></button>`).join('')}
        ${fromLink ? `<button class="btn" data-gallery-remove="${esc(name)}">Remove “${esc(name)}”</button>` : ''}</div></div>`;
  };
  return photoGallerySettings.people.filter(n => photoGalleryUnknown.has(n)).map(n => block(n, true)).join('')
    + (photoGalleryTyped ? block(photoGalleryTyped, false) : '');
}
function showPhotoGalleryMessages() {
  const box = $('#gallery-messages');
  if (box) box.innerHTML = photoGalleryMessages();
}
// Names in the filter that no photo is linked to and no face is named: check them once against every source.
async function checkPhotoGalleryNames(data) {
  const unsure = photoGallerySettings.people.filter(n => !photoGalleryUnknown.has(n) && !(n in data.people) && !(n in (S.people || {})));
  if (!unsure.length) return false;
  const q = new URLSearchParams({ mode: 'or', source: 'all', offset: '0', limit: '1' });
  unsure.forEach(n => q.append('person', n));
  const check = await fetch(`/api/photo-gallery?${q}`).then(r => r.json()).catch(() => null);
  if (!check || check.error) return false;
  const missing = unsure.filter(n => !(n in check.people));
  missing.forEach(n => photoGalleryUnknown.add(n));
  return missing.length > 0;
}

// ---------- page ----------
function photoGalleryFocusState() {
  const active = document.activeElement;
  if (!active || !$('#main').contains(active)) return null;
  if (active.id) return {selector:`#${CSS.escape(active.id)}`, value:active.id === 'gallery-add-person' ? active.value : null};
  if (active.name === 'gallery-mode') return {selector:`input[name="gallery-mode"][value="${active.value}"]`};
  if (active.dataset.galleryRemove) return {selector:`[data-gallery-remove="${CSS.escape(active.dataset.galleryRemove)}"]`};
  if (active.dataset.galleryPage) return {selector:`[data-gallery-page="${active.dataset.galleryPage}"]`};
  if (active.dataset.gallerySwap) return {selector:'#gallery-add-person'};
  return null;
}
function restorePhotoGalleryFocus(state) {
  if (!state || photoGalleryDialog.open) return;
  let control = $('#main').querySelector(state.selector);
  if (!control || control.disabled) control = $('#gallery-add-person') || $('#gallery-retry');
  if (state.value !== null && state.value !== undefined && control?.id === 'gallery-add-person') control.value = state.value;
  control?.focus({preventScroll:true});
}
async function renderPhotoGallery() {
  $('#page-title').textContent = TITLES.gallery || 'Gallery';
  const request = ++photoGalleryRequest, s = photoGallerySettings;
  const people = s.people.filter(n => !photoGalleryUnknown.has(n));
  const query = new URLSearchParams({ mode: s.mode, source: s.source, offset: String(photoGalleryOffset), limit: String(PHOTO_GALLERY_PAGE) });
  for (const name of people) query.append('person', name);
  $('#main').setAttribute('aria-busy', 'true');
  if (!photoGalleryData || !$('.photo-gallery-controls')) $('#main').innerHTML = '<p class="help" role="status">Loading photos…</p>';
  try {
    const response = await fetch(`/api/photo-gallery?${query}`), data = await response.json();
    if (request !== photoGalleryRequest || tab !== 'gallery') return;
    if (!response.ok || data.error) throw new Error(data.error || 'Could not load the photos.');
    photoGalleryData = data;
    if (await checkPhotoGalleryNames(data)) return request === photoGalleryRequest && renderPhotoGallery();   // ask again without them
    if (request !== photoGalleryRequest || tab !== 'gallery') return;
    if (data.total && data.offset >= data.total) {   // a page past the end (old link, or fewer photos now)
      photoGalleryOffset = Math.floor((data.total - 1) / PHOTO_GALLERY_PAGE) * PHOTO_GALLERY_PAGE;
      return updatePhotoGallery(true);
    }
    const focus = photoGalleryFocusState();
    const filtering = people.length, mode = data.mode === 'and' ? 'all' : 'any';
    $('#main').innerHTML = `<div class="photo-gallery-controls">
      <p class="help">Find photos by the people linked to them. Open a photo to see it in full.</p>
      <div class="photo-gallery-filters"><label>Add a person<input class="name" id="gallery-add-person" list="gallery-person-options" placeholder="Find a person…" autocomplete="off" value="${esc(photoGalleryTyped)}"></label>
        <button class="btn" id="gallery-add">Add person</button>
        <label>Photo source<select id="gallery-source"><option value="all" ${data.source === 'all' ? 'selected' : ''}>All photos</option><option value="album" ${data.source === 'album' ? 'selected' : ''}>Album photos</option><option value="familysearch" ${data.source === 'familysearch' ? 'selected' : ''}>FamilySearch photos</option></select></label>
        <button class="btn" id="gallery-clear" ${s.people.length || data.source !== 'all' || data.mode !== 'and' ? '' : 'disabled'}>Clear filters</button></div>
      <datalist id="gallery-person-options">${Object.entries(data.people).map(([name,count]) => `<option value="${esc(name)}">${plural(count, 'photo')}</option>`).join('')}</datalist>
      <div id="gallery-messages" role="status" aria-live="polite">${photoGalleryMessages()}</div>
      <div class="photo-gallery-selected">${people.map(name => `<button class="btn" data-gallery-remove="${esc(name)}" aria-label="Remove ${esc(name)} from the filter">${esc(name)} <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 4 8 8m0-8-8 8"/></svg></button>`).join('')}</div>
      <fieldset class="photo-gallery-mode"><legend>When more than one person is selected</legend>
        <label><input type="radio" name="gallery-mode" value="and" ${data.mode === 'and' ? 'checked' : ''}>Photos with all of them</label>
        <label><input type="radio" name="gallery-mode" value="or" ${data.mode === 'or' ? 'checked' : ''}>Photos with any of them</label></fieldset>
      <p class="meta" id="gallery-result-count" role="status" aria-live="polite">${photoGalleryAdded ? `Added ${esc(photoGalleryAdded)}. ` : ""}${plural(data.total, 'photo')}${filtering ? (filtering > 1 ? ` with ${mode} of the selected people` : ` with ${esc(people[0])}`) : ' in this view'}</p>
    </div>
    ${data.photos.length ? `<div class="photo-gallery-grid">${data.photos.map((p,i) => `<figure>
      <button class="photo-gallery-open" data-gallery-open="${i}" aria-label="Open ${esc(galleryPhotoTitle(p))}"><img loading="lazy" decoding="async" src="/gallery-image/${encodeURIComponent(p.path)}?v=${S.v}" alt="${esc(galleryPhotoTitle(p))}">${p.source === 'FamilySearch' ? '<span class="photo-gallery-source">FamilySearch</span>' : ''}</button>
      <figcaption><span class="gallery-photo-title">${esc(galleryPhotoTitle(p))}</span>${p.date ? `<span class="meta">${esc(galleryPhotoDate(p.date))}</span>` : ''}<span class="meta">${p.people.length ? `${p.people.slice(0,5).map(esc).join(', ')}${p.people.length > 5 ? ` · ${(p.people.length-5).toLocaleString()} more` : ''}` : 'No named people linked'}</span></figcaption>
    </figure>`).join('')}</div>` : '<div class="empty">No photos match these filters. Choose “Photos with any of them”, remove a person, or change the photo source.</div>'}
    <div class="photo-gallery-pager"><button class="btn" data-gallery-page="-1" ${data.offset === 0 ? 'disabled' : ''}>Previous page</button>
      <span class="meta">${data.total ? `${(data.offset+1).toLocaleString()}–${Math.min(data.offset+data.photos.length,data.total).toLocaleString()} of ${data.total.toLocaleString()}` : 'No photos'}</span>
      <button class="btn" data-gallery-page="1" ${data.offset+data.photos.length >= data.total ? 'disabled' : ''}>Next page</button></div>`;
    restorePhotoGalleryFocus(focus);
    photoGalleryAdded = '';
  } catch (error) {
    if (request === photoGalleryRequest && tab === 'gallery') {
      const focus = photoGalleryFocusState();
      $('#main').innerHTML = `<div class="empty"><p>${esc(error.message)}</p><button class="btn" id="gallery-retry">Try again</button></div>`;
      restorePhotoGalleryFocus(focus);
    }
  } finally { if (request === photoGalleryRequest) $('#main').removeAttribute('aria-busy'); }
}
function addPhotoGalleryName(name) {
  if (!photoGallerySettings.people.includes(name)) photoGallerySettings.people.push(name);
  photoGalleryTyped = '';
  photoGalleryAdded = name;
  const input = $('#gallery-add-person');
  if (input) { input.value = ''; input.focus({preventScroll:true}); }
  photoGalleryOffset = 0;
  return updatePhotoGallery();
}
function addPhotoGalleryPerson() {
  const input = $('#gallery-add-person'), value = input.value.trim();
  if (!value) return input.focus();
  const lower = value.toLocaleLowerCase();
  const name = [...photoGalleryPool().keys()].find(n => n.toLocaleLowerCase() === lower);
  if (name) return addPhotoGalleryName(name);
  photoGalleryTyped = value;
  showPhotoGalleryMessages();
}
function openPhotoGalleryImage(index, opener = null) {
  photoGalleryViewerIndex = index;
  if (opener) photoGalleryOpener = opener;
  const photo = photoGalleryData.photos[index];
  if (!photo) return;
  $('#gallery-viewer-title').textContent = galleryPhotoTitle(photo);
  $('#gallery-viewer-image').src = photoURL(photo.path);
  $('#gallery-viewer-image').alt = galleryPhotoTitle(photo);
  $('#gallery-viewer-people').textContent = photo.people.length ? photo.people.join(', ') : 'No named people linked';
  $('#gallery-viewer-source').textContent = [photo.source, galleryPhotoDate(photo.date), photo.path].filter(Boolean).join(' · ');
  $('#gallery-viewer-position').textContent = `${(photoGalleryData.offset+index+1).toLocaleString()} of ${photoGalleryData.total.toLocaleString()}`;
  $('#gallery-viewer-prev').disabled = photoGalleryData.offset+index === 0;
  $('#gallery-viewer-next').disabled = photoGalleryData.offset+index+1 >= photoGalleryData.total;
  if (!photoGalleryDialog.open) photoGalleryDialog.showModal();
}
async function stepPhotoGalleryImage(step) {
  if (photoGalleryViewerBusy) return;
  const position = photoGalleryData.offset+photoGalleryViewerIndex+step;
  if (position < 0 || position >= photoGalleryData.total) return;
  const index = photoGalleryViewerIndex+step;
  if (index >= 0 && index < photoGalleryData.photos.length) return openPhotoGalleryImage(index);
  photoGalleryViewerBusy = true;
  $('#gallery-viewer-prev').disabled = $('#gallery-viewer-next').disabled = true;
  $('#gallery-viewer-position').textContent = 'Loading photos…';
  try {
    photoGalleryOffset = Math.floor(position/PHOTO_GALLERY_PAGE)*PHOTO_GALLERY_PAGE;
    await updatePhotoGallery(true);
    if (photoGalleryData.offset === photoGalleryOffset && photoGalleryDialog.open) openPhotoGalleryImage(position-photoGalleryOffset);
    else $('#gallery-viewer-position').textContent = 'Could not load the next photo. Close this view and try again.';
  } finally { photoGalleryViewerBusy = false; }
}
document.addEventListener('click', e => {
  if (tab !== 'gallery') return;
  const add = e.target.closest('#gallery-add'); if (add) return addPhotoGalleryPerson();
  const swap = e.target.closest('[data-gallery-swap]');
  if (swap) {
    const name = swap.dataset.gallerySwap, wrong = swap.dataset.galleryFor;
    if (!wrong) return addPhotoGalleryName(name);
    const people = photoGallerySettings.people;
    photoGallerySettings.people = people.includes(name) ? people.filter(n => n !== wrong) : people.map(n => n === wrong ? name : n);
    photoGalleryOffset = 0; return updatePhotoGallery();
  }
  const remove = e.target.closest('[data-gallery-remove]');
  if (remove) {
    photoGallerySettings.people = photoGallerySettings.people.filter(n => n !== remove.dataset.galleryRemove);
    photoGalleryOffset = 0; return updatePhotoGallery();
  }
  if (e.target.closest('#gallery-clear')) {
    photoGallerySettings = { mode: 'and', source: 'all', people: [] }; photoGalleryTyped = '';
    photoGalleryOffset = 0; return updatePhotoGallery();
  }
  if (e.target.closest('#gallery-retry')) return renderPhotoGallery();
  const page = e.target.closest('[data-gallery-page]');
  if (page) { photoGalleryOffset = Math.max(0,photoGalleryOffset+Number(page.dataset.galleryPage)*PHOTO_GALLERY_PAGE); scrollTo(0,0); return updatePhotoGallery(); }
  const photo = e.target.closest('[data-gallery-open]'); if (photo) return openPhotoGalleryImage(Number(photo.dataset.galleryOpen), photo);
});
document.addEventListener('change', e => {
  if (e.target.name === 'gallery-mode') photoGallerySettings.mode = e.target.value;
  else if (e.target.id === 'gallery-source') photoGallerySettings.source = e.target.value;
  else return;
  photoGalleryOffset = 0; updatePhotoGallery();
});
document.addEventListener('input', e => {
  if (e.target.id !== 'gallery-add-person' || !photoGalleryTyped) return;
  photoGalleryTyped = ''; showPhotoGalleryMessages();   // the message was about the old text
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'gallery-add-person' && e.key === 'Enter') { e.preventDefault(); return addPhotoGalleryPerson(); }
  if (!photoGalleryDialog.open) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stepPhotoGalleryImage(e.key === 'ArrowRight' ? 1 : -1); }
});
$('#gallery-viewer-close').addEventListener('click', () => photoGalleryDialog.close());
$('#gallery-viewer-prev').addEventListener('click', () => stepPhotoGalleryImage(-1));
$('#gallery-viewer-next').addEventListener('click', () => stepPhotoGalleryImage(1));
photoGalleryDialog.addEventListener('close', () => { if (photoGalleryOpener?.isConnected) photoGalleryOpener.focus(); });
