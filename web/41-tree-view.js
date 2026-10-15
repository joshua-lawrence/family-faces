// Family tree / Operate: show nearby family, then expand one generation at a time.
let tVisible = null, tFocus = null, tAllPeople = false;
function familyBranchNames(doc, root) {
  const visible = new Set(root && doc.people[root] ? [root] : []);
  for (const [parent, child] of doc.parents) {
    if (child === root) visible.add(parent);
    if (parent === root) visible.add(child);
  }
  for (const [a, b] of doc.partners) {
    if (a === root) visible.add(b);
    if (b === root) visible.add(a);
  }
  return visible;
}
function treeBranchRoot() {
  let last; try {last = localStorage.getItem(TREE_LAST_KEY);} catch {}
  return [tSel, tFocus, last, homePerson(), S.people_default_root].find(n=>n && T.people[n]) || Object.keys(T.people)[0];
}
function treeVisibleNames(start = false) {
  if (start || !tVisible || !T.people[tFocus]) {
    tFocus = treeBranchRoot(); tVisible = familyBranchNames(T,tFocus); tAllPeople = false;
  }
  return Object.keys(T.people).filter(n=>tAllPeople || tVisible.has(n));
}
function treeFocusCard(name) {
  $(`.tcard[data-tname="${CSS.escape(name)}"] .tcard-select`)?.focus({preventScroll:true});
}
function treeParentAnchor(parents, layout, heights) {
  const points = parents.map(name=>layout[name]);
  return {x: points.reduce((sum,p)=>sum+p.x+TW/2,0)/points.length,
    y: parents.length === 2 && Math.abs(points[0].y-points[1].y)<1 ? points[0].y+48 :
      Math.max(...parents.map(name=>layout[name].y+heights[name]-1))};
}
function treeFocusOn(name) {
  if (!T.people[name]) return;
  tSel = tFocus = name; tVisible = familyBranchNames(T,name); tAllPeople = false;
  drawTree(false); treeCentre(name,true); treeFocusCard(name);
}
function treeExpandControls(name) {
  if (tAllPeople) return '';
  return `<div class="tcard-expand">${[['parents',tParents(name)],['children',tKids(name)]].map(([kind, relatives])=>{
    const count = relatives.filter(n=>!tVisible.has(n)).length;
    return count ? `<button type="button" data-texpand="${kind}" data-twho="${esc(name)}" aria-label="Show ${name === tFocus ? 'more ' : ''}${kind} of ${esc(name)}">${kind === 'parents' ? 'Parents' : 'Children'} +${count}</button>` : '';
  }).join('')}</div>`;
}
function treeExpand(name, kind) {
  const relatives = kind === 'parents' ? tParents(name) : tKids(name);
  for (const n of relatives) {tVisible.add(n); for (const partner of tPartners(n)) tVisible.add(partner);}
  tSel = name; drawTree(true); treeFocusCard(name);
}
function treeBranchTools(names) {
  const all = $('#tree-all'), count = $('#tree-visible-count');
  if (all) {all.textContent = tAllPeople ? 'Show nearby family' : `Show all ${Object.keys(T.people).length} people`; all.setAttribute('aria-pressed',String(tAllPeople));}
  if (count) count.textContent = `${names.length} of ${Object.keys(T.people).length} people shown`;
}
document.addEventListener('click',e=>{
  if (tab !== 'tree') return;
  const b=e.target.closest('[data-texpand],[data-tgoto],[data-tfocus],[data-tselect],#tree-all,#tree-reset');
  if (!b) return;
  if (b.dataset.texpand) return treeExpand(b.dataset.twho,b.dataset.texpand);
  if (b.dataset.tgoto) return treeFocusOn(b.dataset.tgoto);
  if (b.hasAttribute('data-tfocus')) return treeFocusOn(tSel);
  if (b.id === 'tree-reset') return treeFocusOn(tFocus || treeBranchRoot());
  if (b.id === 'tree-all') {
    if (tAllPeople) treeFocusOn(tSel || tFocus || treeBranchRoot());
    else {tAllPeople = true; drawTree(true);}
  }
  if (b.hasAttribute('data-tselect') && e.detail === 0) {tSel=b.dataset.tselect; drawTree(false); treeCentre(tSel,true); treeFocusCard(tSel);}
});
