#!/usr/bin/env node
/**
 * Opens an installed browser for FamilySearch login and saves the session locally.
 *
 * Usage: npm run login
 */
import { chromium } from 'playwright';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { FamilySearchSessionClient } from '../build/session-client.js';
import { captureChromeSession } from './chrome-session.mjs';
import { SignInError, waitForBrowserSession } from './browser-session.mjs';

const configDir = join(homedir(), '.familysearch-mcp');
const configPath = join(configDir, 'config.json');
const BROWSERS = [
  {
    name: 'Brave',
    profile: 'brave-profile',
    paths: {
      darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
      win32: [
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      ],
    },
  },
  {
    name: 'Google Chrome',
    profile: 'chrome-profile',
    paths: {
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ],
      linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
      win32: [
        join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Google/Chrome/Application/chrome.exe'),
      ],
    },
  },
];

function findBrowser() {
  const override = process.env.FAMILYSEARCH_BROWSER_PATH || process.env.BRAVE_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error('The browser path does not exist. Check FAMILYSEARCH_BROWSER_PATH or BRAVE_PATH.');
    }
    const browser = BROWSERS.find((candidate) =>
      Object.values(candidate.paths).flat().includes(override),
    );
    return { name: browser?.name || 'browser', profile: browser?.profile || 'browser-profile', executablePath: override };
  }

  for (const browser of BROWSERS) {
    const executablePath = (browser.paths[platform()] || []).find((path) => existsSync(path));
    if (executablePath) {
      return { name: browser.name, profile: browser.profile, executablePath };
    }
  }

  return null;
}

function saveConfig(config) {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

async function validate(config) {
  return new FamilySearchSessionClient(config).validateSession({
    displayName: config.userDisplayName, personId: config.userPersonId,
  });
}

async function main() {
  if (!process.env.FAMILYSEARCH_BROWSER_PATH && !process.env.BRAVE_PATH) {
    try {
      const session = await captureChromeSession(validate);
      if (session) {
        saveConfig(session);
        console.error('FamilySearch connected with the existing Chrome session.');
        return;
      }
    } catch {
      console.error('Could not use the existing Chrome session. Opening a separate sign-in window.');
    }
  }
  const browser = findBrowser();
  if (!browser) {
    console.error('Google Chrome or Brave was not found.');
    console.error('Install Google Chrome or Brave, or set FAMILYSEARCH_BROWSER_PATH to your browser executable.');
    process.exit(1);
  }

  const profileDir = join(configDir, browser.profile);
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  }

  console.error(`Opening ${browser.name} for FamilySearch login...`);
  console.error('Sign in at familysearch.org. This window waits until you are fully logged in (up to 5 minutes).');

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browser.executablePath,
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://www.familysearch.org/en/');
    await page.bringToFront();
    saveConfig(await waitForBrowserSession(context, validate));
    console.error('FamilySearch sign-in is complete. The session is saved locally.');
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof SignInError ? error.message : 'Could not connect to FamilySearch. Close any old Connect window, then try again.');
  process.exit(1);
});
