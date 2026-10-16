import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { captureChromeSession, chromeProfiles, decryptCookie, readCookieRows, sessionFromCookies } from '../scripts/chrome-session.mjs';
import { SignInError, waitForBrowserSession } from '../scripts/browser-session.mjs';

const key = pbkdf2Sync('test-password', 'saltysalt', 1003, 16, 'sha1');
function encrypted(value, host = '.familysearch.org', version = 24) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  const plain = version >= 24 ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}
const cookie = (value = 'test-session') => ({ name: 'fssessionid', value });
const page = user => ({ isClosed: () => false, url: () => 'https://www.familysearch.org/en/', evaluate: async () => user });
const user = { displayName: 'Test User', personId: 'ABCD-123' };

test('Chrome cookies support the current domain hash and reject another domain or key', () => {
  for (const version of [23, 24]) {
    assert.equal(decryptCookie({ host_key: '.familysearch.org', encrypted_value: encrypted('test-session', '.familysearch.org', version) }, key, version), 'test-session');
  }
  assert.throws(() => decryptCookie({ host_key: 'example.org', value: 'test' }, key, 24), /not permitted/);
  assert.throws(() => decryptCookie({ host_key: '.familysearch.org', encrypted_value: encrypted('test', 'www.familysearch.org') }, key, 24), /domain check/);
  assert.throws(() => decryptCookie({ host_key: '.familysearch.org', encrypted_value: Buffer.from('v20test') }, key, 24), /not supported/);
});

test('profile discovery prefers the current profile and rejects paths outside Chrome', async t => {
  const base = await mkdtemp(join(tmpdir(), 'familysearch-profile-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(join(base, 'Local State'), JSON.stringify({ profile: { last_used: 'Profile 2', info_cache: { Default: {}, 'Profile 2': {}, '../outside': {} } } }));
  assert.deepEqual(chromeProfiles(base), [join(base, 'Profile 2'), join(base, 'Default')]);
});

test('Chrome reads only unexpired, unpartitioned FamilySearch cookies for the root path', async t => {
  const base = await mkdtemp(join(tmpdir(), 'familysearch-cookies-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const path = join(base, 'Cookies');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      top_frame_site_key TEXT, has_expires INTEGER, expires_utc INTEGER, last_update_utc INTEGER);`);
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('.familysearch.org', 'fssessionid', '', encrypted('test-session'), '/', '', 0, 0, 10);
  insert.run('.familysearch.org', 'expired', 'test', Buffer.alloc(0), '/', '', 1, 1, 9);
  insert.run('.familysearch.org', 'partitioned', 'test', Buffer.alloc(0), '/', 'https://example.org', 0, 0, 8);
  insert.run('.familysearch.org', 'other-path', 'test', Buffer.alloc(0), '/other', '', 0, 0, 7);
  insert.run('.notfamilysearch.org', 'other-site', 'test', Buffer.alloc(0), '/', '', 0, 0, 6);
  db.close();
  assert.deepEqual(readCookieRows(DatabaseSync, path).rows.map(row => row.name), ['fssessionid']);
  await mkdir(join(base, 'Default'));
  await writeFile(join(base, 'Local State'), '{}');
  // Use a separate test profile database, without changing the browser's database.
  const { copyFile } = await import('node:fs/promises');
  await copyFile(path, join(base, 'Default', 'Cookies'));
  const testKey = Buffer.from(key);
  const session = await captureChromeSession(async config => {
    assert.equal(config.sessionId, 'test-session');
    return user;
  }, { base, platform: 'darwin', key: async () => testKey });
  assert.equal(session.userPersonId, user.personId);
  assert.ok(testKey.every(byte => byte === 0));
});

test('a browser session works without the old local storage user record', async () => {
  const context = { pages: () => [page(null)], cookies: async () => [cookie()] };
  const session = await waitForBrowserSession(context, async () => user);
  assert.equal(session.sessionId, 'test-session');
  assert.equal(session.userPersonId, user.personId);
});

test('sign-in in a new tab supplies the user context and still requires validation', async () => {
  const context = { pages: () => [page(null), page(user)], cookies: async () => [cookie()] };
  let calls = 0;
  await waitForBrowserSession(context, async config => {
    calls++;
    assert.equal(config.userPersonId, user.personId);
    return user;
  });
  assert.equal(calls, 1);
});

test('an expired browser cookie waits for the refreshed session', async () => {
  let clock = 0, value = 'expired', checks = 0;
  const context = { pages: () => [page(null)], cookies: async () => [cookie(value)] };
  const session = await waitForBrowserSession(context, async config => {
    checks++;
    if (config.sessionId === 'expired') throw new Error('test 401');
    return user;
  }, { now: () => clock, sleep: async ms => { clock += ms; value = 'fresh'; } });
  assert.equal(session.sessionId, 'fresh');
  assert.equal(checks, 2);
});

test('closed and timed-out windows report a clear retry step', async () => {
  await assert.rejects(waitForBrowserSession({ pages: () => [] }, async () => user), error =>
    error instanceof SignInError && /window was closed/.test(error.message));
  let clock = 0;
  await assert.rejects(waitForBrowserSession({ pages: () => [page(null)], cookies: async () => [] }, async () => user,
    { timeout: 2000, now: () => clock, sleep: async ms => { clock += ms; } }), /timed out/);
  assert.equal(sessionFromCookies([]), null);
});
