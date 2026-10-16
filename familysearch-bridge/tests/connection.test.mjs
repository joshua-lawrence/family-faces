import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConnection } from '../build/connection.js';

const result = (text, isError = false) => ({ isError, content: [{ type: 'text', text }] });

test('a connection check validates the saved session without opening a browser', async () => {
  const calls = [];
  const status = await checkConnection(async name => {
    calls.push(name);
    return result('Current user: Test User\nPerson ID: ABCD-123');
  });
  assert.deepEqual(calls, ['get-current-user']);
  assert.equal(status.connected, true);
  assert.equal(status.status, 'connected');
});

test('connect saves a browser session and validates it before reporting success', async () => {
  const calls = [];
  const status = await checkConnection(async name => {
    calls.push(name);
    return result(name === 'login-with-browser' ? 'Browser login complete. Session saved.' : 'Current user: Test User');
  }, true);
  assert.deepEqual(calls, ['login-with-browser', 'get-current-user']);
  assert.equal(status.connected, true);
});

test('a saved cookie rejected by FamilySearch is not shown as connected', async () => {
  const status = await checkConnection(async name => result(name === 'login-with-browser'
    ? 'Browser login complete. Session saved.' : 'Error fetching user info: HTTP 401'), true);
  assert.equal(status.connected, false);
  assert.equal(status.status, 'disconnected');
  assert.match(status.note, /Connect FamilySearch/);
});

test('a failed browser sign-in does not check the old session or expose its output', async () => {
  const calls = [];
  const status = await checkConnection(async name => {
    calls.push(name);
    return result('Browser login failed: private diagnostic data');
  }, true);
  assert.deepEqual(calls, ['login-with-browser']);
  assert.equal(status.connected, false);
  assert.ok(!JSON.stringify(status).includes('private'));
});

test('missing, blocked and unknown sessions have clear connection states', async () => {
  for (const [text, expected] of [['Not authenticated.', 'disconnected'],
    ['Request blocked by FamilySearch security (error 15).', 'disconnected'],
    ['Error fetching user info: HTTP 500 private diagnostic data', 'error']]) {
    const status = await checkConnection(async () => result(text));
    assert.equal(status.status, expected);
    assert.equal(status.connected, false);
    assert.ok(!JSON.stringify(status).includes('private'));
  }
});
