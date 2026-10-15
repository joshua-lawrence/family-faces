import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const source=fs.readFileSync(new URL('../family_faces/web/41-tree-view.js',import.meta.url),'utf8');
const doc={people:Object.fromEntries(['Root','Parent','Grandparent','Child','Grandchild','Partner','Distant'].map(n=>[n,{}])),
  parents:[['Parent','Root'],['Grandparent','Parent'],['Root','Child'],['Child','Grandchild']],partners:[['Root','Partner']]};
function context(){const c=vm.createContext({T:structuredClone(doc),tSel:'Root',tab:'tree',homePerson:()=>'Root',TREE_LAST_KEY:'last',S:{},
  localStorage:{getItem:()=>null},document:{listeners:{},addEventListener(type,listener){this.listeners[type]=listener;}},drawTree(){},treeCentre(){},$:()=>null,CSS:{escape:s=>s},esc:String,
  tParents:n=>doc.parents.filter(p=>p[1]===n).map(p=>p[0]),tKids:n=>doc.parents.filter(p=>p[0]===n).map(p=>p[1]),tPartners:n=>doc.partners.filter(p=>p.includes(n)).map(p=>p.find(v=>v!==n))});
  vm.runInContext(source,c);return c;}
test('initial tree shows only parents, children and partner',()=>{const c=context();assert.deepEqual([...c.treeVisibleNames()],['Root','Parent','Child','Partner']);});
test('expansion adds one generation and focus resets the visible branch',()=>{const c=context();c.treeVisibleNames();c.treeExpand('Parent','parents');assert.ok(c.treeVisibleNames().includes('Grandparent'));assert.ok(!c.treeVisibleNames().includes('Distant'));c.treeFocusOn('Child');assert.deepEqual([...c.treeVisibleNames()],['Root','Child','Grandchild']);assert.ok(c.T.people.Distant);});
test('all people and deleted branch root remain usable',()=>{const c=context();c.treeVisibleNames();vm.runInContext('tAllPeople=true',c);assert.equal(c.treeVisibleNames().length,7);delete c.T.people.Root;c.tSel='Child';assert.deepEqual([...c.treeVisibleNames()],['Child','Grandchild']);});
test('layout contains only visible people with finite positions',()=>{const c=context();c.TW=128;c.TH=250;c.TGAP=26;c.UGAP=56;c.VGAP=96;const html=fs.readFileSync(new URL('../family_faces/web/review.html',import.meta.url),'utf8');vm.runInContext(html.slice(html.indexOf('function layoutTree('),html.indexOf('function drawTree(')),c);const names=c.treeVisibleNames();const layout=c.layoutTree(names);assert.deepEqual(Object.keys(layout).sort(),[...names].sort());assert.ok(Object.values(layout).every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));});

test('expansion fits the new branch and restores card focus',()=>{
  const c=context(), calls=[];
  c.drawTree=fit=>calls.push(['draw',fit]);c.treeCentre=()=>calls.push(['centre']);
  c.$=selector=>({focus:options=>calls.push(['focus',selector,options.preventScroll])});
  c.treeVisibleNames();c.treeExpand('Parent','parents');
  assert.equal(calls[0][1],true);assert.equal(calls.filter(row=>row[0]==='centre').length,0);
  assert.ok(calls.at(-1)[1].includes('Parent'));assert.ok(calls.at(-1)[1].endsWith('.tcard-select'));
});
test('focus a relative moves keyboard focus to the new card button',()=>{
  const c=context();let focused;
  c.$=selector=>({focus:()=>focused=selector});c.treeFocusOn('Parent');
  assert.ok(focused.includes('Parent'));assert.ok(focused.endsWith('.tcard-select'));
});
test('single-parent connectors meet the actual card edge',()=>{
  const c=context();c.TW=128;
  const point=c.treeParentAnchor(['Parent'],{Parent:{x:20,y:100}},{Parent:156});
  assert.equal(point.x,84);assert.equal(point.y,255);
  const couple=c.treeParentAnchor(['Parent','Partner'],{Parent:{x:20,y:100},Partner:{x:180,y:100}},{Parent:250,Partner:156});
  assert.equal(couple.x,164);assert.equal(couple.y,148);
});

test('keyboard card selection keeps focus on the selected card',()=>{
  const c=context();let focused;
  c.$=selector=>({focus:()=>focused=selector});
  const button={dataset:{tselect:'Parent'},hasAttribute:attr=>attr==='data-tselect'};
  c.document.listeners.click({detail:0,target:{closest:()=>button}});
  assert.equal(c.tSel,'Parent');assert.ok(focused.includes('Parent'));assert.ok(focused.endsWith('.tcard-select'));
});
