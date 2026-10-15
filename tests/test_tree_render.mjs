import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';

const html = fs.readFileSync(new URL('../review.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('let TVERSION ='), html.indexOf('async function saveTree()'));
assert.ok(source.includes('async function renderTree('));

function page() {
  const response = {tree: {people: {Root: {}}, parents: [], partners: []}, version: 'one',
    reps: {Root: 1}, source_reps: {}, sex: {}, ids: {}};
  const main = {writes: 0, set innerHTML(value) { this.writes++; context.stage = {}; }};
  const context = vm.createContext({response, stage: null, drawn: 0, requests: [],
    S: {v: 1, people: {Root: 1}}, tab: 'tree', tSel: null, tView: {},
    T: null, TREPS: {}, TSOURCE: {}, TSEX: {}, TIDS: {}, tDropRel: 'ask',
    esc: String, toast() {}, wireTree() {},
    $: selector => selector === '#main' ? main : selector === '#tree-stage' ? context.stage : null,
    fetch: async () => ({json: async () => structuredClone(context.response)}),
    drawTree() { context.drawn++; vm.runInContext('tShown = tSel', context); },
  });
  vm.runInContext(source, context);
  return {context, main, render: (...args) => context.renderTree(...args)};
}

test('repeated refreshes retain the tree DOM, view, and unfinished input', async () => {
  const p = page();
  await p.render();
  const stage = p.context.stage;
  stage.draft = 'Unfinished name';
  p.context.tView.x = 123;
  for (let i = 0; i < 5; i++) await p.render();
  assert.equal(p.main.writes, 1);
  assert.equal(p.context.drawn, 1);
  assert.equal(p.context.stage, stage);
  assert.equal(p.context.stage.draft, 'Unfinished name');
  assert.equal(p.context.tView.x, 123);
});

test('tree changes, photo changes, and people counts still redraw', async () => {
  const p = page();
  await p.render();
  p.context.response.tree.people.Root.born = '1900';
  p.context.response.version = 'two';
  await p.render();
  p.context.response.reps.Root = 2;
  await p.render();
  p.context.S.people.Root = 3;
  await p.render();
  p.context.S.v = 2;
  await p.render();
  assert.equal(p.main.writes, 5);
});

test('failed saves restore the server tree even if its response is unchanged', async () => {
  const p = page();
  await p.render();
  p.context.T.people.Root.born = 'unsaved';
  await p.render(true);
  assert.equal(p.context.T.people.Root.born, undefined);
  assert.equal(p.main.writes, 2);
});

test('opening the tree again and following a person link redraw', async () => {
  const p = page();
  await p.render();
  p.context.stage = null;
  await p.render();
  p.context.tSel = 'Root';
  await p.render();
  assert.equal(p.main.writes, 3);
});

test('an older response cannot replace a newer tree', async () => {
  const p = page();
  const resolve = [];
  p.context.fetch = () => new Promise(done => resolve.push(done));
  const old = p.render();
  const current = p.render();
  resolve[1]({json: async () => structuredClone(p.context.response)});
  await current;
  const stale = structuredClone(p.context.response);
  stale.version = 'stale';
  stale.tree.people.Old = {};
  resolve[0]({json: async () => stale});
  await old;
  assert.equal(p.main.writes, 1);
  assert.equal(p.context.T.people.Old, undefined);
});

test('a response after leaving the tree does not replace the other page', async () => {
  const p = page();
  p.context.tab = 'home';
  await p.render();
  assert.equal(p.main.writes, 0);
});
