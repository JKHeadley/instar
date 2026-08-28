import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChromeCdpReloginBrowser,
  resolveChromeExecutable,
} from '../../src/core/ChromeCdpReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'chrome-cdp-relogin-browser.test cleanup',
  });
});

describe('ChromeCdpReloginBrowser real process', () => {
  it.skipIf(resolveChromeExecutable() === null)('launches isolated Chrome, returns closed page state, fills, clicks, and closes', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-chrome-profile-'));
    dirs.push(profile);
    const browser = new ChromeCdpReloginBrowser({ userDataDir: profile, headless: true });
    const html = `<!doctype html><html><body>
      <input type="email" autocomplete="username">
      <button onclick="document.body.innerHTML='Authorization complete. You can close this window.'">Next</button>
    </body></html>`;
    await browser.open(`data:text/html,${encodeURIComponent(html)}`);
    expect(await browser.snapshot('operator@example.com')).toMatchObject({
      origin: 'null', pageClass: 'email', hasNext: true,
    });
    await browser.fillPublic('email', 'operator@example.com');
    await browser.click('next');
    expect(await browser.snapshot('operator@example.com')).toMatchObject({ pageClass: 'success' });
    await browser.close();
  }, 20_000);
});
