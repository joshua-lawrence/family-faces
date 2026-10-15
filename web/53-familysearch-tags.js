(() => {
  let host, path, info, preview, busy = false, sending = false, generation = 0, timer;
  const q = selector => host?.querySelector(selector);
  const api = '/api/familysearch-memory-tags';
  let connection = {status:'unknown', connected:false};
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : {method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Could not check the tags. Try the check again.');
    return data;
  }
  function current(token) { return token === generation && host?.isConnected && host.closest('dialog')?.open; }
  function message(text, error = false) {
    q('[data-fst-message]').textContent = text;
    q('[data-fst-message]').classList.toggle('error', error);
  }
  function selections() {
    return [...host.querySelectorAll('[data-fst-face]:checked')].map(el => ({faceId:Number(el.dataset.fstFace),
      personId:q(`[data-fst-id="${el.dataset.fstFace}"]`).value.trim().toUpperCase()}));
  }
  function controls() {
    for (const el of host.querySelectorAll('[data-fst-face],[data-fst-id]')) el.disabled = busy;
    const waiting = ['checking','connecting','cancelling'].includes(connection.status);
    q('[data-fst-reload]').disabled = busy;
    q('[data-fst-connect]').disabled = busy || waiting;
    q('[data-fst-connect]').textContent = connection.connected ? 'Reconnect FamilySearch' : waiting ? 'Connecting…' : 'Connect FamilySearch';
    q('[data-fst-cancel]').hidden = !['connecting','cancelling'].includes(connection.status);
    q('[data-fst-cancel]').disabled = busy || connection.status !== 'connecting';
    q('[data-fst-check]').disabled = busy || !connection.connected || !selections().length;
    const allKept = preview?.tagActions?.length && preview.tagActions.every(tag=>tag.action === 'keep');
    q('[data-fst-send]').disabled = busy || !connection.connected || !preview || Boolean(allKept);
    q('[data-fst-send]').textContent = sending ? 'Submitting tags…' : 'Submit tags';
    host.setAttribute('aria-busy', String(busy));
  }
  function connectionView(data) {
    connection = data;
    q('[data-fst-connection]').textContent = data.note;
    controls();
  }
  async function refreshConnection(check = false) {
    const token = generation;
    clearTimeout(timer);
    try {
      const data = await request(`/api/familysearch-connection${check ? '?check=1' : ''}`);
      if (!current(token)) return;
      connectionView(data);
      if (['checking','connecting','cancelling'].includes(data.status)) timer=setTimeout(()=>refreshConnection(),1500);
    } catch {
      if (current(token)) connectionView({status:'error',connected:false,
        note:'Could not check the connection. Click Connect FamilySearch to try again.'});
    }
  }
  async function open() {
    if (busy || sending) return;
    const token = ++generation;
    host.innerHTML = '<h3>Tag in FamilySearch</h3><p role="status">Loading the Memory and named faces…</p>';
    try {
      info = await request(`${api}/photo?photo=${encodeURIComponent(path)}`);
      if (!current(token)) return;
      host.innerHTML = `<h3>Tag in FamilySearch</h3>
        <p class="help">Select the people you identified. Face numbers match the boxes in this photo. Only the selected tags will be submitted.</p>
        <a href="${esc(info.memoryUrl)}" target="_blank" rel="noopener noreferrer">Open Memory ${esc(info.memoryId)}<span class="sr"> (opens in a new tab)</span></a>
        <div class="fst-connection"><p class="help" data-fst-connection role="status">Checking the saved FamilySearch session…</p>
          <div class="pv-actions"><button class="btn" type="button" data-fst-connect>Connect FamilySearch</button>
            <button class="btn" type="button" data-fst-cancel hidden>Cancel sign-in</button></div></div>
        <fieldset><legend>People to tag</legend>${info.faces.map(face=>`<div class="fst-person">
          <label><input type="checkbox" data-fst-face="${face.id}"><img src="/thumbs/${face.id}.jpg?v=${S.v}" alt="">
            <span>${face.number}. ${esc(face.name)}</span></label>
          <label class="fst-id">FamilySearch person ID<input class="name" data-fst-id="${face.id}" value="${esc(face.personId)}"
            placeholder="ABCD-123" maxlength="8" autocapitalize="characters" spellcheck="false"></label></div>`).join('')}
          ${info.faces.length ? '' : '<p class="help">Name a face in the list above first. Then click Reload named faces.</p>'}<button class="btn" type="button" data-fst-reload>Reload named faces</button></fieldset>
        <div class="fst-preview" data-fst-preview></div>
        <p class="help" data-fst-message role="status" aria-live="polite">Check the tags before submitting them. This uses the existing Memory.</p>
        <div class="pv-actions"><button class="btn" type="button" data-fst-check>Check selected tags</button>
          <button class="btn primary" type="button" data-fst-send disabled>Submit tags</button></div>`;
      preview = null; busy = false; connection = {status:'checking',connected:false};
      controls(); refreshConnection(true);
    } catch (error) {
      if (current(token)) host.innerHTML = `<h3>Tag in FamilySearch</h3><p class="error" role="alert">${esc(error.message)}</p>
        <button class="btn" type="button" data-fst-reload>Try again</button>`;
    }
  }
  async function check() {
    if (busy || q('[data-fst-check]').disabled) return;
    const token = generation;
    busy = true; preview = null; controls();
    q('[data-fst-preview]').textContent = ''; message('Checking the people and existing Memory tags…');
    try {
      const data = await request(api+'/preview',{photo:path,faces:selections()});
      if (!current(token)) return;
      preview = data;
      const actions = {create:'Add face tag',link:'Link existing tag to this person',keep:'Already tagged'};
      q('[data-fst-preview]').innerHTML = `<h4>Review the confirmed people</h4><ul>${data.people.map((person,i)=>
        `<li><strong>${esc(person.personName)}</strong> <span class="meta">${esc(person.personId)}</span><br>${esc(actions[data.tagActions[i].action])}</li>`).join('')}</ul>`;
      message(data.tagActions.every(tag=>tag.action === 'keep') ? 'All selected people are already tagged. No changes are needed.' :
        'Check the confirmed names above, then submit the selected tags. The photo will not be uploaded again.');
    } catch (error) {
      if (!current(token)) return;
      if (/HTTP 401|Not authenticated|no FamilySearch access token/i.test(error.message)) connectionView({status:'disconnected',connected:false,
        note:'Connect FamilySearch, then check the selected tags again.'});
      message(error.message,true);
    } finally {
      if (current(token)) {busy=false;controls();}
    }
  }
  async function submit() {
    if (busy || q('[data-fst-send]').disabled) return;
    const token = generation;
    busy = true; sending = true; controls(); message('Submitting the selected tags. Keep this photo open…');
    try {
      const data = await request(api+'/confirm',{photo:path,previewToken:preview.previewToken});
      if (!current(token)) return;
      preview = null;
      message(data.tagsApplied ? 'Tags confirmed in FamilySearch. No photo was uploaded.' :
        data.note || 'Some tags could not be confirmed. Open the Memory to check them before trying again.', !data.tagsApplied);
    } catch (error) {
      if (current(token)) {preview=null;message(error.message,true);}
    } finally {
      sending = false;
      if (current(token)) {busy=false;controls();}
    }
  }
  function mount(element, photo) {
    if (host === element && path === photo) return;
    ++generation;clearTimeout(timer);
    host?.removeEventListener('click',onClick);
    host?.removeEventListener('input',onInput);
    host=element;path=photo;preview=null;busy=false;
    host.addEventListener('click',onClick);
    host.addEventListener('input',onInput);
    host.hidden=!photo;
    host.innerHTML=photo ? '<button class="btn" type="button" data-fst-open>Tag in FamilySearch</button><p class="help">Add selected people to this photo’s existing Memory.</p>' : '';
  }
  async function onClick(event) {
    if (!host?.contains(event.target)) return;
    if (event.target.closest('[data-fst-open],[data-fst-reload]')) return open();
    if (event.target.closest('[data-fst-check]')) return check();
    if (event.target.closest('[data-fst-send]')) return submit();
    const connect = event.target.closest('[data-fst-connect]'), cancel = event.target.closest('[data-fst-cancel]');
    if ((!connect && !cancel) || (connect || cancel).disabled) return;
    const token=generation;preview=null;clearTimeout(timer);
    connectionView({status:cancel?'cancelling':'connecting',connected:false,note:cancel?'Stopping sign-in…':'Checking your Chrome session…'});
    try {
      const data=await request('/api/familysearch-connection/'+(cancel?'cancel':'connect'),{});
      if(current(token)){connectionView(data);refreshConnection();}
    } catch {if(current(token))refreshConnection();}
  }
  function onInput(event) {
    if(!host?.contains(event.target) || !event.target.matches('[data-fst-face],[data-fst-id]'))return;
    preview=null;q('[data-fst-preview]').textContent='';message('Check the selected tags again after this change.');controls();
  }
  window.FamilySearchTags = {mount,isSubmitting:()=>sending};
})();
