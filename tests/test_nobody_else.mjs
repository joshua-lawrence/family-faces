import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(process.argv[2] || new URL('../web/30-viewer.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function nobodyElse()');
const end = source.indexOf('  // ---------- caption and date ----------', start);
assert.ok(start >= 0 && end > start);

function fixture(reply, blocked = false) {
  const info = { path: 'photo.jpg', faces: [
    { id: 1, name: 'Known person' }, { id: 2, name: null },
    { id: 3, name: null }, { id: 4, name: '_ignore' },
  ] };
  const V = { info, path: info.path, req: 1, ignoring: false, infoCache: new Map() };
  const status = { textContent: '', focus() {} };
  const buttons = [{ disabled: false }, { disabled: false }];
  const calls = [];
  const context = {
    V, IGNORE: '_ignore', REACH_ERROR: 'Could not reach the app.',
    blockedByEdits: () => blocked, q: () => status,
    dlg: { open: true, querySelectorAll: () => buttons, focus() {} },
    postJSON: async (...args) => { calls.push(args); return typeof reply === 'function' ? reply() : reply; },
    refreshInfo: async () => {}, renderFaces() {}, drawBoxes() {}, renderStatus() {},
    plural: (n, name) => `${n} ${name}${n === 1 ? '' : 's'}`,
  };
  const action = vm.runInNewContext(`(${source.slice(start, end).trim()})`, context);
  return { action, V, calls, buttons, context };
}

const success = fixture({ named: [2, 3], history: { id: 42 } });
await success.action();
assert.equal(success.calls.length, 1);
assert.equal(success.calls[0][0], '/api/label');
assert.deepEqual(JSON.parse(JSON.stringify(success.calls[0][1])), { faces: [2, 3], name: '_ignore', only_unnamed: true });
assert.deepEqual(success.V.info.faces.map(face => face.name), ['Known person', '_ignore', '_ignore', '_ignore']);
assert.equal(success.V.undo.id, 42);
assert.equal(success.V.undo.canUndo, true);
assert.equal(success.V.undo.message, '2 faces ignored. Existing names were kept.');
await success.action();
assert.equal(success.calls.length, 1);

const draft = fixture({ named: [2, 3] }, true);
await draft.action();
assert.equal(draft.calls.length, 0);

let finish;
const waiting = fixture(() => new Promise(resolve => { finish = resolve; }));
const pending = waiting.action();
assert.equal(waiting.V.ignoring, true);
assert.ok(waiting.buttons.every(button => button.disabled));
await waiting.action();
assert.equal(waiting.calls.length, 1);
waiting.V.info.faces[2].name = 'Name saved in another tab';
finish({ named: [2], history: { id: 43 } });
await pending;
assert.equal(waiting.V.ignoring, false);
assert.equal(waiting.V.info.faces[2].name, 'Name saved in another tab');
assert.equal(waiting.V.undo.message, '1 face ignored. Existing names were kept.');

const failure = fixture({ error: 'Disk is full', status: 400 });
await failure.action();
assert.equal(failure.V.ignoring, false);
assert.equal(failure.V.undo.warn, true);
assert.match(failure.V.undo.message, /Disk is full/);
assert.deepEqual(failure.V.info.faces.map(face => face.name), ['Known person', null, null, '_ignore']);
console.log('PASS: one undoable write; existing and concurrent names stay set; double clicks, drafts, and save errors are handled.');
