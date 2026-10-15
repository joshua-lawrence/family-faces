// Four places to go instead of fifteen: People, Review, Photos and Family in the sidebar, with Library
// (home, imports, history) at the bottom. Each section's pages show as a row of tabs above the page.
// The page buttons in nav#tabs stay the source of truth (every add-on registers there); this file only
// groups them, so routing, counts and keyboard focus work as before.
(() => {
  const tabs = document.querySelector('nav#tabs'), head = document.querySelector('.page-head');
  if (!tabs || !head) return;
  const SECTIONS = [
    { id: 'people', title: 'People', pages: ['people', 'portraits', 'face-similarity'],
      icon: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.8 3.4-6 6.5-6s5.7 2.2 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14c1.6.8 2.7 2.8 3 6"/>' },
    { id: 'review', title: 'Review', pages: ['suggest', 'groups', 'leftovers', 'check'], badgeFrom: 'groups',
      icon: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M14.5 17.5l2 2 4-4.5"/>' },
    { id: 'photos', title: 'Photos', pages: ['gallery', 'timeline', 'map'],
      icon: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>' },
    { id: 'family', title: 'Family', pages: ['tree'],
      icon: '<rect x="9" y="3" width="6" height="5" rx="1.5"/><rect x="3" y="16" width="6" height="5" rx="1.5"/><rect x="15" y="16" width="6" height="5" rx="1.5"/><path d="M12 8v4M6 16v-2h12v2"/>' },
    { id: 'library', title: 'Library', pages: ['home', 'imports', 'history'], bottom: true,
      icon: '<path d="M4 19V5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>' },
  ];
  const sectionOf = page => SECTIONS.find(s => s.pages.includes(page)) || SECTIONS.find(s => s.id === 'library');
  const last = {};   // the page last open in each section, so returning to a section lands where you were

  const nav = document.createElement('nav');
  nav.id = 'sections';
  nav.setAttribute('aria-label', 'Sections');
  const spacer = document.createElement('div');
  spacer.className = 'sections-spacer';
  for (const s of SECTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.section = s.id;
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${s.icon}</svg><span class="lbl">${s.title}</span><span class="count"></span>`;
    if (s.bottom) nav.append(spacer);
    nav.append(b);
  }
  tabs.before(nav);
  tabs.setAttribute('aria-label', 'Pages in this section');
  head.after(tabs);   // the section's pages become tabs above the page

  const button = page => tabs.querySelector(`button[data-tab="${page}"]`);
  const current = () => tabs.querySelector('button[data-tab].on')?.dataset.tab || (typeof tab !== 'undefined' ? tab : '');

  function sync() {
    const page = current(), section = sectionOf(page);
    if (page) last[section.id] = page;
    for (const b of tabs.querySelectorAll('button[data-tab]')) b.hidden = sectionOf(b.dataset.tab) !== section;
    const want = section.pages.map(button).filter(Boolean);   // the section's own order, whatever order pages registered in
    const have = [...tabs.querySelectorAll('button[data-tab]')].filter(b => want.includes(b));
    if (want.some((b, i) => have[i] !== b)) tabs.append(...want);
    const shown = [...tabs.querySelectorAll('button[data-tab]')].filter(b => !b.hidden);
    tabs.classList.toggle('single', shown.length < 2);
    for (const b of nav.querySelectorAll('button[data-section]')) {
      const on = b.dataset.section === section.id;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      const s = SECTIONS.find(x => x.id === b.dataset.section);
      const from = s.badgeFrom ? button(s.badgeFrom)?.querySelector('.count')?.textContent.trim() : '';
      const count = b.querySelector('.count');
      count.textContent = from && from !== '0' ? from : '';
      count.classList.toggle('badge', Boolean(s.badgeFrom && count.textContent));
    }
  }

  nav.addEventListener('click', e => {
    const b = e.target.closest('button[data-section]');
    if (!b) return;
    const s = SECTIONS.find(x => x.id === b.dataset.section);
    const target = [last[s.id], ...s.pages].map(button).find(Boolean);
    if (target && !target.classList.contains('on')) target.click();
    else sync();
  });
  new MutationObserver(() => requestAnimationFrame(sync)).observe(tabs,
    { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  addEventListener('hashchange', () => requestAnimationFrame(sync));
  sync();

  // FamilySearch controls only when the app has been connected to FamilySearch (see config.py).
  const fs = () => document.body.classList.toggle('no-familysearch', typeof S !== 'undefined' && S && S.familysearch_enabled === false);
  const brand = () => {
    const el = document.querySelector('#brand-library');
    if (el && typeof S !== 'undefined' && S && S.library_name) el.textContent = S.library_name;
  };
  const wait = setInterval(() => {
    if (typeof S === 'undefined' || !S) return;
    clearInterval(wait);
    fs(); brand(); sync();
  }, 200);
})();
