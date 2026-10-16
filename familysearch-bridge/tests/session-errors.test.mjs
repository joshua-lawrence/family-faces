import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FamilySearchSessionClient, FamilySearchSessionError } from '../build/session-client.js';

const client = () => new FamilySearchSessionClient({ cookies: 'fssessionid=test-session' });

test('empty and non-JSON 401 responses explain the saved-session failure', async t => {
  for (const body of ['', '{}', '<html>private error page</html>', '{"message":"private server text"}']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 401 }));
    await assert.rejects(client().getPersonCard('ABCD-123'), error => {
      assert.ok(error instanceof FamilySearchSessionError);
      assert.equal(error.statusCode, 401);
      assert.match(error.message, /saved session \(HTTP 401\)/);
      assert.match(error.message, /Sign in/);
      assert.ok(!error.message.includes('private'));
      return true;
    });
    t.mock.restoreAll();
  }
});

test('failed session validation does not hide 401 behind a second request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{}', { status: 401 });
  });
  await assert.rejects(client().validateSession({ personId: 'ABCD-123' }), /HTTP 401/);
  assert.equal(calls, 1);
});

test('empty and non-JSON failures keep the HTTP status without exposing the body', async t => {
  for (const [status, body] of [[500, '{}'], [400, '<html>private error page</html>'], [403, '']]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
    await assert.rejects(client().getPersonCard('ABCD-123'), error => {
      assert.equal(error.statusCode, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.notEqual(error.message, '{}');
      assert.ok(!error.message.includes('private'));
      return true;
    });
    t.mock.restoreAll();
  }
});

test('FamilySearch security failures retain a clear cookie-refresh instruction', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ errorCode: 15 }, { status: 403 }));
  await assert.rejects(client().getPersonCard('ABCD-123'), /security \(error 15\)/);
});

test('an unauthorized JSON result uses the same saved-session message', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'UNAUTHORIZED' }));
  await assert.rejects(client().getPersonCard('ABCD-123'), /saved session \(HTTP 401\)/);
});

test('a rejected person check sends no photo or tag write', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'familysearch-session-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'photo.png');
  await writeFile(filePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=', 'base64'));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response('{}', { status: 401 });
  });
  const options = { filePath, people: [{ personId: 'ABCD-123', rectangle: { x: .1, y: .1, width: .2, height: .2 } }] };
  await assert.rejects(client().uploadTaggedPhoto({ ...options, dryRun: true }), /HTTP 401/);
  await assert.rejects(client().uploadTaggedPhoto(options), /HTTP 401/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ url, options }) => url.pathname.endsWith('/card') && options.method !== 'POST'));
});
