// People / Operate: review strongest unnamed faces before the existing album.
// Keep the current type, surfaces, photo crops, and explicit name/Undo actions.
const PM = {key: null, data: null, error: null, request: 0, busy: false};
let pmSource = 'album', pmMinimum = .4;
try { const saved = JSON.parse(localStorage.getItem('person-match-filters') || '{}');
  if (['album','familysearch','all'].includes(saved.source)) pmSource = saved.source;
  if ([.4,.5,.6,.75].includes(saved.minimum)) pmMinimum = saved.minimum;
} catch {}

function personMatchesSection() {
  if (!person || person.startsWith('_')) return '';
  const key = JSON.stringify([person, S.v, reviewRequest, reviewSettings.branch, pmSource, pmMinimum]);
  if (PM.key !== key) { PM.key = key; PM.data = null; PM.error = null; }
  queueMicrotask(() => pmLoad(key));
  return `<section class="pm-section" aria-labelledby="pm-title" id="person-matches">${pmHTML()}</section>`;
}
function pmHTML() {
  const opts = (rows, value) => rows.map(([v,label]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${label}</option>`).join('');
  const data = PM.data;
  const content = PM.error ? `<p class="empty" role="alert">${esc(PM.error)} <button class="btn" data-pm-retry>Try again</button></p>` :
    !data ? '<p class="help" role="status">Finding likely matches…</p>' :
    !data.hasReference ? `<p class="help">Name at least one face for ${esc(person)} to find likely matches.</p>` :
    !data.items.length ? '<p class="help">No unnamed faces match these filters. Try a lower score or another photo source.</p>' :
    `<div class="pm-list">${data.items.map(row => `<article class="pm-match" data-pm-card="${row.face}">
      <button type="button" class="pm-photo" data-pm-open="${row.face}" aria-label="Open the photo for this ${Math.round(row.sim*100)}% match"><img loading="lazy" src="/thumbs/${row.face}.jpg?v=${S.v}" alt="Face to review"></button>
      <div class="pm-facts"><strong>${Math.round(row.sim*100)}% match</strong><span class="meta">${esc(row.source)}</span></div>
      <p class="meta pm-caption">${esc(row.caption || row.photo.split('/').pop())}</p>
      <div class="pm-actions"><button class="btn" data-pm-add="${row.face}" aria-label="Name this face as ${esc(person)}">Add match</button><button class="btn quiet" data-pm-reject="${row.face}">Not this person</button></div>
    </article>`).join('')}</div>${data.total > data.items.length ? `<div class="people-more"><button class="btn" data-pm-more>Show ${Math.min(12,data.total-data.items.length)} more</button><span class="meta">${data.items.length} of ${data.total} matches</span></div>` : ''}`;
  return `<div class="pp-section-head"><h3 class="section-title" id="pm-title" tabindex="-1">Likely matches${data ? ` <span class="pp-count">${data.total}</span>` : ''}</h3></div>
    <p class="help">Unnamed faces from photos not already linked to ${esc(person)}. Highest scores first. Scores compare faces; they do not confirm identity. Open a photo before adding its match.</p>
    <div class="pm-filters"><label>Photo source<select id="pm-source">${opts([['album','Album photos'],['familysearch','FamilySearch photos'],['all','All photos']],pmSource)}</select></label>
    <label>Minimum match score<select id="pm-minimum">${opts([[.4,'40% or higher'],[.5,'50% or higher'],[.6,'60% or higher'],[.75,'75% or higher']],pmMinimum)}</select></label></div>
    ${pmSource !== 'album' ? `<p class="meta">FamilySearch matching: ${esc({maternal:'Mom’s side',paternal:'Dad’s side',all:'All branches',none:'Off'}[reviewSettings.branch])}. Change this in Groups or Leftover faces.</p>` : ''}
    <div id="pm-results" aria-live="polite">${content}</div>`;
}
function pmPaint() {
  const section = $('#person-matches'); if (!section) return;
  const focusId = section.contains(document.activeElement) ? document.activeElement.id : null;
  section.innerHTML = pmHTML();
  for (const button of section.querySelectorAll('button,select')) button.disabled = PM.busy;
  if (focusId) document.getElementById(focusId)?.focus({preventScroll:true});
}
async function pmLoad(key, force = false, append = false) {
  if (key !== PM.key || !$('#person-matches') || (!force && (PM.data || PM.error || PM.loading === key))) return;
  const req = ++PM.request, name = person; PM.loading = key;
  const query = new URLSearchParams({name, source:pmSource, minimum:pmMinimum, branch:reviewSettings.branch,limit:12,offset:append ? PM.data?.items.length || 0 : 0});
  try {const data = await ppJSON(`/api/people/likely?${query}`);
    if (req !== PM.request || key !== PM.key || tab !== 'people' || person !== name) return;
    PM.data = append && PM.data ? {...data,items:[...PM.data.items,...data.items]} : data; PM.error = null; pmPaint();
  } catch (error) {if (req === PM.request && key === PM.key) { PM.error = error.message; pmPaint(); }}
  finally {if (req === PM.request) PM.loading = null;}
}
document.addEventListener('change', e => {
  if (!['pm-source','pm-minimum'].includes(e.target.id) || PM.busy) return;
  const focus = e.target.id;
  pmSource = $('#pm-source').value; pmMinimum = Number($('#pm-minimum').value);
  try {localStorage.setItem('person-match-filters', JSON.stringify({source:pmSource,minimum:pmMinimum}));} catch {}
  PM.key = null; $('#person-matches').outerHTML = personMatchesSection(); $(`#${focus}`).focus();
});
document.addEventListener('click', async e => {
  const action = e.target.closest('[data-pm-open],[data-pm-add],[data-pm-reject],[data-pm-more],[data-pm-retry]');
  if (!action || PM.busy) return;
  if (action.dataset.pmOpen !== undefined) return openPhoto(Number(action.dataset.pmOpen));
  if (action.hasAttribute('data-pm-more')) {await pmLoad(PM.key,true,true); $('#pm-title')?.focus(); return;}
  if (action.hasAttribute('data-pm-retry')) {PM.error = null; await pmLoad(PM.key,true); $('#pm-title')?.focus(); return;}
  const name = person, id = Number(action.dataset.pmAdd ?? action.dataset.pmReject), add = action.dataset.pmAdd !== undefined;
  PM.busy = true; for (const control of $('#person-matches').querySelectorAll('button,select')) control.disabled = true;
  try {
    const result = await ppWrite(add ? '/api/people/likely/accept' : '/api/suggest/reject',
      {name, faces:[id], source:pmSource, minimum:pmMinimum, branch:reviewSettings.branch});
    ppDone(add ? `Added the match to ${name}.` : `Marked as not ${name}.`,result.history,()=>{PM.key=null;});
    PM.key = null; await load();
    if (tab === 'people' && person === name) $('#pm-title')?.focus();
  } catch (error) {toast(error.message,true);}
  finally {PM.busy = false; if ($('#person-matches')) for (const control of $('#person-matches').querySelectorAll('button,select')) control.disabled = false;}
});
