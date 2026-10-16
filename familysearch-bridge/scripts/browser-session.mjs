import { createHash } from 'node:crypto';
import { sessionFromCookies } from './chrome-session.mjs';

export class SignInError extends Error {}

export async function readLoggedInUser(page) {
  if (!/^https:\/\/(www\.)?familysearch\.org\//.test(page.url())) return null;
  try {
    return await page.evaluate(() => {
      const key = Object.keys(localStorage).find(key => key.endsWith('-v3-user'));
      if (!key) return null;
      const user = JSON.parse(localStorage.getItem(key) || '{}').user;
      return user?.cisId ? { displayName: user.displayName || user.contactName || '', personId: user.personId || '' } : null;
    });
  } catch {
    return null;
  }
}

export async function waitForBrowserSession(context, validate, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeout || 5 * 60_000);
  let checked = '', nextCheck = 0;
  while (now() < deadline) {
    const pages = context.pages().filter(page => !page.isClosed());
    if (!pages.length) throw new SignInError('The FamilySearch sign-in window was closed. Click Connect FamilySearch to try again.');
    const cookies = await context.cookies(['https://www.familysearch.org']);
    const session = sessionFromCookies(cookies);
    if (session) {
      const fingerprint = createHash('sha256').update(session.cookies).digest('hex');
      if (fingerprint !== checked || now() >= nextCheck) {
        checked = fingerprint;
        nextCheck = now() + 10_000;
        let user;
        for (const page of pages) {
          user = await readLoggedInUser(page);
          if (user) break;
        }
        try {
          const confirmed = await validate({ ...session, userDisplayName: user?.displayName || '', userPersonId: user?.personId || '' });
          return { ...session, userDisplayName: confirmed.displayName, userPersonId: confirmed.personId };
        } catch {
          // Wait for the session to change or retry after a short service failure.
        }
      }
    }
    await sleep(1000);
  }
  throw new SignInError('FamilySearch sign-in timed out. Sign in in the Connect window, then try again.');
}
