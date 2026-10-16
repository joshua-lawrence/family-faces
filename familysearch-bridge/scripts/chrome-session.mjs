import { execFile } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const hosts = new Set(['.familysearch.org', 'familysearch.org', 'www.familysearch.org']);

export function chromeProfiles(base) {
  let profile;
  try {
    profile = JSON.parse(readFileSync(join(base, 'Local State'), 'utf8')).profile;
  } catch {
    return [join(base, 'Default')];
  }
  const names = [profile?.last_used, ...Object.keys(profile?.info_cache || {}), 'Default'];
  return [...new Set(names)].filter(name => /^(Default|Profile \d+)$/.test(name || '')).map(name => join(base, name));
}

export function decryptCookie(row, key, version) {
  if (!hosts.has(row.host_key)) throw new Error('The cookie domain is not permitted.');
  if (row.value && !row.encrypted_value?.length) return row.value;
  const encrypted = Buffer.from(row.encrypted_value || []);
  if (encrypted.subarray(0, 3).toString() !== 'v10') throw new Error('The cookie encryption is not supported.');
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  try {
    if (version >= 24) {
      const hash = createHash('sha256').update(row.host_key).digest();
      if (!plain.subarray(0, 32).equals(hash)) throw new Error('The cookie domain check failed.');
      return plain.subarray(32).toString('utf8');
    }
    return plain.toString('utf8');
  } finally {
    plain.fill(0);
  }
}

export function sessionFromCookies(cookies, user) {
  const session = cookies.find(cookie => cookie.name === 'fssessionid');
  if (!session?.value) return null;
  return {
    cookies: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
    sessionId: session.value,
    fsAnid: cookies.find(cookie => cookie.name === 'fs_anid')?.value || '',
    userDisplayName: user?.displayName || '',
    userPersonId: user?.personId || '',
  };
}

async function chromeKey() {
  const { stdout } = await run('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
    { encoding: 'buffer', timeout: 20_000, maxBuffer: 4096 });
  try {
    const password = stdout.at(-1) === 10 ? stdout.subarray(0, -1) : stdout;
    return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  } finally {
    stdout.fill(0);
  }
}

export function readCookieRows(DatabaseSync, path, now = Date.now()) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value || 0);
    const statement = db.prepare(`SELECT host_key, name, value, encrypted_value FROM cookies
      WHERE host_key IN ('.familysearch.org', 'familysearch.org', 'www.familysearch.org')
      AND path = '/' AND top_frame_site_key = '' AND (has_expires = 0 OR expires_utc > ?)
      ORDER BY last_update_utc DESC`);
    const chromeTime = BigInt(Math.floor(now)) * 1000n + 11644473600000000n;
    return { version, rows: statement.all(chromeTime) };
  } finally {
    db.close();
  }
}

// Read only FamilySearch cookies. The browser database and its Keychain item stay unchanged.
export async function captureChromeSession(validate, options = {}) {
  if ((options.platform || platform()) !== 'darwin') return null;
  const base = options.base || join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  const { DatabaseSync } = await import('node:sqlite');
  let key;
  try {
    for (const profile of chromeProfiles(base)) {
      const path = ['Network/Cookies', 'Cookies'].map(name => join(profile, name)).find(existsSync);
      if (!path) continue;
      const { rows, version } = readCookieRows(DatabaseSync, path);
      if (!rows.some(row => row.name === 'fssessionid')) continue;
      if (rows.some(row => row.encrypted_value?.length)) key ||= await (options.key || chromeKey)();
      const cookies = [];
      const names = new Set();
      for (const row of rows) {
        if (names.has(row.name)) continue;
        cookies.push({ name: row.name, value: decryptCookie(row, key, version) });
        names.add(row.name);
      }
      const session = sessionFromCookies(cookies);
      try {
        const user = await validate(session);
        return { ...session, userDisplayName: user.displayName, userPersonId: user.personId };
      } catch {
        // Another Chrome profile can have a current session after this one has expired.
      }
    }
    return null;
  } finally {
    key?.fill(0);
  }
}
