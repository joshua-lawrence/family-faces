(() => {
  const defaults = {start:0, span:10, reference:'all', refMin:0, refMax:120, source:'album',
    branch:'maternal', quality:'clear', minimumFaces:1, minimumScore:0, candidate:'', includeHidden:false};
  let settings = {...defaults}, selectedName = '', root, data, controller, timer, requestId = 0, loading = false, contextKey = '';
  try {
    const saved = JSON.parse(localStorage.getItem('face-similarity-filters') || '{}');
    for (const key of Object.keys(defaults)) if (typeof saved[key] === typeof defaults[key]) settings[key] = saved[key];
    selectedName = typeof saved.name === 'string' ? saved.name : '';
  } catch {}
  const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
  function normalize() {
    settings.span = clamp(Math.round(settings.span),1,121);
    settings.start = clamp(Math.round(settings.start),0,121-settings.span);
    settings.refMin = clamp(Math.round(settings.refMin),0,120);
    settings.refMax = clamp(Math.round(settings.refMax),settings.refMin,120);
    settings.minimumFaces = clamp(Math.round(settings.minimumFaces),1,100);
    settings.minimumScore = clamp(Math.round(settings.minimumScore),0,100);
    for (const [key, choices] of Object.entries({reference:['same','all','custom'], source:['album','familysearch','all'],
      branch:['maternal','paternal','all','none'],quality:['clear','all']})) if (!choices.includes(settings[key])) settings[key] = defaults[key];
  }
  normalize();
  const end = () => settings.start + settings.span - 1;
  const q = selector => root?.querySelector(selector);
  const options = (rows, value) => rows.map(([key,label]) => `<option value="${key}" ${String(key) === String(value) ? 'selected' : ''}>${label}</option>`).join('');
  const persist = () => {try {localStorage.setItem('face-similarity-filters',JSON.stringify({...settings,name:selectedName}));} catch {}};
  const ageLabel = (low, high) => low === 0 && high === 120 ? 'All known ages' : `Ages ${low}–${high}`;
  function section(name, full = false) {
    const nextContext = full ? 'full' : `${tab}|${name}`;
    const sameContext = nextContext === contextKey;
    const wasOpen = sameContext && root?.isConnected && root.tagName === 'DETAILS' && root.open;
    const filtersOpen = sameContext && q('.fsim-filters')?.open;
    if (name && (!sameContext || full)) selectedName = name;
    contextKey = nextContext;
    clearTimeout(timer); controller?.abort(); ++requestId; data = null; loading = false;
    const head = full ? '' : `<summary>Face similarity <span class="meta">Adjust the ages used for comparison</span></summary>`;
    const html = `<${full ? 'section' : 'details'} class="fsim" id="face-similarity-tool" aria-label="Face similarity" ${wasOpen ? 'open' : ''}>${head}
      <div class="fsim-body">
        ${full ? '<p class="help">Compare saved, named faces across an age window. Move the window to compare another stage of life.</p>' : ''}
        <div class="fsim-pickers">
          <label>Reference person<input class="name" id="fsim-name" list="people-list" value="${esc(selectedName)}" placeholder="Choose a person" autocomplete="off"></label>
          <label>Compare with<input class="name" id="fsim-candidate" list="people-list" value="${esc(settings.candidate)}" placeholder="Everyone else" autocomplete="off"><span class="meta">Leave empty for everyone else.</span></label>
        </div>
        <div class="fsim-comparison-controls"><fieldset class="fsim-window"><legend>Comparison age window</legend>
          <div class="fsim-window-head"><output id="fsim-window-label" for="fsim-start fsim-span">${ageLabel(settings.start,end())}</output>
            <label>Window width<select id="fsim-span">${options([[1,'1 year'],[3,'3 years'],[5,'5 years'],[10,'10 years'],[20,'20 years'],[40,'40 years'],[121,'All ages']],settings.span)}</select></label></div>
          <label class="fsim-slider-label" for="fsim-start">Move the age window</label>
          <input type="range" id="fsim-start" min="0" max="${121-settings.span}" step="1" value="${settings.start}" aria-describedby="fsim-window-label fsim-age-help">
          <div class="fsim-window-steps"><button class="btn" type="button" data-fsim-shift="-1">Earlier ages</button><p class="meta" id="fsim-age-help">Ages are estimates. Faces without an age estimate are left out.</p><button class="btn" type="button" data-fsim-shift="1">Later ages</button></div>
        </fieldset>
        <div class="fsim-reference-controls"><label>Reference ages<select id="fsim-reference">${options([['all','All known ages'],['same','Same comparison window'],['custom','Custom range']],settings.reference)}</select></label>
          <div id="fsim-custom" class="fsim-custom" ${settings.reference === 'custom' ? '' : 'hidden'}><label>Reference from age<input type="number" id="fsim-refMin" min="0" max="120" value="${settings.refMin}"></label><label>Reference to age<input type="number" id="fsim-refMax" min="0" max="120" value="${settings.refMax}"></label></div>
          ${full ? '' : `<a class="btn" data-fsim-tool href="#/face-similarity/${encodeURIComponent(selectedName)}">Open full tool</a>`}
        </div></div>
        <details class="fsim-filters" ${filtersOpen ? 'open' : ''}><summary>Photo source and result filters</summary><div class="fsim-filter-fields">
          <label>Photo source<select id="fsim-source">${options([['album','Album photos'],['familysearch','FamilySearch photos'],['all','All photos']],settings.source)}</select></label>
          <label>FamilySearch branch<select id="fsim-branch">${options([['maternal','Mom’s side'],['paternal','Dad’s side'],['all','All branches'],['none','Off']],settings.branch)}</select></label>
          <label>Face quality<select id="fsim-quality">${options([['clear','Clear, front-on faces'],['all','All faces with known ages']],settings.quality)}</select></label>
          <label>Minimum faces per result<input type="number" id="fsim-minimumFaces" min="1" max="100" value="${settings.minimumFaces}"></label>
          <label>Minimum similarity (%)<input type="number" id="fsim-minimumScore" min="0" max="100" value="${settings.minimumScore}"></label>
          <label class="fsim-check"><input type="checkbox" id="fsim-includeHidden" ${settings.includeHidden ? 'checked' : ''}>Include hidden imports</label>
        </div><p class="meta">Photo source and quality apply to both sides. The branch limits FamilySearch faces.</p></details>
        <div class="fsim-result-head"><p class="help" id="fsim-status" role="status" aria-live="polite">Choose a reference person to compare.</p><button class="btn" type="button" data-fsim-reset>Reset filters</button></div>
        <p class="meta">Scores measure face similarity. They are not identity probabilities or proof of a family relationship. One face per photo is used, with up to 150 faces per person.</p>
        <div id="fsim-reference-faces"></div><div id="fsim-results"></div>
      </div></${full ? 'section' : 'details'}>`;
    queueMicrotask(activate);
    return html;
  }
  function activate() {
    root = document.getElementById('face-similarity-tool');
    if (!root) return;
    if (root.tagName === 'DETAILS') root.addEventListener('toggle', () => {if (root.open && !data) schedule(true);});
    syncControls();
    if (root.tagName !== 'DETAILS' || root.open) schedule(true);
  }
  function syncControls() {
    if (!root) return;
    q('#fsim-window-label').textContent = ageLabel(settings.start,end());
    const slider = q('#fsim-start');
    slider.max = String(121-settings.span); slider.value = settings.start;
    slider.disabled = settings.span === 121;
    slider.setAttribute('aria-valuetext',ageLabel(settings.start,end()));
    q('#fsim-custom').hidden = settings.reference !== 'custom';
    q('#fsim-refMin').value = settings.refMin; q('#fsim-refMax').value = settings.refMax;
    q('#fsim-branch').disabled = settings.source === 'album';
    for (const b of root.querySelectorAll('[data-fsim-shift]')) b.disabled = Number(b.dataset.fsimShift) < 0 ? settings.start === 0 : end() === 120;
    const link = q('[data-fsim-tool]'); if (link) link.href = `#/face-similarity/${encodeURIComponent(selectedName)}`;
  }
  function params(offset = 0) {
    const low = settings.reference === 'same' ? settings.start : settings.reference === 'custom' ? settings.refMin : 0;
    const high = settings.reference === 'same' ? end() : settings.reference === 'custom' ? settings.refMax : 120;
    return new URLSearchParams({name:selectedName,candidate:settings.candidate,age_min:settings.start,age_max:end(),
      reference_min:low,reference_max:high,source:settings.source,branch:settings.branch,quality:settings.quality,
      minimum_faces:settings.minimumFaces,minimum_score:settings.minimumScore,include_hidden:settings.includeHidden ? 1 : 0,offset,limit:12});
  }
  function canonical(value) {
    const names = Object.keys({...S.people,...(settings.includeHidden ? S.hidden_people : {})});
    return names.find(name => name.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
  }
  function schedule(immediate = false) {
    clearTimeout(timer); controller?.abort(); ++requestId; loading = false; data = null;
    q('#fsim-reference-faces').innerHTML = ''; q('#fsim-results').innerHTML = '';
    q('#fsim-results').setAttribute('aria-busy','false');
    if (!selectedName.trim()) {q('#fsim-status').textContent = 'Choose a reference person to compare.'; return;}
    const name = canonical(selectedName), candidate = settings.candidate.trim() ? canonical(settings.candidate) : '';
    if (!name || (settings.candidate.trim() && !candidate)) {q('#fsim-status').textContent = 'Choose a saved person from the name list, or clear Compare with.'; return;}
    selectedName = name; settings.candidate = candidate;
    q('#fsim-status').textContent = 'Comparing faces…';
    persist();
    timer = setTimeout(() => load(false), immediate ? 0 : 180);
    if (tab === 'face-similarity') syncURL(true);
  }
  function faceTiles(samples, name) {
    return samples.map(face => `<button type="button" class="fsim-face" data-fsim-photo="${face.id}" aria-label="Open photo of ${esc(name)}, estimated age ${face.age}, ${esc(face.source)}"><img loading="lazy" src="/thumbs/${face.id}.jpg?v=${S.v}" alt=""><span>Age ${face.age}</span><span>${esc(face.source)}</span></button>`).join('');
  }
  function paint() {
    const reference = data.reference;
    const referenceLabel = settings.reference === 'same' ? ageLabel(settings.start,end()) : settings.reference === 'custom' ? ageLabel(settings.refMin,settings.refMax) : 'All known ages';
    q('#fsim-reference-faces').innerHTML = `<section class="fsim-reference"><div><h3>${esc(reference.name)}</h3><p class="meta">Reference · ${referenceLabel} · ${plural(reference.faces,'face')} used${reference.missingAge ? ` · ${reference.missingAge} without age estimates` : ''}</p></div><div class="fsim-faces">${faceTiles(reference.samples,reference.name)}</div></section>`;
    if (!data.hasReference) {q('#fsim-status').textContent = 'No reference faces pass these filters. Try all known reference ages, another photo source, or all face qualities.'; q('#fsim-results').innerHTML = ''; return;}
    q('#fsim-status').textContent = data.total ? `${data.total} people compared · ${ageLabel(settings.start,end())} · Highest similarity first` : 'No people pass these filters. Move or widen the age window, lower the result filters, or clear Compare with.';
    q('#fsim-results').innerHTML = `<ol class="fsim-list">${data.items.map(row => `<li class="fsim-row"><div class="fsim-person"><a href="#/people/${encodeURIComponent(row.name)}" data-open="${esc(row.name)}">${esc(row.name)}</a><p class="meta">${plural(row.faces,'face')} used</p><a class="fsim-portrait-link" href="#/portraits/${encodeURIComponent(row.name)}" data-fsim-portrait="${esc(row.name)}">Portraits</a></div><div class="fsim-faces">${faceTiles(row.samples,row.name)}</div><div class="fsim-score"><b>${Math.round(Math.max(0,row.similarity)*100)}%</b><span>similarity</span></div></li>`).join('')}</ol>${data.items.length < data.total ? `<button class="btn" type="button" data-fsim-more>Show ${Math.min(12,data.total-data.items.length)} more</button><span class="meta fsim-count">${data.items.length} of ${data.total}</span>` : ''}`;
  }
  async function load(append) {
    const token = ++requestId, host = root;
    controller?.abort(); controller = new AbortController(); loading = true;
    q('#fsim-results').setAttribute('aria-busy','true');
    const more = q('[data-fsim-more]'); if (more) more.disabled = true;
    try {
      const response = await fetch(`/api/face-similarity?${params(append ? data.items.length : 0)}`,{signal:controller.signal});
      const next = await response.json();
      if (!response.ok || next.error) throw new Error(next.error || 'Could not compare faces. Try again.');
      if (token !== requestId || root !== host || !host.isConnected) return;
      data = append && data ? {...next,items:[...data.items,...next.items]} : next;
      paint();
    } catch (error) {
      if (error.name === 'AbortError' || token !== requestId || !host.isConnected) return;
      q('#fsim-status').textContent = error.message;
      q('#fsim-results').innerHTML = '<button class="btn" type="button" data-fsim-retry>Try again</button>';
    } finally {
      if (token === requestId && root === host && host.isConnected) {loading = false; q('#fsim-results').setAttribute('aria-busy','false');}
    }
  }
  function navigate(nextTab, name) {
    selected.clear(); stopGrow();
    tab = nextTab;
    if (nextTab === 'portraits') {ptPerson = name; ptRendered = null;}
    else selectedName = name || selectedName;
    document.querySelectorAll('nav button[data-tab]').forEach(button => button.classList.toggle('on',button.dataset.tab === tab));
    render(); scrollTo(0,0); window.focusMain?.();
  }
  function update(event) {
    if (!root?.contains(event.target) || !event.target.id.startsWith('fsim-')) return;
    const key = event.target.id.slice(5);
    if (event.type === 'input' && event.target.type !== 'range') return;
    if (key === 'name') selectedName = event.target.value;
    else if (key === 'candidate') settings.candidate = event.target.value;
    else if (key in settings) settings[key] = event.target.type === 'checkbox' ? event.target.checked : typeof defaults[key] === 'number' ? Number(event.target.value) : event.target.value;
    else return;
    normalize(); syncControls(); schedule();
  }
  document.addEventListener('input',update);
  document.addEventListener('change',update);
  document.addEventListener('keydown',event => {
    if (event.key === 'Enter' && ['fsim-name','fsim-candidate'].includes(event.target.id)) {event.preventDefault(); update(event);}
  });
  document.addEventListener('click',event => {
    const action = event.target.closest('[data-fsim-tool],[data-fsim-portrait],[data-fsim-photo],[data-fsim-shift],[data-fsim-reset],[data-fsim-retry],[data-fsim-more]');
    if (!action || action.disabled) return;
    if (action.hasAttribute('data-fsim-tool')) {event.preventDefault(); return navigate('face-similarity',q('#fsim-name')?.value || selectedName);}
    if (action.hasAttribute('data-fsim-portrait')) {event.preventDefault(); return navigate('portraits',action.dataset.fsimPortrait);}
    if (action.hasAttribute('data-fsim-photo')) return openPhoto(Number(action.dataset.fsimPhoto));
    if (action.hasAttribute('data-fsim-more')) {if (!loading) load(true); return;}
    if (action.hasAttribute('data-fsim-retry')) return schedule(true);
    if (action.hasAttribute('data-fsim-reset')) {settings = {...defaults}; persist(); const full = root.tagName !== 'DETAILS'; root.outerHTML = section(selectedName,full); if (!full) document.getElementById('face-similarity-tool').open = true; return;}
    settings.start += Number(action.dataset.fsimShift)*settings.span;
    normalize(); syncControls(); schedule(true);
  });
  window.faceSimilaritySection = section;
  registerTab('face-similarity',{title:'Face similarity',group:'Explore',
    icon:'<circle cx="8" cy="8" r="3"/><circle cx="17" cy="8" r="3"/><path d="M2 20v-2a6 6 0 0 1 10-4m10 6v-2a6 6 0 0 0-7-6M9 20h7m-2-2 2 2-2 2"/>',
    render(main) {document.getElementById('page-title').textContent = 'Face similarity'; main.innerHTML = section(selectedName,true);},
    getRoute() {return {sub:selectedName || null};},
    setRoute({sub}) {if (sub) selectedName = sub;}
  });
})();
