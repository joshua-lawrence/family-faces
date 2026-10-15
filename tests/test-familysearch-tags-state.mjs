import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const nodes = new Map();
for (const key of ['reload', 'connect', 'cancel', 'check', 'send', 'message', 'preview', 'connection']) {
  nodes.set(`[data-fst-${key}]`, {
    disabled: false, hidden: false, textContent: '', innerHTML: '',
    classList: { toggle() {} },
    closest(selector) { return selector.includes(`[data-fst-${key}]`) ? this : null; },
  });
}
const checkbox = { checked: true, disabled: false, dataset: { fstFace: '1' } };
const personId = { value: 'ABCD-123', disabled: false };
nodes.set('[data-fst-id="1"]', personId);
const listeners = new Map();
const host = {
  isConnected: true, innerHTML: '', hidden: true,
  addEventListener(kind, handler) { listeners.set(kind, handler); },
  removeEventListener(kind) { listeners.delete(kind); },
  setAttribute() {}, contains() { return true; }, closest() { return { open: true }; },
  querySelector(selector) { return nodes.get(selector); },
  querySelectorAll(selector) {
    return selector.endsWith(':checked') ? (checkbox.checked ? [checkbox] : []) : [checkbox, personId];
  },
};
const calls = [];
let finishPreview, finishConfirm;
const pendingPreview = new Promise(resolve => { finishPreview = resolve; });
const pendingConfirm = new Promise(resolve => { finishConfirm = resolve; });
const context = vm.createContext({
  window: {}, document: {}, S: { v: 1 }, esc: String,
  setTimeout, clearTimeout,
  fetch: async (url, options) => {
    calls.push({ url, body: options?.body && JSON.parse(options.body) });
    let data;
    if (url.includes('/photo?')) data = { memoryId: '12345', memoryUrl: 'https://www.familysearch.org/en/memories/memory/12345', faces: [{ id: 1, number: 1, name: 'Known person', personId: 'ABCD-123' }] };
    else if (url.includes('familysearch-connection')) data = { status: 'connected', connected: true, note: 'Connected' };
    else if (url.endsWith('/preview')) data = await pendingPreview;
    else if (url.endsWith('/confirm')) data = await pendingConfirm;
    else throw new Error('Unexpected request');
    return { ok: true, json: async () => data };
  },
});
vm.runInContext(await readFile(process.argv[2] || new URL('../family_faces/web/53-familysearch-tags.js', import.meta.url), 'utf8'), context);
context.window.FamilySearchTags.mount(host, 'photo.png');
const click = key => listeners.get('click')({ target: nodes.get(`[data-fst-${key}]`) });
await click('reload');
await new Promise(resolve => setImmediate(resolve));
const check = click('check');
assert.equal(nodes.get('[data-fst-reload]').disabled, true);
const readsBefore = calls.filter(call => call.url.includes('/photo?')).length;
await click('reload');
await click('check');
assert.equal(calls.filter(call => call.url.includes('/photo?')).length, readsBefore);
assert.equal(calls.filter(call => call.url.endsWith('/preview')).length, 1);
finishPreview({ previewToken: 'token', people: [{ personId: 'ABCD-123', personName: 'Known person' }], tagActions: [{ action: 'create' }] });
await check;
assert.equal(nodes.get('[data-fst-reload]').disabled, false);
const confirm = click('send');
assert.equal(context.window.FamilySearchTags.isSubmitting(), true);
assert.equal(nodes.get('[data-fst-reload]').disabled, true);
await click('reload');
await click('check');
await click('send');
assert.equal(calls.filter(call => call.url.includes('/photo?')).length, readsBefore);
assert.equal(calls.filter(call => call.url.endsWith('/preview')).length, 1);
assert.equal(calls.filter(call => call.url.endsWith('/confirm')).length, 1);
assert.match(nodes.get('[data-fst-message]').textContent, /Submitting/);
finishConfirm({ tagsApplied: true });
await confirm;
assert.equal(context.window.FamilySearchTags.isSubmitting(), false);
assert.equal(nodes.get('[data-fst-reload]').disabled, false);
assert.equal(nodes.get('[data-fst-send]').disabled, true);
assert.equal(nodes.get('[data-fst-message]').textContent, 'Tags confirmed in FamilySearch. No photo was uploaded.');
console.log('PASS: delayed preview and confirm block reload and duplicate actions; final status remains visible.');
