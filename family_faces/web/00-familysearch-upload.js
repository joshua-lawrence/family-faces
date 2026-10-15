// Upload selected album photos through the FamilySearch MCP, one photo at a time.
{
  const dialog = document.querySelector('#fs-upload'), body = document.querySelector('#fs-upload-body');
  const status = document.querySelector('#fs-upload-status'), check = document.querySelector('#fs-upload-check');
  const send = document.querySelector('#fs-upload-send'), close = document.querySelector('#fs-upload-close');
  const stop = document.querySelector('#fs-upload-stop');
  const connect = document.querySelector('#fs-connection-connect'), connectionStatus = document.querySelector('#fs-connection-status');
  const cancelConnection = document.querySelector('#fs-connection-cancel');
  let connection = {status:'unknown', connected:false}, connectionTimer = null, connectionRequest = 0;
  let photos = [], drafts = new Map(), loadErrors = new Map(), queued = new Set(), currentPhoto = '', busy = false, uploading = false;
  let stopRequested = false, generation = 0, opener = null;
  const limit = 50;
  async function request(url, payload) {
    const response = await fetch(url, payload === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || 'Could not check this photo. Check the preview again.');
    return result;
  }
  function message(text, error = false) {
    status.textContent = text; status.classList.toggle('error', error);
  }
  function connectionView(result) {
    connection = result;
    connectionStatus.textContent = result.note;
    connectionStatus.classList.toggle('error', ['disconnected','error'].includes(result.status));
    connect.textContent = result.status === 'connecting' ? 'Connecting…' : result.connected ? 'Reconnect FamilySearch' : 'Connect FamilySearch';
    controls();
  }
  function pollConnection() {
    clearTimeout(connectionTimer);
    if (dialog.open && ['checking','connecting','cancelling'].includes(connection.status)) {
      connectionTimer = setTimeout(() => refreshConnection(), 1500);
    }
  }
  async function refreshConnection(check = false) {
    const current = ++connectionRequest;
    try {
      const result = await request(`/api/familysearch-connection${check ? '?check=1' : ''}`);
      if (current !== connectionRequest || !dialog.open) return;
      connectionView(result);
    } catch {
      if (current !== connectionRequest || !dialog.open) return;
      connectionView({status:'error', connected:false, note:'Could not check the connection. Click Connect FamilySearch to try again.'});
    }
    pollConnection();
  }
  const sessionError = error => /HTTP 401|Not authenticated|no FamilySearch access token/i.test(error.message);
  function memoryLink(result, label = 'Open in FamilySearch') {
    const url = result?.memoryUrl || result?.galleryUrl || result?.personMemoriesUrl;
    if (!url || !/^https:\/\/www\.familysearch\.org\/en\/(?:memories\/gallery|(?:memories\/memory|tree\/person\/memories)\/[A-Z0-9_-]+)$/i.test(url)) return '';
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  }
  function selectedPlans() { return [...queued].map(path => ({ path, draft: drafts.get(path) })); }
  function uploadStatus(record) {
    if (!record) return 'Not sent';
    if (record.result?.tagsApplied) return 'Already uploaded';
    if (record.result?.memoryId) return 'Photo uploaded · finish tags';
    return 'Upload recorded · check FamilySearch';
  }
  function controls() {
    dialog.setAttribute('aria-busy', String(busy));
    const completed = drafts.get(currentPhoto)?.completed;
    for (const control of body.querySelectorAll('input,textarea,button')) {
      control.disabled = busy || (completed && control.closest('.fs-upload-fields'));
    }
    close.disabled = busy;
    const connecting = ['checking','connecting','cancelling'].includes(connection.status);
    connect.disabled = busy || connecting;
    connect.setAttribute('aria-busy', String(connecting));
    cancelConnection.hidden = !['connecting','cancelling'].includes(connection.status);
    cancelConnection.disabled = busy || connection.status !== 'connecting';
    check.disabled = busy || !queued.size || !connection.connected;
    check.textContent = `Check ${queued.size || ''} ${queued.size === 1 ? 'photo' : 'photos'} and tags`;
    const plans = selectedPlans(), ready = plans.filter(p => p.draft?.token);
    send.disabled = busy || !connection.connected || !ready.length || plans.some(p => !p.draft?.token && !p.draft?.completed);
    const repairs = ready.filter(p => p.draft.preview.uploadAction === 'tag-memory').length;
    const uploads = ready.length-repairs;
    send.textContent = uploads && repairs ? `Upload ${plural(uploads, 'photo')} and finish ${plural(repairs, 'Memory', 'Memories')}` :
      repairs ? `Finish tags on ${repairs} ${repairs === 1 ? 'Memory' : 'Memories'}` :
      `Upload ${uploads || ''} ${uploads === 1 ? 'photo' : 'photos'} and tags`;
    stop.hidden = !uploading; stop.disabled = stopRequested;
  }
  function queueView() {
    const region = body.querySelector('#fs-upload-queue'); if (!region) return;
    const plans = selectedPlans();
    region.innerHTML = `<h3>Selected photos (${plans.length}/${limit})</h3>${plans.length ? `<ol class="fs-upload-review">${plans.map(({path,draft:d}) => {
      const people = d?.preview?.people || [];
      const state = loadErrors.get(path) || d?.error || (d?.sending ? 'Sending…' : d?.result?.tagsApplied ? 'Tags confirmed' : d?.completed ? 'Already sent — check its Memory' : d?.token ? d.preview.uploadAction === 'tag-memory' ? 'Ready to finish tags — photo already uploaded' : 'Ready to upload' : 'Needs a check');
      return `<li><button type="button" class="btn" data-fs-photo="${esc(path)}">Review photo ${photos.findIndex(p=>p.path===path)+1}</button><div><strong>${esc(d?.title || path)}</strong><p>${people.length ? people.map(p=>`${esc(p.personName)} (${esc(p.personId)})`).join(' · ') : d?.completed ? 'Photo already sent. Open its Memory to review the tags.' : 'Check this photo to confirm the selected people.'}</p><p class="${d?.error ? 'error' : 'help'}">${esc(state)} ${memoryLink(d?.result || (d?.preview?.uploadAction === 'tag-memory' ? d.preview : null) || d?.previous?.result)}</p></div></li>`;
    }).join('')}</ol>` : '<p class="help">Select the photos you want to send. You can send up to 50 at a time.</p>'}`;
    controls();
  }
  async function loadDraft(path) {
    if (drafts.has(path)) return drafts.get(path);
    const info = await request(`/api/photo/${encodeURIComponent(path)}`);
    info.faces = info.faces.filter(f=>f.name && f.name !== '_ignore').sort((a,b)=>a.bbox[0]-b.bbox[0]);
    const draft = { info, title: (info.caption || path.split('/').pop().replace(/\.[^.]+$/, '')).slice(0,250), description: '',
      faces: info.faces.filter(f=>f.familysearch_id).map(f=>({faceId:f.id,personId:f.familysearch_id})), token:null };
    const previous = photos.find(photo=>photo.path===path)?.upload_record;
    if (previous && (previous.result?.tagsApplied || !previous.result?.memoryId)) {
      draft.completed = true; draft.previous = previous; draft.result = previous.result;
    }
    drafts.set(path,draft); loadErrors.delete(path); return draft;
  }
  function saveDraft() {
    const d = drafts.get(currentPhoto); if (!d || !body.querySelector('#fs-photo-title')) return;
    d.title = body.querySelector('#fs-photo-title').value.trim();
    d.description = body.querySelector('#fs-photo-description').value.trim();
    d.faces = [...body.querySelectorAll('[data-fs-face]:checked')].map(c=>({faceId:Number(c.dataset.fsFace),
      personId:body.querySelector(`[data-fs-id="${c.dataset.fsFace}"]`).value.trim().toUpperCase()}));
    d.ids = Object.fromEntries([...body.querySelectorAll('[data-fs-id]')].map(c=>[c.dataset.fsId,c.value]));
  }
  function drawBoxes() {
    const d = drafts.get(currentPhoto), stage = body.querySelector('.fs-upload-stage'), image = stage?.querySelector('img');
    if (!d || !image?.naturalWidth) return;
    for (const old of stage.querySelectorAll('.fs-upload-box')) old.remove();
    const active = new Set(d.faces.map(s=>s.faceId));
    for (const [index,face] of d.info.faces.entries()) {
      if (!active.has(face.id)) continue;
      const scale = image.naturalWidth/(face.img_w || image.naturalWidth);
      const [x1,y1,x2,y2] = face.bbox.map(n=>n*scale);
      const box=document.createElement('div'); box.className='fs-upload-box';
      Object.assign(box.style,{left:`${x1/image.naturalWidth*100}%`,top:`${y1/image.naturalHeight*100}%`,
        width:`${(x2-x1)/image.naturalWidth*100}%`,height:`${(y2-y1)/image.naturalHeight*100}%`});
      const label=document.createElement('span');label.textContent=String(index+1);box.append(label);stage.append(box);
    }
  }
  function renderPhoto(path) {
    const d=drafts.get(path), selected=new Set(d.faces.map(s=>s.faceId));
    body.innerHTML=`<p class="help">Select up to 50 album photos. Review the face boxes and names, then check the selected photos.</p><p class="help">Duplicate uploads are blocked by saved file and image checks, across people and app restarts. An unknown result blocks another upload. Open its Memory before you continue.</p>
      <div class="fs-upload-photos" aria-label="Album photos">${photos.map((p,i)=>`<div class="fs-upload-choice"><button type="button" data-fs-photo="${esc(p.path)}" aria-pressed="${p.path===path}" aria-label="Review photo ${i+1}: ${esc(p.caption || p.path)}"><img loading="lazy" src="${photoURL(p.path)}" alt=""></button><label><input type="checkbox" data-fs-include="${esc(p.path)}" ${queued.has(p.path)?'checked':''} aria-label="Include photo ${i+1}">Photo ${i+1}</label><span class="meta">${esc(uploadStatus(p.upload_record))}</span>${memoryLink(p.upload_record?.result, 'Open Memory')}</div>`).join('')}</div>
      <div class="fs-upload-columns"><div><div class="fs-upload-stage"><img src="${photoURL(path)}" alt="${esc(d.info.caption || 'Selected album photo')}"></div><p class="meta">${esc(path)}</p></div>
      <div class="fs-upload-fields"><label>Photo title<input class="name" id="fs-photo-title" maxlength="250" value="${esc(d.title)}" required></label>
        <label>Description (optional)<textarea id="fs-photo-description" maxlength="2000">${esc(d.description)}</textarea></label>
        <fieldset><legend>People to tag</legend><p class="help">Clear a checkbox to leave that face out. Enter a person ID if a name has no linked record.</p>
          ${d.info.faces.map((f,i)=>`<div class="fs-upload-tag"><img src="/thumbs/${f.id}.jpg?v=${S.v}" alt="Face ${i+1}"><div>
            <label><input type="checkbox" data-fs-face="${f.id}" ${selected.has(f.id)?'checked':''}>${i+1}. ${esc(f.name)}</label>
            <label class="fs-id-label">FamilySearch person ID<input class="name" data-fs-id="${f.id}" value="${esc(d.ids?.[f.id] ?? d.faces.find(s=>s.faceId===f.id)?.personId ?? f.familysearch_id ?? '')}" placeholder="ABCD-123" maxlength="8" autocapitalize="characters" spellcheck="false"></label>
            <div class="meta" data-fs-confirmed="${f.id}">${esc(d.preview?.people?.find(p=>p.personId===d.faces.find(s=>s.faceId===f.id)?.personId)?.personName || '')}</div></div></div>`).join('')}
          ${d.info.faces.length ? '' : '<p class="help">No named faces in this photo. Name its faces first.</p>'}</fieldset></div></div>
      <section id="fs-upload-queue" aria-label="Upload review"></section>`;
    body.querySelector('.fs-upload-stage img').addEventListener('load',drawBoxes);
    drawBoxes(); queueView();
  }
  function focusPhotoChoice() {
    if (!dialog.open) return;
    const choice = body.querySelector('.fs-upload-photos [data-fs-photo][aria-pressed=true]:not(:disabled)');
    (choice || document.querySelector('#fs-upload-title')).focus({ preventScroll: true });
    choice?.scrollIntoView({block:'nearest',inline:'center'});
  }
  async function choosePhoto(path) {
    if (busy) return;saveDraft();const current=++generation;busy=true;controls();
    message('Loading the photo and its named faces…');
    try {await loadDraft(path);if(current!==generation || !dialog.open)return;currentPhoto=path;renderPhoto(path);message('Review each selected photo, then check the photos and tags.');}
    catch(error){message(error.message,true);} finally{if(current===generation){busy=false;controls();focusPhotoChoice();}}
  }
  async function open(name, element) {
    if (busy) return;opener=element;photos=[];drafts=new Map();loadErrors=new Map();queued=new Set();currentPhoto='';++generation;
    body.innerHTML='<p class="help">Loading album photos…</p>';message('');dialog.showModal();busy=true;controls();focusPhotoChoice();
    connectionView({status:'checking', connected:false, note:'Checking the saved FamilySearch session…'});
    refreshConnection(true);
    try {photos=(await request(`/api/person-upload-photos?name=${encodeURIComponent(name)}`)).photos;busy=false;
      if(!photos.length){body.innerHTML='<p class="help">This person has no album photos to upload. FamilySearch photos already have Memories.</p>';controls();return;}
      const first = photos.find(p=>!p.upload_record) || photos[0];
      queued.add(first.path);await choosePhoto(first.path);
    }catch(error){message(error.message,true);busy=false;controls();}
  }
  check.addEventListener('click',async()=>{
    if(busy || check.disabled)return;saveDraft();busy=true;controls();let errors=0, needsConnection=false;
    try {
      for(const [index,path] of [...queued].entries()) {
        message(`Checking photo ${index+1} of ${queued.size} and its FamilySearch people…`);
        let d;
        try {
          d=await loadDraft(path);if(d.completed)continue;d.token=null;d.error=null;
          if(!d.faces.length)throw new Error('Select at least one named face to tag.');
          if(!d.title)throw new Error('Enter a photo title.');
          if(d.faces.some(f=>!/^[A-Z0-9]{4}-[A-Z0-9]{3}$/.test(f.personId)))throw new Error('Enter a person ID for each selected face, or clear its checkbox.');
          const result=await request('/api/familysearch-upload/preview',{photo:path,faces:d.faces,title:d.title,description:d.description});
          if(result.status==='existing'){d.completed=true;d.previous=result.previous;d.result=result.previous?.result;}
          else{d.preview=result;d.token=result.previewToken;d.result=null;}
        }catch(error){errors++;if(d)d.error=error.message;else loadErrors.set(path,error.message);
          if(sessionError(error)){needsConnection=true;connectionView({status:'disconnected', connected:false,
            note:'FamilySearch rejected the saved session. Click Connect FamilySearch, then check the selected photos again.'});}}
        queueView();
        if(needsConnection)break;
      }
      if(drafts.has(currentPhoto))renderPhoto(currentPhoto);
      message(needsConnection ? 'Connect FamilySearch, then check the selected photos again. Your selections are saved here.' :
        errors ? `${errors} ${errors===1?'photo could':'photos could'} not be checked. Review the errors below, then check again.` :
        'Review the confirmed names in Selected photos below, then send the photos and tags.',Boolean(errors));
    }finally{busy=false;controls();}
  });
  connect.addEventListener('click',async()=>{
    if(connect.disabled)return;
    saveDraft();
    for(const d of drafts.values()){d.token=null;d.preview=null;}
    clearTimeout(connectionTimer);const current=++connectionRequest;
    connectionView({status:'connecting', connected:false, note:'Checking your Chrome session…'});
    queueView();
    try {
      const result=await request('/api/familysearch-connection/connect',{});
      if(current !== connectionRequest || !dialog.open)return;
      connectionView(result);pollConnection();
    }catch {
      if(current !== connectionRequest || !dialog.open)return;
      connectionView({status:'error', connected:false, note:'Could not open sign-in. Click Connect FamilySearch to try again.'});
    }
  });
  cancelConnection.addEventListener('click',async()=>{
    if(cancelConnection.disabled)return;
    clearTimeout(connectionTimer);const current=++connectionRequest;
    connectionView({status:'cancelling', connected:false, note:'Stopping the sign-in step…'});
    try {
      const result=await request('/api/familysearch-connection/cancel',{});
      if(current !== connectionRequest || !dialog.open)return;
      connectionView(result);pollConnection();
    }catch {
      if(current !== connectionRequest || !dialog.open)return;
      refreshConnection();
    }
  });
  send.addEventListener('click',async()=>{
    if(busy || send.disabled)return;saveDraft();const plans=selectedPlans().filter(p=>p.draft?.token);
    busy=true;uploading=true;stopRequested=false;controls();let done=0,interrupted=false;
    try {
      for(const {path,draft:d} of plans) {
        d.sending=true;queueView();message(`Sending ${done+1} of ${plans.length}. Keep this page open…`);
        try {
          const result=await request('/api/familysearch-upload/confirm',{photo:path,previewToken:d.token});
          d.token=null;d.result=result.status==='existing'?result.previous?.result:result;
          d.completed=Boolean(d.result?.tagsApplied || result.status==='existing');
          if(!d.completed){d.error=result.note || 'Check this Memory before you continue.';interrupted=true;}
          else{d.error=null;done++;}
        }catch(error){d.token=null;d.error=error.message;interrupted=true;}
        d.sending=false;queueView();if(interrupted || stopRequested)break;
      }
      message(interrupted ? `Stopped after ${done} confirmed ${done===1?'photo':'photos'}. Check the Memory shown below. No automatic retry was sent.` :
        stopRequested ? `Stopped after ${done} confirmed ${done===1?'photo':'photos'}. The remaining photos have not been sent.` :
        `${done} ${done===1?'photo has':'photos have'} confirmed tags. Open each Memory from Selected photos below.`,interrupted);
    }finally{busy=false;uploading=false;queueView();controls();}
  });
  body.addEventListener('click',e=>{const choice=e.target.closest('[data-fs-photo]');if(choice)choosePhoto(choice.dataset.fsPhoto);});
  body.addEventListener('change',e=>{
    if(busy)return;const include=e.target.closest('[data-fs-include]');
    if(include){if(include.checked && queued.size>=limit){include.checked=false;message(`Select no more than ${limit} photos.`,true);return;}
      include.checked?queued.add(include.dataset.fsInclude):queued.delete(include.dataset.fsInclude);queueView();return;}
    saveDraft();const d=drafts.get(currentPhoto);d.token=null;d.preview=null;d.error=null;queueView();drawBoxes();
  });
  body.addEventListener('input',e=>{if(busy || !e.target.closest('.fs-upload-fields'))return;saveDraft();const d=drafts.get(currentPhoto);d.token=null;d.preview=null;queueView();drawBoxes();});
  stop.addEventListener('click',()=>{stopRequested=true;stop.disabled=true;message('The queue will stop after the current photo.');});
  close.addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
  dialog.addEventListener('close',()=>{++generation;++connectionRequest;clearTimeout(connectionTimer);opener?.focus();});
  document.addEventListener('click',e=>{const action=e.target.closest('[data-fs-upload-person]');if(action)open(action.dataset.fsUploadPerson,action);});
}
