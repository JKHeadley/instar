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
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // Linux Chrome launchers can exit before short-lived profile-writing helpers.
    // Give this disposable profile a bounded settling window; exhaustion and
    // unrelated errors remain loud. Avoid fs.rm's linearly increasing native
    // retry delay so the wall-clock ceiling stays explicit and reviewable.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await SafeFsExecutor.safeRm(dir, {
          recursive: true, force: true, maxRetries: 0,
          operation: 'chrome-cdp-relogin-browser.test cleanup',
        });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
}, 35_000);

describe('ChromeCdpReloginBrowser real process', () => {
  it.skipIf(resolveChromeExecutable() === null)('launches isolated Chrome, returns closed page state, fills, clicks, and closes', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-chrome-profile-'));
    dirs.push(profile);
    const browser = new ChromeCdpReloginBrowser({
      userDataDir: profile,
      headless: true,
      // Shared CI runners can take longer than the production default to bring
      // up eight simultaneous real-Chrome shards. Keep this integration bound
      // explicit so runner contention is not mistaken for a browser defect.
      launchTimeoutMs: 30_000,
    });
    try {
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
    } finally {
      await browser.close();
    }
  }, 60_000);
});
