// Timeline: the photos by decade and year, dated from your dates, camera dates, caption years and the ages of named people.
// Data: GET /api/timeline (api/dates.py). Route: #/timeline?decade=1980&person=Name  ·  #/timeline?view=undated
(() => {
  const TL = {
    decade: null, person: "", view: "", all: new Set(), cache: new Map(), req: 0, poll: null, modalReq: 0,
    und: { q: null, items: [], people: [], seen: new Set() },   // "Photos that could use a date", page by page
    saved: new Map(),                                         // path -> year saved in this session
    personMsg: "", personMsgFor: "",
  };
  const fmt = n => Number(n).toLocaleString();
  const plural = (n, one, many = one + "s") => `${fmt(n)} ${n === 1 ? one : many}`;
  const thumb = path => `/gallery-image/${encodeURIComponent(path)}?v=${typeof S !== "undefined" && S ? S.v : 0}`;
  const NOW = new Date().getFullYear();

  function query(extra = {}) {
    const p = new URLSearchParams();
    if (TL.person) p.set("person", TL.person);
    if (TL.view === "undated") p.set("view", "undated");
    else if (TL.decade != null) {
      p.set("decade", TL.decade);
      if (TL.all.has("rough")) p.set("rough", "all");
    }
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }
  function remember(q, d) {           // a few recent views, for instant back-and-forth
    TL.cache.delete(q); TL.cache.set(q, d);
    while (TL.cache.size > 8) TL.cache.delete(TL.cache.keys().next().value);
  }

  // "about 1953", "1953", "1988–89", "early 1980s", "1970s–1990s" (rough)
  const when = p => p.year == null ? "No date yet" : p.label || String(p.year);
  function why(p) {
    if (p.year == null) return (p.basis ? p.basis[0].toUpperCase() + p.basis.slice(1) : "") + (p.conflict && p.conflict !== p.basis ? ` · ${p.conflict}` : "");
    const src = p.source === "estimated" ? `${p.rough ? "Rough estimate" : "Estimated"} ${p.basis}`
      : p.source === "caption" ? `From the caption: ${p.basis.replace(/^caption says /, "")}`
      : p.source === "file date" ? (p.camera ? "The camera’s date in the file" : "A date saved in the file")
      : "Your date";
    const range = p.source === "estimated" && p.low !== p.high ? ` · likely ${p.low}–${p.high}` : "";
    return src + range + (p.conflict ? ` · ${p.conflict}` : "");
  }
  const chip = p => p.source === "caption" ? "caption" : p.source === "your date" ? "your date"
    : p.source === "file date" ? (p.camera ? "camera date" : "file date") : "";

  function tile(p) {
    const cap = p.caption || "", c = chip(p);
    const label = `${cap || "Photo"}, ${when(p)}`;
    return `<figure class="tl-photo" title="${esc(why(p))}">
      <button class="tl-open" data-tl-open="${esc(p.path)}" aria-label="Open photo: ${esc(label)}">
        <img loading="lazy" decoding="async" src="${thumb(p.path)}" alt=""></button>
      <figcaption><span class="tl-card-meta"><span class="tl-when${p.rough ? " rough" : ""}">${esc(when(p))}</span>${p.age != null && p.age >= 0 && !p.rough ? `<span class="tl-age">age ${p.age}</span>` : ""}</span><span class="tl-source-line">${c ? `<span class="tl-src">${c}</span>` : ""}</span>
        ${cap ? `<span class="tl-cap">${esc(cap)}</span>` : ""}</figcaption>
    </figure>`;
  }

  function shell() {
    return `<div class="tl" id="tl-root">
      <p class="help">When each photo was taken, from years you entered, camera dates, years in captions, and the ages of named people who have a birth year. Estimates from faces are approximate: a child’s age pins a photo down to a year or two, an adult’s often only to a few decades, so those show as a span like “1970s–1990s”.</p>
      <div class="tl-controls">
        <label class="tl-person" for="tl-person">Person</label>
        <div class="tl-person-row">
          <input class="name" id="tl-person" list="people-list" placeholder="Everyone · type a name" autocomplete="off" spellcheck="false" aria-describedby="tl-person-msg">
          <button class="btn" id="tl-person-clear" hidden>Show everyone</button>
        </div>
        <p class="meta tl-person-msg" id="tl-person-msg" aria-live="polite"></p>
      </div>
      <div class="tl-summary" id="tl-summary" role="status"></div>
      <div class="tl-ruler-wrap" id="tl-ruler-wrap"><div class="tl-ruler" id="tl-ruler" role="group" aria-label="Decades"></div></div>
      <p class="meta tl-scroll-help">Scroll to see more decades.</p>
      <div id="tl-body" class="tl-body"><div class="empty">Loading the timeline…</div></div>
    </div>`;
  }

  function summary(d) {
    const src = d.by_source;
    const parts = [src["your date"] && `${fmt(src["your date"])} from your dates`, src["file date"] && `${fmt(src["file date"])} from dates in the files`,
      src.caption && `${fmt(src.caption)} from captions`, src.estimated && `${fmt(src.estimated)} estimated from faces`].filter(Boolean);
    const who = d.person ? `<b class="tl-who">${esc(d.person.name)}</b>${d.person.born ? ` <span class="tl-life">${d.person.born}–${d.person.died || ""}</span>` : ""} · ` : "";
    const undated = d.undated ? ` <button class="btn link tl-undated-link" data-tl-view="undated">${plural(d.undated, "photo")} could use a date</button>` : "";
    return `<p>${who}<b class="tl-num">${fmt(d.dated)}</b> of ${plural(d.total, "photo")} dated${d.rough ? ` · ${fmt(d.rough)} roughly dated` : ""}${parts.length ? ` <span class="meta">(${parts.join(", ")})</span>` : ""}.${undated}</p>`
      + (d.updating ? `<p class="meta">Updating dates for recent changes…</p>` : "");
  }

  function ruler(d) {
    const decs = d.decades;
    if (!decs.length) return "";
    const by = Object.fromEntries(decs.map(x => [x.decade, x]));
    const max = Math.max(...decs.map(x => x.count));
    const first = decs[0].decade, last = decs[decs.length - 1].decade;
    const born = d.person && d.person.born, died = d.person && (d.person.died || NOW);
    let html = "";
    for (let y = first; y <= last; y += 10) {
      const c = by[y] ? by[y].count : 0;
      // Photos dated to a year make the solid part of the bar; rough face estimates (a span of decades,
      // filed here by their middle) the light part above it, so a peak of guesses doesn't look like a fact.
      const rough = by[y] ? by[y].rough || 0 : 0, dated = c - rough;
      const h = c ? Math.max(6, Math.sqrt(c / max) * 100) : 0, hd = c ? h * dated / c : 0;
      const on = TL.view !== "undated" && TL.decade === y;
      const life = born && y + 9 >= born && y <= died;
      html += `<button class="tl-dec${on ? " on" : ""}${life ? " life" : ""}${c === max ? " top" : ""}" data-tl-decade="${y}" ${c ? "" : "disabled"} aria-pressed="${on}"
        aria-label="${y}s, ${plural(dated, "photo")} dated${rough ? `, ${fmt(rough)} roughly` : ""}${life ? `, in ${esc(d.person.name)}’s lifetime` : ""}">
        <span class="tl-bar">${rough ? `<i class="tl-rough" style="height:${(h - hd).toFixed(1)}%"></i>` : ""}<i class="tl-dated${rough ? " under" : ""}" style="height:${hd.toFixed(1)}%"></i></span><span class="tl-dec-n">${c ? fmt(dated) : ""}${rough ? `<small>+${fmt(rough)}</small>` : ""}</span><span class="tl-dec-y">${y}s</span></button>`;
    }
    html += `<button class="tl-dec tl-undated${TL.view === "undated" ? " on" : ""}" data-tl-view="undated" aria-pressed="${TL.view === "undated"}" aria-label="Undated, ${plural(d.undated, "photo")}">
      <span class="tl-bar"><i></i></span><span class="tl-dec-n">${fmt(d.undated)}</span><span class="tl-dec-y">Undated</span></button>`;
    return html;
  }

  function overview(d) {
    if (!d.decades.length) return `<div class="empty">${d.person ? `No dated photos of ${esc(d.person.name)} yet. Add a birth year for them in the Family tree, or a year to a photo’s caption.` : "No dated photos yet. Add birth years in the Family tree to start dating photos."}</div>`;
    return d.decades.map(x => `<section class="tl-row" aria-labelledby="tl-row-${x.decade}">
      <div class="tl-row-head"><h3 id="tl-row-${x.decade}">${x.decade}s</h3><span class="meta"><b>${fmt(x.count)}</b> ${x.count === 1 ? "photo" : "photos"}</span>
        <button class="btn" data-tl-decade="${x.decade}">Open the ${x.decade}s</button></div>
      <div class="tl-grid tl-strip">${x.photos.map(tile).join("")}</div>
      ${x.rough ? `<h4>Around this decade <span class="meta">${plural(x.rough, "rough estimate")}</span></h4>
        <div class="tl-grid tl-strip">${(x.around_photos || []).map(tile).join("")}</div>` : ""}</section>`).join("");
  }

  function decadeView(d) {
    const y0 = d.decade, years = d.years || [];
    const total = years.reduce((a, y) => a + y.count, 0) + (d.around?.count || 0);
    const near = d.decades.map(x => x.decade);
    const prev = near.filter(x => x < y0).pop(), next = near.find(x => x > y0);
    const nav = `<div class="tl-dhead">
      <h2>${y0}s</h2><span class="meta"><b>${fmt(total)}</b> ${total === 1 ? "photo" : "photos"}</span>
      <span class="tl-step">
        <button class="btn" data-tl-decade="${prev ?? ""}" ${prev == null ? "disabled" : ""} aria-label="${prev == null ? "No earlier photos" : `Previous decade, the ${prev}s`}">← ${prev != null ? `${prev}s` : "Earlier"}</button>
        <button class="btn" data-tl-decade="${next ?? ""}" ${next == null ? "disabled" : ""} aria-label="${next == null ? "No later photos" : `Next decade, the ${next}s`}">${next != null ? `${next}s` : "Later"} →</button>
        <button class="btn" data-tl-overview>All decades</button></span></div>`;
    const chips = `<div class="tl-years" role="group" aria-label="Jump to a year">${years.map(y => y.count
      ? `<button class="chip" data-tl-jump="${y.year}">${y.year}<small>${fmt(y.count)}</small></button>`
      : `<span class="chip tl-none" aria-hidden="true">${y.year}</span>`).join("")}</div>`;
    if (!total) return nav + `<div class="empty">No dated photos in the ${y0}s${d.person ? ` of ${esc(d.person.name)}` : ""}.</div>`;
    const around = d.around?.count ? `<section class="tl-year" aria-labelledby="tl-around-h">
      <h3 id="tl-around-h">Around this decade<span class="meta">${plural(d.around.count, "rough estimate")}</span></h3>
      <p class="help">These spans may cover several decades. The app cannot place these photos in one year.</p>
      <div class="tl-grid">${d.around.photos.map(tile).join("")}</div>
      ${d.around.count > d.around.photos.length ? `<button class="btn tl-more" data-tl-all="rough">Show all ${fmt(d.around.count)} rough estimates</button>` : ""}</section>` : "";
    return nav + chips + years.filter(y => y.count).map(y => `<section class="tl-year" id="tl-y-${y.year}" aria-labelledby="tl-yh-${y.year}">
      <h3 id="tl-yh-${y.year}">${y.year}<span class="meta">${plural(y.count, "photo")}</span></h3>
      <div class="tl-grid">${y.photos.map(tile).join("")}</div>
      ${y.count > y.photos.length ? `<button class="btn tl-more" data-tl-all="${y.year}">Show all ${fmt(y.count)} from ${y.year}</button>` : ""}
    </section>`).join("") + around;
  }

  // who to add: a link to them in the tree, or to the tree's "Not in the tree yet" list
  const personLink = n => n.in_tree
    ? `<a href="#/tree/${encodeURIComponent(n.name)}">${esc(n.name)}</a>`
    : `<a href="#/tree" data-tl-tray="${esc(n.name)}">${esc(n.name)}</a>`;
  function needText(need) {
    const inTree = need.filter(n => n.in_tree).slice(0, 2), out = need.filter(n => !n.in_tree).slice(0, 2);
    const parts = [];
    if (inTree.length) parts.push(`Add a birth year for ${inTree.map(personLink).join(" or ")}`);
    if (out.length) parts.push(`${parts.length ? "or add" : "Add"} ${out.map(personLink).join(" or ")} to the Family tree with a birth year`);
    const more = need.length - inTree.length - out.length;
    return parts.join(", ") + (more > 0 ? ` (or ${plural(more, "other")})` : "") + ".";
  }

  function peoplePanel(people) {
    if (!people || !people.length) return "";
    return `<section class="tl-who-panel" aria-labelledby="tl-who-h">
      <h3 id="tl-who-h">Birth years that would date the most photos</h3>
      <ul>${people.map(n => `<li>
        <span class="tl-who-name">${personLink(n)}</span><span class="meta"><b>${fmt(n.photos)}</b> ${n.photos === 1 ? "photo" : "photos"}</span>
        ${n.in_tree ? `<form class="tl-date-form" data-tl-born="${esc(n.name)}">
            <label>Born <input class="name" name="born" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="Year" autocomplete="off" aria-label="Birth year for ${esc(n.name)}"></label>
            <button class="btn" type="submit">Save</button></form>`
          : `<a class="btn" href="#/tree" data-tl-tray="${esc(n.name)}">Add to the Family tree</a>`}
      </li>`).join("")}</ul></section>`;
  }

  function undatedCard(p) {
    const saved = TL.saved.get(p.path);
    const need = p.needs || [];
    return `<figure class="tl-card${saved ? " done" : ""}" data-tl-card="${esc(p.path)}">
      <button class="tl-open" data-tl-open="${esc(p.path)}" aria-label="Open photo: ${esc(p.caption || "untitled photo")}"><img loading="lazy" decoding="async" src="${thumb(p.path)}" alt=""></button>
      <figcaption>${p.caption ? `<span class="tl-cap">${esc(p.caption)}</span>` : `<span class="tl-cap none">No caption</span>`}
        <span class="meta">${need.length ? needText(need) : esc(why(p))}</span>
        ${saved ? `<span class="tl-saved"><span class="tl-when">${saved}</span> saved</span>` : `<form class="tl-date-form" data-tl-date="${esc(p.path)}">
          <label>Year <input class="name" name="year" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="1952" autocomplete="off" aria-label="Year this photo was taken"></label>
          <button class="btn" type="submit">Save</button>
        </form>`}</figcaption></figure>`;
  }

  function undatedView(d) {
    const U = TL.und, photos = U.items;
    const head = `<div class="tl-dhead"><h2>Photos that could use a date</h2><span class="meta"><b id="tl-und-n">${fmt(d.undated)}</b> undated</span>
      <span class="tl-step"><button class="btn" data-tl-overview>Back to the timeline</button></span></div>
      <p class="help">The photos closest to being dated come first: one birth year dates each of them, starting with the people who appear in the most. If you know when a photo was taken, type the year and save it. It’s used instead of any estimate.</p>`;
    if (!photos.length) return head + `<div class="empty">Every photo${d.person ? ` of ${esc(d.person.name)}` : ""} has a date.</div>`;
    const left = d.undated - (photos.length - [...TL.saved.keys()].filter(p => U.seen.has(p)).length);
    return head + peoplePanel(U.people) + `<div class="tl-undated-grid">${photos.map(undatedCard).join("")}</div>
    ${left > 0 ? `<button class="btn tl-more" data-tl-page>Show more (${fmt(left)} left)</button>` : ""}`;
  }

  function draw(d) {
    const root = $("#tl-root");
    if (!root) return;
    const focus = document.activeElement && root.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    $("#tl-summary").innerHTML = summary(d);
    $("#tl-person-clear").hidden = !TL.person;
    $("#tl-person-msg").textContent = TL.personMsg;
    $("#tl-ruler").innerHTML = ruler(d);
    $("#tl-body").innerHTML = TL.view === "undated" ? undatedView(d) : d.decade != null ? decadeView(d) : overview(d);
    if (focus) { const el = root.querySelector(focus); if (el) el.focus({ preventScroll: true }); }
    placeRuler();
  }
  // Start with the earliest decade; keep a chosen decade fully in view.
  function placeRuler() {
    const r = $("#tl-ruler");
    if (!r) return;
    const on = r.querySelector(".tl-dec.on");
    if (on && (on.offsetLeft < r.scrollLeft || on.offsetLeft + on.offsetWidth > r.scrollLeft + r.clientWidth))
      r.scrollLeft = on.offsetLeft - 2;
    if (!on) r.scrollLeft = 0;
    edges();
  }
  function edges() {   // fade the ends that have more decades scrolled out of view
    const r = $("#tl-ruler"), w = $("#tl-ruler-wrap");
    if (!r || !w) return;
    w.classList.toggle("more-left", r.scrollLeft > 4);
    w.classList.toggle("more-right", r.scrollLeft + r.clientWidth < r.scrollWidth - 4);
  }
  function focusKey(el) {
    for (const k of ["tlDecade", "tlView", "tlJump", "tlAll", "tlOpen"]) if (el.dataset[k] != null) return `[data-${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}="${CSS.escape(el.dataset[k])}"]`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    return null;
  }

  async function getJSON(url) {
    const r = await fetch(url);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "The timeline didn’t load.");
    return d;
  }

  async function refresh() {
    const q = query(), req = ++TL.req;
    clearTimeout(TL.poll);
    const undated = TL.view === "undated";
    if (undated && TL.und.q === q && TL.cache.has(q)) draw(TL.cache.get(q));
    else if (!undated && TL.cache.has(q)) draw(TL.cache.get(q));
    let d;
    try {
      d = await getJSON(`/api/timeline?${q}`);
      if (req !== TL.req || tab !== "timeline") return;
      if (TL.all.size && d.years) {   // years opened with "Show all"
        for (const y of TL.all) if (Math.floor(y / 10) * 10 === d.decade) {
          const full = await getJSON(`/api/timeline?${q}&year=${y}`);
          if (req !== TL.req) return;
          const row = full.years && full.years.find(x => x.year === y), mine = d.years.find(x => x.year === y);
          if (row && mine) mine.photos = row.photos;
        }
      }
    } catch (err) {
      if (req === TL.req && $("#tl-body")) $("#tl-body").innerHTML = `<div class="empty" role="alert">${esc((err.message || "The timeline didn’t load").replace(/[.\s]+$/, ""))}. Reload the page to try again.</div>`;
      return;
    }
    if (undated) {
      TL.und = { q, items: d.photos || [], people: d.people_to_date || [], seen: new Set((d.photos || []).map(p => p.path)) };
    }
    remember(q, d);
    draw(d);
    if (d.updating) TL.poll = setTimeout(() => tab === "timeline" && (TL.view === "undated" ? counts() : refresh()), 2000);
  }

  // after a save: new counts for the summary, ruler and headings, without reloading the photos on screen
  async function counts() {
    const q = query(), req = TL.req;
    clearTimeout(TL.poll);
    try {
      const c = await getJSON(`/api/timeline?${query({ view: "counts" })}`);
      if (req !== TL.req || tab !== "timeline" || q !== query()) return;
      const last = TL.cache.get(q);
      const d = last ? Object.assign({}, last, { dated: c.dated, rough: c.rough, undated: c.undated, total: c.total, by_source: c.by_source, decades: TL.view === "undated" ? c.decades : last.decades, updating: c.updating }) : null;
      if (!d) return;
      remember(q, d);
      $("#tl-summary").innerHTML = summary(d);
      $("#tl-ruler").innerHTML = ruler(d); placeRuler();
      if (TL.view === "undated") {
        if ($("#tl-und-n")) $("#tl-und-n").textContent = fmt(d.undated);
        const more = $("[data-tl-page]");
        const left = d.undated - (TL.und.items.length - [...TL.saved.keys()].filter(p => TL.und.seen.has(p)).length);
        if (more) { if (left > 0) more.textContent = `Show more (${fmt(left)} left)`; else more.remove(); }
      }
      TL.cache.forEach((v, k) => { if (k !== q) TL.cache.delete(k); });
      if (c.updating) TL.poll = setTimeout(() => tab === "timeline" && counts(), 2000);
    } catch { /* the counts catch up on the next visit */ }
  }

  async function showMore(btn) {
    const U = TL.und, q = query();
    const savedHere = [...TL.saved.keys()].filter(p => U.seen.has(p)).length;
    btn.disabled = true; btn.textContent = "Loading…";
    try {
      const d = await getJSON(`/api/timeline?${query({ offset: U.items.length - savedHere })}`);
      if (q !== query() || U !== TL.und) return;
      const fresh = (d.photos || []).filter(p => !U.seen.has(p.path));
      fresh.forEach(p => U.seen.add(p.path));
      U.items = U.items.concat(fresh);
      const last = TL.cache.get(q) || d;
      last.undated = d.undated;
      const y = scrollY;
      draw(last);
      scrollTo({ top: y });
      const first = fresh[0] && $(`[data-tl-card="${CSS.escape(fresh[0].path)}"] .tl-open`);
      if (first) first.focus({ preventScroll: true });
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = "Show more"; }
  }

  function go(changes, replace = false) {
    Object.assign(TL, changes);
    if (TL.person !== TL.personMsgFor) { TL.personMsg = ""; TL.personMsgFor = ""; }
    TL.und = { q: null, items: [], people: [], seen: new Set() };
    syncURL(replace);
    refresh();
  }

  // the name typed or chosen: exact, then the only name that starts with it, then the only name that contains it
  function matchPerson(raw) {
    const names = Object.keys(S?.people || {}), low = raw.toLowerCase();
    const exact = names.find(n => n === raw) || names.find(n => n.toLowerCase() === low);
    if (exact) return { name: exact };
    for (const test of [n => n.toLowerCase().startsWith(low), n => n.toLowerCase().includes(low)]) {
      const hits = names.filter(test);
      if (hits.length === 1) return { name: hits[0] };
      if (hits.length > 1) return { many: hits.length };
    }
    return {};
  }
  function setPerson(raw) {
    const name = raw.trim();
    const msg = $("#tl-person-msg");
    if (!name) { TL.personMsg = ""; msg.textContent = ""; return go({ person: "" }); }
    const m = matchPerson(name);
    if (!m.name) {
      TL.personMsg = m.many ? `“${name}” matches ${fmt(m.many)} people. Pick one from the list.` : `No one called “${name}” in your people. Pick a name from the list.`;
      msg.textContent = TL.personMsg;
      return;
    }
    TL.personMsg = ""; msg.textContent = "";
    $("#tl-person").value = m.name;
    if (m.name !== TL.person) go({ person: m.name });
  }

  async function showDateInModal(path) {
    const token = ++TL.modalReq;
    await openPhotoPath(path);
    if (token !== TL.modalReq) return;
    try {
      const d = await getJSON(`/api/photo-date?path=${encodeURIComponent(path)}`);
      const cap = $("#modal-wrap .cap"), img = $("#modal-img");
      // the viewer may have been closed, or moved on to another photo, while this loaded
      if (token !== TL.modalReq || !cap || !$("#modal").classList.contains("on") || !img || img.getAttribute("src") !== photoURL(path)) return;
      cap.querySelectorAll(".tl-modal-date").forEach(x => x.remove());
      const faces = (d.faces || []).map(f => `${esc(f.name)} (born ${f.born}, looks about ${f.age}${f.ignored ? ", left out" : f.fits === false ? ", doesn’t fit" : ""})`).join(", ");
      const line = document.createElement("div");
      line.className = "sub tl-modal-date";
      line.innerHTML = d.year == null ? `No date yet: ${esc(why(d)).replace(/^./, c => c.toLowerCase())}.`
        : `<b>${esc(when(d))}</b> · ${esc(why(d))}${faces && d.source === "estimated" ? ` · ${faces}` : ""}`;
      cap.appendChild(line);
    } catch { /* the photo itself is already showing */ }
  }

  // Through the app's one ordered write queue (postJSON in review.html). The "Saved" toast that follows offers
  // Undo for this History entry (toast() does that for a change saved in the last 2 seconds).
  async function send(url, body) {
    const d = await postJSON(url, body, { quiet: true });
    if (d.error) throw new Error(d.status === 0 ? REACH_ERROR : d.error || "That wasn’t saved. Try again.");
    return d;
  }

  document.addEventListener("click", e => {
    if (tab !== "timeline" || !e.target.closest("#tl-root")) return;
    const tray = e.target.closest("[data-tl-tray]");
    if (tray) { try { tTrayFilter = tray.dataset.tlTray; } catch { /* the tree opens unfiltered */ } return; }  // the link opens the tree
    const t = e.target.closest("[data-tl-decade],[data-tl-view],[data-tl-overview],[data-tl-jump],[data-tl-all],[data-tl-open],[data-tl-page],#tl-person-clear");
    if (!t) return;
    if (t.id === "tl-person-clear") { $("#tl-person").value = ""; TL.personMsg = ""; $("#tl-person-msg").textContent = ""; $("#tl-person").focus(); return go({ person: "" }); }
    if (t.dataset.tlOpen) return showDateInModal(t.dataset.tlOpen);
    if (t.dataset.tlDecade != null && t.dataset.tlDecade !== "") { scrollTo({ top: 0 }); return go({ decade: +t.dataset.tlDecade, view: "" }); }
    if (t.dataset.tlView) { scrollTo({ top: 0 }); return go({ view: TL.view === "undated" ? "" : "undated" }); }
    if (t.dataset.tlOverview != null) { scrollTo({ top: 0 }); return go({ decade: null, view: "" }); }
    if (t.dataset.tlJump) {
      const s = $(`#tl-y-${t.dataset.tlJump}`);
      if (s) { s.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); s.querySelector(".tl-open")?.focus({ preventScroll: true }); }
      return;
    }
    if (t.dataset.tlAll) { TL.all.add(t.dataset.tlAll === "rough" ? "rough" : +t.dataset.tlAll); t.disabled = true; t.textContent = "Loading…"; return refresh(); }
    if (t.dataset.tlPage != null) return showMore(t);
  });
  document.addEventListener("scroll", e => { if (e.target.id === "tl-ruler") edges(); }, { capture: true, passive: true });
  addEventListener("resize", () => tab === "timeline" && edges(), { passive: true });
  document.addEventListener("change", e => { if (e.target.id === "tl-person") setPerson(e.target.value); });
  document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "tl-person") { e.preventDefault(); setPerson(e.target.value); } });
  document.addEventListener("submit", async e => {
    const form = e.target.closest("[data-tl-date],[data-tl-born]");
    if (!form || !e.target.closest("#tl-root")) return;
    e.preventDefault();
    const input = form.querySelector("input"), value = input.value.trim(), btn = form.querySelector("button");
    if (form.dataset.tlBorn != null) {
      if (!/^\d{4}$/.test(value) || +value < 1700 || +value > NOW) { toast(`Type a birth year between 1700 and ${NOW}, like 1922.`, true); return input.focus(); }
      btn.disabled = true;
      try {
        const before = (TL.cache.get(query()) || {}).undated;
        const d = await send("/api/person-born", { name: form.dataset.tlBorn, born: value });
        const c = await getJSON(`/api/timeline?${query({ view: "counts" })}`).catch(() => null);
        const gained = c && before != null ? before - c.undated : 0;
        toast(`Saved: ${d.name}, born ${d.born}.${gained > 0 ? ` ${plural(gained, "more photo")} ${gained === 1 ? "has" : "have"} a date.` : ""}`);
        TL.saved.clear(); TL.cache.clear();
        go({});
      } catch (err) { toast(err.message, true); btn.disabled = false; }
      return;
    }
    if (!/^\d{4}$/.test(value) || +value < 1839 || +value > NOW) { toast(`Type a year between 1839 and ${NOW}, like 1952.`, true); return input.focus(); }
    btn.disabled = true;
    try {
      const d = await send("/api/photo-date", { path: form.dataset.tlDate, year: value });
      toast(`Saved: taken in ${d.year}.`);
      TL.saved.set(form.dataset.tlDate, d.year);
      const card = form.closest(".tl-card");
      card.classList.add("done");
      form.outerHTML = `<span class="tl-saved"><span class="tl-when">${d.year}</span> saved</span>`;
      counts();
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  });

  registerTab("timeline", { boot: true,
    title: "Timeline", group: "Explore",
    icon: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    render(main) {
      $("#page-title").textContent = "Timeline";
      if (!main.querySelector("#tl-root")) main.innerHTML = shell();
      // a name from the address bar that isn't one of your people: say so and show everyone
      if (TL.person && S?.people && !Object.prototype.hasOwnProperty.call(S.people, TL.person)) {
        const m = matchPerson(TL.person);
        TL.personMsgFor = m.name ? "" : TL.person;
        TL.personMsg = m.name ? "" : `No one called “${TL.person}” in your people, so this shows everyone.`;
        TL.person = m.name || "";
        syncURL(true);
      }
      const input = $("#tl-person");
      if (document.activeElement !== input) input.value = TL.person;
      $("#tl-person-clear").hidden = !TL.person;
      $("#tl-person-msg").textContent = TL.personMsg;
      refresh();
    },
    getRoute() {
      return { sub: null, params: TL.view === "undated" ? { view: "undated", person: TL.person } : { decade: TL.decade ?? "", person: TL.person } };
    },
    setRoute({ params }) {
      const d = parseInt(params.decade, 10);
      TL.decade = Number.isFinite(d) ? Math.floor(d / 10) * 10 : null;
      if (!params.person || params.person !== TL.personMsgFor) { TL.personMsg = ""; TL.personMsgFor = ""; }
      TL.person = params.person || "";
      TL.view = params.view === "undated" ? "undated" : "";
      TL.und = { q: null, items: [], people: [], seen: new Set() };
      TL.all.clear();
    },
  });
})();
