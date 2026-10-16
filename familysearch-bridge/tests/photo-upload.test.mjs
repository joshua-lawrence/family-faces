import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_PHOTO_BYTES, preparePhotoUpload } from '../build/photo-upload.js';
import { FamilySearchSessionClient } from '../build/session-client.js';

const personId = 'ABCD-123';
const person = { id: personId, name: 'Test Ancestor' };
const credentials = { cookies: 'fssessionid=test-session' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64');

async function photoFile(t, filename = 'photo.png', bytes = png) {
  const dir = await mkdtemp(join(tmpdir(), 'familysearch-upload-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, filename);
  await writeFile(filePath, bytes);
  return filePath;
}

function requests(t, upload) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (options.method !== 'POST') {
      assert.equal(url.pathname, `/service/tree/tree-data/v8/person/${personId}/card`);
      assert.equal(options.headers.Cookie, credentials.cookies);
      return Response.json(person);
    }
    return upload(url, options);
  });
  return calls;
}

test('uploads the selected photo once and attaches it with the combined person endpoint', async t => {
  const filePath = await photoFile(t, '祖母 "photo".png');
  const calls = requests(t, async (url, options) => {
    assert.equal(url.origin, 'https://api.familysearch.org');
    assert.equal(url.pathname, `/platform/tree/persons/${personId}/memories`);
    assert.equal(url.searchParams.get('personName'), person.name);
    assert.equal(url.searchParams.get('type'), 'Photo');
    assert.equal(url.searchParams.get('title'), 'Wedding');
    assert.equal(url.searchParams.get('description'), 'An album photo');
    assert.equal(url.searchParams.get('filename'), '祖母 "photo".png');
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers['Content-Type'], 'image/png');
    assert.match(options.headers['Content-Disposition'], /filename\*=UTF-8''/);
    assert.equal(options.redirect, 'manual');
    assert.deepEqual(Buffer.from(options.body), png);
    return new Response(null, { status: 201, headers: { 'x-entity-id': '12345' } });
  });
  const result = await new FamilySearchSessionClient(credentials).uploadPersonPhoto({
    personId: 'abcd-123', filePath, title: 'Wedding', description: 'An album photo',
  });
  assert.equal(calls.length, 2);
  assert.equal(result.attachedToPerson, true);
  assert.equal(result.memoryId, '12345');
  assert.equal(result.memoryUrl, 'https://www.familysearch.org/en/memories/memory/12345');
  assert.equal(result.sha256.length, 64);
  assert.equal(result.bytes, png.length);
  assert.deepEqual(await readFile(filePath), png);
  assert.ok(!JSON.stringify(result).includes('test-session'));
});

test('dry run validates the person and photo without sending any photo bytes', async t => {
  const filePath = await photoFile(t);
  const calls = requests(t, () => { throw new Error('must not upload'); });
  const result = await new FamilySearchSessionClient(credentials).uploadPersonPhoto({ personId, filePath, dryRun: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(result.status, 'ready');
  assert.equal(result.dryRun, true);
  assert.equal(result.personName, person.name);
  assert.equal(result.title, 'photo');
  assert.equal(result.memoryId, undefined);
});

test('validates file type, content, size, and person ID before requesting FamilySearch', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not request'); });
  const filePath = await photoFile(t);
  const client = new FamilySearchSessionClient(credentials);
  await assert.rejects(client.uploadPersonPhoto({ personId: '../../other', filePath }), /person ID/);
  await assert.rejects(client.uploadPersonPhoto({ personId, filePath: 'https://example.com/photo.png' }), /absolute local/);
  const empty = await photoFile(t, 'empty.png', Buffer.alloc(0));
  await assert.rejects(client.uploadPersonPhoto({ personId, filePath: empty }), /non-empty/);
  const pdf = await photoFile(t, 'document.pdf', Buffer.from('%PDF-1.7'));
  await assert.rejects(client.uploadPersonPhoto({ personId, filePath: pdf }), /JPEG, PNG, TIFF, or BMP/);
  const falsePhoto = await photoFile(t, 'document.jpg', Buffer.from('%PDF-1.7'));
  await assert.rejects(client.uploadPersonPhoto({ personId, filePath: falsePhoto }), /content does not match/);
  const big = await photoFile(t, 'large.png');
  await truncate(big, MAX_PHOTO_BYTES + 1);
  await assert.rejects(client.uploadPersonPhoto({ personId, filePath: big }), /15 MB/);
  await assert.rejects(client.uploadPersonPhoto({ personId, filePath, title: ' ' }), /title/);
});

test('accepts the supported photo signatures and rejects a mismatched extension', async t => {
  for (const [filename, bytes, mime] of [
    ['photo.jpg', Buffer.from([255, 216, 255, 217]), 'image/jpeg'],
    ['photo.tif', Buffer.from([73, 73, 42, 0]), 'image/tiff'],
    ['photo.tiff', Buffer.from([77, 77, 0, 42]), 'image/tiff'],
    ['photo.bmp', Buffer.from('BMimage'), 'image/bmp'],
  ]) {
    const filePath = await photoFile(t, filename, bytes);
    assert.equal((await preparePhotoUpload({ personId, filePath })).mimeType, mime);
  }
  const filePath = await photoFile(t, 'wrong.jpg', png);
  await assert.rejects(preparePhotoUpload({ personId, filePath }), /content does not match/);
});

test('stops if the selected person is missing or has changed IDs', async t => {
  const filePath = await photoFile(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.notEqual(options.method, 'POST');
    return Response.json({ id: 'OTHR-456', name: 'Different person' });
  });
  await assert.rejects(new FamilySearchSessionClient(credentials).uploadPersonPhoto({ personId, filePath }), /did not confirm/);
  assert.equal(calls, 1);
});

test('does not follow an upload redirect or expose a server response body', async t => {
  const filePath = await photoFile(t);
  const calls = requests(t, () => new Response('test-session private server body', {
    status: 307, headers: { location: 'https://example.com/?token=test-session' },
  }));
  await assert.rejects(new FamilySearchSessionClient(credentials).uploadPersonPhoto({ personId, filePath }), error => {
    assert.match(error.message, /HTTP 307/);
    assert.ok(!error.message.includes('test-session'));
    assert.ok(!error.message.includes('private server body'));
    return true;
  });
  assert.equal(calls.length, 2);
});

test('does not retry after a network failure or an uncertain server failure', async t => {
  const filePath = await photoFile(t);
  const calls = requests(t, () => { throw new Error('secret request detail'); });
  await assert.rejects(new FamilySearchSessionClient(credentials).uploadPersonPhoto({ personId, filePath }), /result is unknown/);
  assert.equal(calls.length, 2);
  t.mock.restoreAll();
  const failed = requests(t, () => new Response('private', { status: 500 }));
  await assert.rejects(new FamilySearchSessionClient(credentials).uploadPersonPhoto({ personId, filePath }), /result is unknown/);
  assert.equal(failed.length, 2);
});

test('reads a created Memory ID from Location and reports missing IDs without retrying', async t => {
  const filePath = await photoFile(t);
  const calls = requests(t, () => new Response(null, { status: 201, headers: {
    location: '/platform/memories/memories/12345',
  } }));
  const client = new FamilySearchSessionClient(credentials);
  assert.equal((await client.uploadPersonPhoto({ personId, filePath })).memoryId, '12345');
  assert.equal(calls.length, 2);
  t.mock.restoreAll();
  const missing = requests(t, () => new Response(null, { status: 201, headers: {
    location: 'https://example.com/?secret=test-session',
  } }));
  const result = await client.uploadPersonPhoto({ personId, filePath });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.memoryId, null);
  assert.equal(result.memoryUrl, null);
  assert.match(result.note, /returned no Memory ID/);
  assert.ok(!JSON.stringify(result).includes('test-session'));
  assert.equal(missing.length, 2);
});
