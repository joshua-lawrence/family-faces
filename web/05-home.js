/* Home: the overview page and the app's default route (#/home).
   Library numbers come from GET /api/home (api_home.py, cached on the server until the data changes),
   so the page draws before the main state has loaded. Counts that depend on the Groups and Leftover
   filters come from S once it arrives, so they always match the sidebar badges. */
(() => {
  const H = { data: null, inflight: null, failed: false, photos: [], pi: 0, importing: false, extra: {}, html: "" };
  const ICON = '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v10.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V9"/>';
  const CHEVRON = '<svg class="home-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  const SVG = {
    inbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  };
  const LIKELY = 0.4;
  const fmt = n => Number(n || 0).toLocaleString();
  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const num = v => `<span class="home-n">${fmt(v)}</span>`;
  const plural = (k, one, many = one + "s") => (k === 1 ? one : many);
  const enc = encodeURIComponent;
  const ver = () => (S && S.v) || (H.data && H.data.v) || 0;
  const faceImg = (id, cls = "") => `<img class="${cls}" src="/thumbs/${id}.jpg?v=${ver()}" alt="" loading="lazy" decoding="async">`;
  const initials = name => esc(String(name).replace(/&quot;|["'()]/g, "").split(/\s+/).filter(Boolean)
    .map(w => w[0]).join("").slice(0, 2).toUpperCase());
  function avatar(p, cls = "home-av") {
    if (p.rep != null) return faceImg(p.rep, cls);
    if (p.src) return `<img class="${cls}" src="/photos/${enc(p.src)}?v=${ver()}&thumbnail=1" alt="" loading="lazy" decoding="async">`;
    return `<span class="${cls} home-initials" aria-hidden="true">${initials(p.name)}</span>`;
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function niceDate(raw) {
    const m = String(raw || "").match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
    return String(raw || "").trim();
  }
  function bar(value, label) {
    const v = Math.max(0, Math.min(100, value));
    return `<span class="home-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(v)}" aria-label="${esc(label)}"><i style="width:${v.toFixed(2)}%"></i></span>`;
  }

  // ---------- navigation (same steps as the app's back/forward handler) ----------
  function go(hash) {
    if (location.hash !== hash) history.pushState(null, "", hash);
    applyRoute();
    scrollTo(0, 0);
    if (S) person ? load() : render();
  }
  const ready = () => new Promise(resolve => {
    const check = () => (S ? resolve() : setTimeout(check, 40));
    check();
  });

  // ---------- counts from the main state (match the sidebar) ----------
  function fromState() {
    if (!S || !S.clusters) return null;
    if (S.matching_building || S.matching_error) return { waiting: true };
    const groups = reviewGroups().filter(c => c.unlabeled);
    const left = reviewLeftovers();
    const strong = left.filter(l => l.suggest[0] && l.suggest[0][1] >= 0.5);
    const likely = {};   // unnamed faces whose best match (40% or more) is this person
    for (const c of groups) {
      const s = c.suggest[0];
      if (s && s[1] >= LIKELY) likely[s[0]] = (likely[s[0]] || 0) + c.unlabeled;
    }
    for (const l of left) if (l.suggest[0] && l.suggest[0][1] >= LIKELY) likely[l.suggest[0][0]] = (likely[l.suggest[0][0]] || 0) + 1;
    return {
      groups, left, strong,
      groupFaces: groups.reduce((a, c) => a + c.unlabeled, 0),
      likely: Object.entries(likely).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6),
    };
  }
  const findTab = re => Object.keys(TAB_PLUGINS).find(k => re.test(k));

  // ---------- sections ----------
  function hero(d) {
    const f = d.faces, p = d.photos, all = pct(f.done, f.total);
    const stat = (label, a, b, unit) => `<div class="home-stat"><dt>${label}</dt>
      <dd><span class="home-stat-num"><b>${fmt(a)}</b> <span>of ${fmt(b)} ${unit}</span></span><em>${Math.floor(pct(a, b))}%</em>
      ${bar(pct(a, b), `${label}: ${Math.floor(pct(a, b))}% named`)}</dd></div>`;
    return `<section class="home-hero" aria-labelledby="home-progress-title">
      <div class="home-hero-main">
        <h2 class="home-label" id="home-progress-title">Faces done</h2>
        <p class="home-big"><b>${fmt(f.done)}</b><span>of ${fmt(f.total)}</span><em>${Math.floor(all)}%</em></p>
        ${bar(all, `${Math.floor(all)}% of all faces done`)}
        <p class="meta home-hero-note">${fmt(f.named)} named and ${fmt(f.ignored)} ignored (strangers, paintings). ${fmt(d.people.named)} ${plural(d.people.named, "person has", "people have")} named faces; ${fmt(d.people.tree)} ${plural(d.people.tree, "is", "are")} in the family tree.</p>
      </div>
      <dl class="home-stats">
        ${stat("Faces in album photos", f.album_named, f.album_total, "named")}
        ${stat("Faces in FamilySearch photos", f.fs_named, f.fs_total, "named")}
        ${stat("Photos fully named", p.fully_named, p.with_faces, "photos with faces")}
      </dl>
    </section>`;
  }

  const stack = ids => `<span class="home-stack" aria-hidden="true">${ids.slice(0, 3).map(id => faceImg(id)).join("")}</span>`;
  const icon = svg => `<span class="home-icon" aria-hidden="true">${svg}</span>`;
  const task = (href, vis, title, sub) => `<li><a class="home-task" href="${esc(href)}" data-home-go>
      <span class="home-task-vis">${vis}</span>
      <span class="home-task-text"><b>${title}</b><span class="meta">${sub}</span></span>${CHEVRON}</a></li>`;
  const pending = text => `<li><div class="home-task is-pending" aria-busy="true"><span class="home-task-vis"><span class="home-skel"></span></span>
      <span class="home-task-text"><b>${text}</b><span class="meta">Counting…</span></span></div></li>`;

  function nextUp(d, st) {
    const rows = [];
    const inbox = d.inbox;
    if (H.importing || inbox.running) {
      rows.push(`<li><div class="home-task" role="status"><span class="home-task-vis">${icon(SVG.inbox)}</span>
        <span class="home-task-text"><b>Importing new photos</b><span class="meta">${inbox.running && inbox.stage ? `${esc(inbox.stage)}${inbox.total > 1 ? ` ${fmt(inbox.done)} of ${fmt(inbox.total)}` : ""}. ` : ""}Progress also shows in the sidebar.</span></span></div></li>`);
    } else if (inbox.count) {
      rows.push(`<li><div class="home-task home-task-inbox"><span class="home-task-vis">${icon(SVG.inbox)}</span>
        <span class="home-task-text"><b>${num(inbox.count)} new ${plural(inbox.count, "photo")} in the Inbox</b>
        <span class="meta">${inbox.count === 1 ? "Find its faces, read its caption and names" : "Find their faces, read captions and names"}, and add ${inbox.count === 1 ? "it" : "them"} to the library.</span></span>
        <button class="btn primary" type="button" data-home-import>Process new photos</button></div></li>`);
    }
    if (!st) {
      rows.push(pending("Unnamed groups"), pending("Leftover faces"));
    } else if (st.waiting) {
      rows.push(`<li><div class="home-task" role="status"><span class="home-task-vis">${icon(SVG.spark)}</span><span class="home-task-text"><b>Building groups for this family branch</b><span class="meta">${S.matching_error ? esc(S.matching_error) : "Counts appear here in a moment."}</span></span></div></li>`);
    } else {
      if (st.groups.length) rows.push(task("#/groups", stack(st.groups.map(c => c.faces[0])),
        `Name ${num(st.groups.length)} ${plural(st.groups.length, "group")}`,
        `${fmt(st.groupFaces)} unnamed ${plural(st.groupFaces, "face")} sorted into look-alike groups`));
      if (st.strong.length) rows.push(task("#/leftovers", stack(st.strong.map(l => l.id)),
        `Check ${num(st.strong.length)} strong ${plural(st.strong.length, "match", "matches")}`,
        `Leftover faces that look at least 50% like someone you’ve named, out of ${fmt(st.left.length)} leftovers`));
      else if (st.left.length) rows.push(task("#/leftovers", stack(st.left.map(l => l.id)),
        `Look through ${num(st.left.length)} leftover ${plural(st.left.length, "face")}`,
        "Faces that didn’t fit a group: blurry, side-on, or someone who appears once"));
    }
    const sug = H.extra.suggest, sugTab = findTab(/^suggest/);
    const sugCount = sug && countOf(sug);
    if (sugCount && (sug.route || sug.href || sugTab)) rows.push(task(sug.route || sug.href || `#/${sugTab}`, icon(SVG.spark),
      `Review ${num(sugCount)} suggested ${plural(sugCount, "name")}`, "Names the app suggests for unnamed faces. Nothing is saved until you confirm."));
    const awaiting = (d.imports || []).filter(b => b.awaiting).sort((a, b) => b.awaiting - a.awaiting)[0];
    if (awaiting) rows.push(task(`#/imports/${enc(awaiting.batch)}?filter=link`, icon(SVG.link),
      `Link ${num(awaiting.awaiting)} ${plural(awaiting.awaiting, "name")} from ${esc(awaiting.batch)}`,
      `Names that came with imported photos. ${awaiting.photos > 500
        ? `This import has ${fmt(awaiting.photos)} photos, so it takes a few seconds to open.`
        : "Pick who each one is so they land on the right person."}`));
    const pairs = H.extra.duplicates?.pairs;
    if (pairs?.length) rows.push(task("#/people/_duplicates", icon(SVG.link),
      `Check ${num(pairs.length)} possible duplicates`,
      "Pairs of names that may be one person. Merge them or mark them as different."));
    if (!rows.length) rows.push(`<li class="home-clear"><b>You’re all caught up.</b> <span class="meta">Every group is named and the Inbox is empty. Explore the Map or Portraits, or drop new scans into the Inbox.</span></li>`);
    return `<section class="home-card home-next" aria-labelledby="home-next-title">
      <div class="home-card-head"><h2 id="home-next-title">Next up</h2></div>
      <ul class="home-tasks">${rows.join("")}</ul></section>`;
  }
  function countOf(x) {
    for (const k of ["count", "total", "pending", "suggestions", "faces", "people", "batches", "items"]) {
      const v = x[k];
      if (typeof v === "number") return v;
      if (Array.isArray(v)) return v.length;
    }
    return 0;
  }
  function albumCard() {
    const p = H.photos[H.pi];
    const head = `<div class="home-card-head"><h2 id="home-album-title">From the albums</h2>
      ${H.photos.length > 1 ? `<button class="btn" type="button" data-home-shuffle aria-label="Show another photo from the albums">${SVG.shuffle}Shuffle</button>` : ""}</div>`;
    if (!p) return `<section class="home-card home-album" aria-labelledby="home-album-title">${head}<div class="empty">No captioned album photos yet.</div></section>`;
    const who = [...new Set(p.names)];
    const bits = [niceDate(p.date), who.length ? `With ${who.slice(0, 4).map(esc).join(", ")}${who.length > 4 ? ` and ${who.length - 4} more` : ""}` : ""].filter(Boolean);
    return `<section class="home-card home-album" aria-labelledby="home-album-title">${head}
      <button class="home-photo" type="button" data-home-photo="${esc(p.path)}" aria-label="Open the photo: ${esc(p.caption)}">
        <img src="/gallery-image/${enc(p.path)}?v=${ver()}" alt="" decoding="async"></button>
      <p class="home-caption">“${esc(p.caption)}”</p>
      ${bits.length ? `<p class="meta home-photo-meta">${bits.join(" · ")}</p>` : ""}
    </section>`;
  }

  function likely(st) {
    const head = `<div class="home-card-head"><h2 id="home-likely-title">Likely matches by person</h2></div>
      <p class="help">Unnamed faces whose best match is one of these people, at 40% or higher. Name them in Groups or Leftover faces.</p>`;
    let body;
    if (!st) body = `<div class="home-skel-list" aria-busy="true">${"<span class=\"home-skel\"></span>".repeat(4)}</div>`;
    else if (st.waiting || !st.likely.length) body = `<p class="empty">${st.waiting ? "Counts appear when the groups are ready." : "No strong matches waiting right now."}</p>`;
    else {
      const max = st.likely[0][1];
      body = `<ol class="home-people">${st.likely.map(([name, n]) => `<li><a class="home-person" href="#/people/${enc(name)}" data-home-go>
        ${avatar({ name, rep: S.reps[name] })}<span class="home-person-name">${esc(name)}</span>
        <span class="home-person-bar" aria-hidden="true"><i style="width:${Math.max(4, (n / max) * 100).toFixed(1)}%"></i></span>
        <span class="home-person-n">${num(n)} <span class="meta">${plural(n, "face")}</span></span></a></li>`).join("")}</ol>`;
    }
    return `<section class="home-card" aria-labelledby="home-likely-title">${head}${body}</section>`;
  }

  function imports(d) {
    const inbox = d.inbox;
    const list = (d.imports || []).slice(0, 3);
    const badge = b => {
      const m = (b.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `<span class="home-date" aria-hidden="true"><b>${+m[3]}</b><span>${MONTHS[+m[2] - 1]}</span></span>` : icon(SVG.inbox);
    };
    const rows = list.map(b => `<li><a class="home-task" href="#/imports/${enc(b.batch)}" data-home-go>
      <span class="home-task-vis">${badge(b)}</span>
      <span class="home-task-text"><b>${esc(b.batch)}</b><span class="meta">${fmt(b.photos)} ${plural(b.photos, "photo")} · ${fmt(b.faces)} ${plural(b.faces, "face")} · ${fmt(b.unnamed)} unnamed${b.awaiting ? ` · ${fmt(b.awaiting)} ${plural(b.awaiting, "name")} to link` : ""}</span></span>${CHEVRON}</a></li>`);
    const note = inbox.running || H.importing ? "An import is running. Progress shows in the sidebar."
      : inbox.count ? `${fmt(inbox.count)} new ${plural(inbox.count, "photo")} waiting in the Inbox.`
      : `Inbox is empty. To add photos, drop them into ${S?.inbox_path || "the Inbox folder"}.`;
    return `<section class="home-card" aria-labelledby="home-imports-title">
      <div class="home-card-head"><h2 id="home-imports-title">Recent imports</h2>${d.imports_total ? `<a class="btn" href="#/imports" data-home-go>All imports</a>` : ""}</div>
      ${rows.length ? `<ul class="home-tasks">${rows.join("")}</ul>` : `<p class="empty">No imports yet.</p>`}
      <p class="meta home-inbox-note">${note}</p></section>`;
  }

  function page() {
    const d = H.data, st = fromState();
    return `<div class="home">${hero(d)}
      ${d.updating ? '<p class="meta" role="status">Updating progress for recent changes…</p>' : ""}<div class="home-cols">${nextUp(d, st)}${albumCard()}</div>
      <div class="home-cols">${likely(st)}${imports(d)}</div></div>`;
  }

  // ---------- drawing and data ----------
  function draw() {
    const main = $("#main");
    if (tab !== "home" || !main) return;
    $("#page-title").textContent = "Home";
    const html = H.data ? page()
      : H.failed ? `<div class="empty" role="alert">Couldn’t load the overview. Check that the app is still running, then <button class="btn" type="button" data-home-retry>Try again</button></div>`
      : `<div class="empty" role="status">Loading your overview…</div>`;
    if (html === H.html && main.firstElementChild && main.firstElementChild.classList.contains("home")) return;
    const open = [...main.querySelectorAll("details[open]")].map(x => x.className);
    const focused = document.activeElement && main.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    H.html = html;
    main.innerHTML = html;
    for (const cls of open) main.querySelector(`details.${cls.split(" ")[0]}`)?.setAttribute("open", "");
    if (focused) main.querySelector(focused)?.focus();
  }
  function focusKey(el) {
    for (const attr of ["data-home-shuffle", "data-home-import", "data-home-photo"]) if (el.hasAttribute(attr)) return `[${attr}]`;
    const href = el.getAttribute("href");
    return href ? `a[href="${CSS.escape(href)}"]` : null;
  }
  function refresh() {
    if (!H.inflight) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      H.inflight = fetch("/api/home", { signal: ctl.signal }).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then(d => {
          H.data = d; H.failed = false;
          H.importing = d.inbox.running;
          if (!H.photos.length) { H.photos = d.album_photos || []; H.pi = 0; preloadNext(); }
          extras(d);
          if (d.updating && tab === "home") setTimeout(() => tab === "home" && refresh(), 2500);
        })
        .catch(() => { H.failed = !H.data; })
        .finally(() => { clearTimeout(timer); H.inflight = null; draw(); });
    }
    return H.inflight;
  }
  function extras(d) {
    const duplicateKey = JSON.stringify(d.key || d.v);
    if (H.extra.duplicatesV !== duplicateKey) {
      H.extra.duplicatesV = duplicateKey;
      fetch("/api/people/duplicates").then(r => r.ok ? r.json() : null)
        .then(x => { H.extra.duplicates = x; draw(); }).catch(() => { H.extra.duplicatesV = null; });
    }
    const route = d.routes && d.routes.suggest;   // only asked for when that add-on exists
    if (!route || H.extra.suggestV === ver()) return;
    H.extra.suggestV = ver();
    fetch(route).then(r => (r.ok ? r.json() : null)).then(x => { H.extra.suggest = x; draw(); }).catch(() => {});
  }

  // ---------- actions ----------
  function preloadNext() {
    const next = H.photos[(H.pi + 1) % H.photos.length];
    if (next) new Image().src = `/gallery-image/${enc(next.path)}?v=${ver()}`;
  }
  async function shuffle() {
    if (H.pi + 1 >= H.photos.length) {
      const current = H.photos[H.pi];
      try {
        const r = await (await fetch(`/api/home/photos?n=40&not=${enc(current ? current.path : "")}`)).json();
        if (r.photos && r.photos.length) { H.photos = r.photos; H.pi = 0; }
      } catch { H.pi = 0; }
    } else H.pi += 1;
    const card = $("#main .home-album");
    if (card) {
      const holder = document.createElement("div");
      holder.innerHTML = albumCard();
      card.replaceWith(holder.firstElementChild);
      H.html = $("#main").innerHTML === H.html ? H.html : "";   // the page changed outside draw()
      $("#main [data-home-shuffle]")?.focus();
    }
    preloadNext();
  }
  async function processInbox(btn) {
    btn.disabled = true;
    const r = await startImport();   // review.html: through the write queue, and this tab is the one that opens the import
    if (r.error) { btn.disabled = false; return; }
    H.importing = true;
    H.html = "";
    draw();
  }
  window.homeProcessInbox = processInbox;

  document.addEventListener("click", async e => {
    const link = e.target.closest("a[data-home-go]");
    if (link) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;   // let the browser open a new tab
      e.preventDefault();
      return go(link.getAttribute("href"));
    }
    if (e.target.closest("[data-home-shuffle]")) return shuffle();
    const photo = e.target.closest("[data-home-photo]");
    if (photo) { await ready(); return openPhotoPath(photo.dataset.homePhoto); }
    const imp = e.target.closest("[data-home-import]");
    if (imp) return processInbox(imp);
    if (e.target.closest("[data-home-retry]")) { H.failed = false; draw(); return refresh(); }
  });

  // ---------- register: Home is the default page ----------
  if (!location.hash || location.hash === "#" || location.hash === "#/") history.replaceState(null, "", "#/home");
  registerTab("home", {
    title: "Home", group: "Name faces", first: true, icon: ICON,
    render() { draw(); refresh(); },
    getRoute() { return { sub: null, params: {} }; },
    setRoute() {},
  });
  // Home sits above the group labels, at the very top of the sidebar.
  const nav = $("#tabs"), btn = nav && nav.querySelector('[data-tab="home"]');
  if (btn) nav.prepend(btn);
  // The main state takes a moment; draw Home from its own fast endpoint right away.
  if (tab === "home" && !S) {
    document.title = "Home · Family Photo Explorer";
    draw();
    refresh();
  }
})();
