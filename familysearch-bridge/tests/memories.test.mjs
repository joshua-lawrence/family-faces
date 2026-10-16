import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadMemoryArtifact, memorySummary, memoryType } from '../build/memories.js';
import { FamilySearchSessionClient } from '../build/session-client.js';

const photo = { id: 123, category: 'IMAGE', contentCategory: 'PHOTO', title: 'Family photo', originalFilename: 'photo.jpg' };
const credentials = { cookies: 'fssessionid=test-session', sessionId: 'test-session', userAgent: 'test-agent' };
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });

async function directory(t) {
  const outputDir = await mkdtemp(join(tmpdir(), 'familysearch-download-test-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return outputDir;
}

test('classifies photos, scanned documents, and PDFs; excludes stories and audio', () => {
  assert.equal(memoryType(photo), 'photo');
  assert.equal(memoryType({ ...photo, contentCategory: 'DOCUMENT' }), 'document');
  assert.equal(memoryType({ category: 'PDF' }), 'document');
  assert.equal(memoryType({ category: 'AUDIO' }), null);
  assert.equal(memoryType({ category: 'TEXT' }), null);
  const result = memorySummary({ ...photo, originalUrl: 'https://example.com/?sessionId=secret' });
  assert.equal(result.memoryId, '123');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('lists only photos and documents and applies the selected filter and offset', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.pathname, '/service/memories/presentation/persons/personsByTreePersonId/ABCD-123/artifacts');
    assert.equal(options.headers.Cookie, credentials.cookies);
    return Response.json({ totalArtifactsSpanningPages: 4, artifact: [
      photo, { ...photo, id: 124, contentCategory: 'DOCUMENT' },
      { ...photo, id: 125, category: 'PDF' }, { id: 126, category: 'TEXT' },
    ] });
  });
  const client = new FamilySearchSessionClient(credentials);
  const result = await client.getPersonMemories('ABCD-123', 'document', 1, 1);
  assert.equal(result.totalMatching, 2);
  assert.equal(result.totalMemories, 4);
  assert.deepEqual(result.memories.map(item => item.memoryId), ['125']);
});

test('downloads through the website endpoint with the saved session', async t => {
  const outputDir = await directory(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.pathname.startsWith('/service/')) return Response.json(photo);
    assert.equal(url.pathname, '/memories/orchestration/download/123');
    assert.equal(options.headers.Authorization, 'Bearer test-session');
    assert.equal(options.headers.Cookie, credentials.cookies);
    assert.equal(options.redirect, 'manual');
    return jpeg();
  });
  const result = await new FamilySearchSessionClient(credentials).downloadMemory('123', { outputDir });
  assert.equal(result.bytes, 4);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual([...await readFile(result.path)], [0xff, 0xd8, 0xff, 0xd9]);
});

test('keeps existing files and removes directory traversal from file names', async t => {
  const outputDir = await directory(t);
  t.mock.method(globalThis, 'fetch', async () => jpeg());
  const first = await downloadMemoryArtifact(photo, { ...credentials, outputDir, filename: '../../photo.jpg' });
  const second = await downloadMemoryArtifact(photo, { ...credentials, outputDir, filename: '..\\photo.jpg' });
  assert.equal(first.path, join(outputDir, 'photo.jpg'));
  assert.equal(second.path, join(outputDir, 'photo (1).jpg'));
  assert.equal((await readFile(first.path)).length, 4);
});

test('downloads a PDF document and adds its file extension', async t => {
  const outputDir = await directory(t);
  const document = { id: 124, category: 'PDF', originalFilename: 'Family document' };
  t.mock.method(globalThis, 'fetch', async () => new Response('%PDF-1.7\n', {
    headers: { 'content-type': 'application/pdf; charset=binary' },
  }));
  const result = await downloadMemoryArtifact(document, { ...credentials, outputDir });
  assert.equal(result.filename, 'Family document.pdf');
  assert.equal(result.mimeType, 'application/pdf');
  assert.equal(await readFile(result.path, 'utf8'), '%PDF-1.7\n');
});

test('does not send cookies or bearer tokens to the image CDN', async t => {
  const outputDir = await directory(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://edge.fscdn.org/photo.jpg' } });
    assert.equal(url.hostname, 'edge.fscdn.org');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return jpeg();
  });
  await downloadMemoryArtifact(photo, { ...credentials, outputDir });
  assert.equal(calls, 2);
});

test('downloads the source preview as JPEG while keeping TIFF metadata separate', async t => {
  const outputDir = await directory(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://edge.fscdn.org/preview.jpg');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return jpeg();
  });
  const result = await downloadMemoryArtifact({ ...photo, originalFilename: 'original.tif', thumbMobileUrl: 'https://edge.fscdn.org/preview.jpg' },
    { ...credentials, outputDir, variant: 'preview' });
  assert.equal(result.filename, 'memory-123-preview.jpg');
  assert.equal(result.mimeType, 'image/jpeg');
});

test('rejects a preview URL outside FamilySearch before sending any request', async t => {
  const outputDir = await directory(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  await assert.rejects(downloadMemoryArtifact({ ...photo, thumbUrl: 'https://example.com/photo.jpg' },
    { ...credentials, outputDir, variant: 'preview' }), /FamilySearch server/);
});

test('uses the smaller source image for a thumbnail', async t => {
  const outputDir = await directory(t);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.href, 'https://edge.fscdn.org/small.jpg');
    return jpeg();
  });
  const result = await downloadMemoryArtifact({ ...photo, thumbUrl: 'https://edge.fscdn.org/small.jpg', thumbMobileUrl: 'https://edge.fscdn.org/large.jpg' },
    { ...credentials, outputDir, variant: 'thumbnail' });
  assert.equal(result.filename, 'memory-123-thumbnail.jpg');
});

test('blocks redirects to other hosts, HTTP, or URLs with credentials', async t => {
  const outputDir = await directory(t);
  for (const location of ['https://familysearch.org.attacker.test/file', 'http://www.familysearch.org/file', 'https://user:secret@www.familysearch.org/file']) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location } });
    });
    await assert.rejects(downloadMemoryArtifact(photo, { ...credentials, outputDir }), /HTTPS on a FamilySearch server/);
    assert.equal(calls, 1);
    mock.mock.restore();
  }
  assert.deepEqual(await readdir(outputDir), []);
});

test('reports access denial without saving the response body', async t => {
  const outputDir = await directory(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('private server error', { status: 403 }));
  await assert.rejects(downloadMemoryArtifact(photo, { ...credentials, outputDir }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.ok(!error.message.includes('private server error'));
    return true;
  });
  assert.deepEqual(await readdir(outputDir), []);
});

test('rejects login pages and files over the announced size limit', async t => {
  const outputDir = await directory(t);
  let mock = t.mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(downloadMemoryArtifact(photo, { ...credentials, outputDir }), /did not return an image/);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response('data', { headers: { 'content-type': 'application/pdf', 'content-length': String(100 * 1024 * 1024 + 1) } }));
  await assert.rejects(downloadMemoryArtifact(photo, { ...credentials, outputDir }), /100 MB/);
  assert.deepEqual(await readdir(outputDir), []);
});

test('removes partial files when the stream exceeds the size limit or fails', async t => {
  const outputDir = await directory(t);
  let mock = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100 * 1024 * 1024 + 1)); controller.close(); },
  }), { headers: { 'content-type': 'image/jpeg' } }));
  await assert.rejects(downloadMemoryArtifact(photo, { ...credentials, outputDir }), /100 MB/);
  assert.deepEqual(await readdir(outputDir), []);
  mock.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('Connection stopped')); },
  }), { headers: { 'content-type': 'image/jpeg' } }));
  await assert.rejects(downloadMemoryArtifact(photo, { ...credentials, outputDir }), /Connection stopped/);
  assert.deepEqual(await readdir(outputDir), []);
});
