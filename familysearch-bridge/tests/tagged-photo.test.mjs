import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FamilySearchSessionClient } from '../build/session-client.js';

const rectangle = { x: .1, y: .2, width: .3, height: .4 };
const tags = [{ personId: 'ABCD-123', rectangle }, { personId: 'EFGH-456', rectangle: { ...rectangle, x: .6 } }];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');

async function setup(t, tagResponse = 204, about = 'https://api.familysearch.org/platform/memories/artifacts/12345', descriptionLink) {
  const directory = await mkdtemp(join(tmpdir(), 'tagged-photo-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'photo.png'); await writeFile(filePath, png);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    if (url.pathname.includes('/card')) {
      const id = url.pathname.split('/').at(-2);
      return Response.json({ id, name: `Person ${id}` });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    assert.equal(options.headers.Cookie, undefined);
    if (url.pathname === '/platform/memories/memories') return new Response(null, { status: 201, headers: { 'x-entity-id': '12345' } });
    if (url.pathname === '/platform/memories/memories/12345') return Response.json({ sourceDescriptions: [{ id: '12345', about, ...(descriptionLink ? { links: { description: { href: descriptionLink } } } : {}) }] });
    if (options.method !== 'POST') return Response.json({ persons: [] });
    if (tagResponse instanceof Error) throw tagResponse;
    return new Response(null, { status: tagResponse });
  });
  return { filePath, calls, client: new FamilySearchSessionClient({ cookies: 'fssessionid=test-session' }) };
}

test('uploads one full photo and creates all selected face tags linked to tree people', async t => {
  const { filePath, calls, client } = await setup(t);
  const result = await client.uploadTaggedPhoto({ filePath, people: tags, title: 'Family photo' });
  assert.equal(result.tagsApplied, true);
  assert.equal(result.memoryId, '12345');
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 2);
  const upload = calls.find(c => c.url.pathname === '/platform/memories/memories');
  assert.deepEqual(Buffer.from(upload.options.body), png);
  const tagging = calls.at(-1);
  assert.equal(tagging.url.pathname, '/platform/memories/memories/12345/personas');
  const { persons } = JSON.parse(tagging.options.body);
  assert.equal(persons.length, 2);
  assert.deepEqual(persons[0].identifiers['http://familysearch.org/v1/FamilyTreePerson'], ['https://familysearch.org/ark:/61903/4:1:ABCD-123']);
  assert.equal(persons[0].names[0].nameForms[0].fullText, 'Person ABCD-123');
  assert.equal(persons[0].media[0].description, 'https://api.familysearch.org/platform/memories/artifacts/12345/description');
  assert.equal(persons[0].media[0].qualifiers[0].value, '0.1,0.2,0.3,0.4');
  assert.equal(tagging.options.redirect, 'manual');
  assert.ok(!JSON.stringify(result).includes('test-session'));
});

test('tagged preview reads each person once and does not send any POST requests', async t => {
  const { filePath, calls, client } = await setup(t);
  const result = await client.uploadTaggedPhoto({ filePath, people: [...tags, tags[0]], dryRun: true });
  assert.equal(result.status, 'ready');
  assert.equal(result.people.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.options.method !== 'POST' && !c.options.body));
});

test('invalid or missing tags stop before any network request', async t => {
  const { filePath, calls, client } = await setup(t);
  for (const people of [[], [{ ...tags[0], rectangle: { ...rectangle, width: 1 } }],
    [{ ...tags[0], rectangle: { ...rectangle, x: NaN } }], [{ ...tags[0], personId: '../bad' }]]) {
    await assert.rejects(client.uploadTaggedPhoto({ filePath, people }));
  }
  assert.equal(calls.length, 0);
});

test('failed face tags return the created Memory and never upload or tag twice', async t => {
  const { filePath, calls, client } = await setup(t, 500);
  const result = await client.uploadTaggedPhoto({ filePath, people: tags });
  assert.equal(result.status, 'partial');
  assert.equal(result.tagsApplied, false);
  assert.equal(result.memoryUrl, 'https://www.familysearch.org/en/memories/memory/12345');
  assert.match(result.note, /Do not upload the photo again/);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 2);
});

test('an uncertain tag write retains the Memory and gives no automatic retry', async t => {
  const { filePath, calls, client } = await setup(t, new Error('private token in a network error'));
  const result = await client.uploadTaggedPhoto({ filePath, people: tags });
  assert.equal(result.status, 'partial');
  assert.match(result.note, /unknown/);
  assert.ok(!result.note.includes('private token'));
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 2);
});

test('untrusted image references do not become tag requests', async t => {
  const { filePath, calls, client } = await setup(t, 204, 'https://example.com/photo?token=test-session');
  const result = await client.uploadTaggedPhoto({ filePath, people: tags });
  assert.equal(result.status, 'partial');
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});

test('a new uploaded photo with a CDN image reference is tagged through its Memory description', async t => {
  const {filePath,calls,client} = await setup(t,204,'https://sg30p0.familysearch.org/photo.jpg','https://api.familysearch.org/platform/memories/memories/12345?flag=fsh');
  const result = await client.uploadTaggedPhoto({filePath,people:tags});
  assert.equal(result.tagsApplied,true);
  const writes = calls.filter(c=>c.options.method==='POST');
  assert.equal(writes.length,2);
  assert.equal(JSON.parse(writes[1].options.body).persons[0].media[0].description,'https://api.familysearch.org/platform/memories/memories/12345');
});
