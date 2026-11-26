import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveChromeExecutable } from '../../src/core/ChromeCdpReloginBrowser.js';
import { PlainChromeReloginBrowser } from '../../src/core/PlainChromeReloginBrowser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// A real, VISIBLE Chrome window opens for this test (a normal browser cannot be headless), so it
// runs only on macOS when explicitly asked for: PLAIN_CHROME_REAL_TEST=1.
const runReal = process.platform === 'darwin' && resolveChromeExecutable() !== null && process.env.PLAIN_CHROME_REAL_TEST === '1';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await new Promise((r) => setTimeout(r, 1_000));
    await SafeFsExecutor.safeRm(d, { recursive: true, force: true, maxRetries: 5, operation: 'plain-chrome integration cleanup' });
  }
}, 30_000);

describe('PlainChromeReloginBrowser real process (normal Chrome, no debugging connection)', () => {
  it.skipIf(!runReal)('opens a normal Chrome, sees it as not automated, enables a pointer-gated button and clicks it', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-chrome-profile-'));
    dirs.push(profile);
    const html = `<!doctype html><html><head><title>Consent</title></head><body>
      <input type="password" id="pw">
      <button id="go" disabled onclick="document.title='authorized'">Authorize</button>
      <script>document.getElementById('pw').value = atob('aHVudGVyLTItc2VjcmV0');
      document.addEventListener('pointermove', () => { document.getElementById('go').disabled = false; }, { once: true });</script>
      </body></html>`;
    const browser = new PlainChromeReloginBrowser({ userDataDir: profile, allowFixtureUrls: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000 });
    try {
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      // No debugging connection was ever opened.
      expect(fs.existsSync(path.join(profile, 'DevToolsActivePort'))).toBe(false);
      const observed = await browser.observeControls();
      const authorize = observed.controls.find((c) => c.text === 'Authorize');
      expect(authorize).toBeDefined();
      expect(JSON.stringify(observed)).not.toContain('hunter-2-secret');
      await browser.clickControl(authorize!.n, 'Authorize', []);
      const snap = await browser.snapshot('nobody@example.com');
      expect(snap.origin).toBe('null');
      // Title changed by the click handler — read back through the same transport.
      const observedAfter = await browser.observeControls();
      expect(observedAfter.title).toBe('authorized');
    } finally {
      await browser.close();
    }
  }, 90_000);

  it.skipIf(!runReal)('refuses a profile whose Chrome is already open and never touches that window', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-chrome-profile-'));
    dirs.push(profile);
    const first = new PlainChromeReloginBrowser({ userDataDir: profile, allowFixtureUrls: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000 });
    const second = new PlainChromeReloginBrowser({ userDataDir: profile, allowFixtureUrls: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000 });
    try {
      await first.open(`data:text/html,${encodeURIComponent('<title>mine</title>')}`);
      await expect(second.open(`data:text/html,${encodeURIComponent('<title>other</title>')}`)).rejects.toThrow('relogin-profile-in-use');
      expect((await first.observeControls()).title).toBe('mine');
    } finally {
      await second.close();
      await first.close();
    }
  }, 90_000);
});
