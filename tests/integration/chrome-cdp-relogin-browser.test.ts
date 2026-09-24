import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChromeCdpReloginBrowser,
  isClosedOpenAiDeviceApproval,
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
  it('admits only the structural OpenAI device confirmation and rejects consent-shadowing prose', () => {
    const base = { origin: 'https://auth.openai.com', pathname: '/codex/device', hasAuthorize: true,
      body: 'confirm this codex device verification code' };
    expect(isClosedOpenAiDeviceApproval(base)).toBe(true);
    expect(isClosedOpenAiDeviceApproval({ ...base,
      body: 'confirm this codex device verification code and grant permission to access your organization' })).toBe(false);
    expect(isClosedOpenAiDeviceApproval({ ...base, pathname: '/oauth/authorize' })).toBe(false);
    expect(isClosedOpenAiDeviceApproval({ ...base, origin: 'https://auth.openai.com.evil.example' })).toBe(false);
  });
  it.skipIf(resolveChromeExecutable() === null)('classifies a Cloudflare "Just a moment" bot-check hold as interstitial, not captcha or unknown', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-chrome-profile-'));
    dirs.push(profile);
    const browser = new ChromeCdpReloginBrowser({ userDataDir: profile, headless: true, launchTimeoutMs: 30_000 });
    try {
      const html = `<!doctype html><html><head><title>Just a moment...</title></head><body>
        <h1>claude.ai</h1><p>Verifying you are human. This may take a few seconds.</p>
        <p>Performing security verification</p></body></html>`;
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      expect(await browser.snapshot('operator@example.com')).toMatchObject({ pageClass: 'interstitial' });
    } finally {
      await browser.close();
    }
  }, 60_000);
  it.skipIf(resolveChromeExecutable() === null)('follows a provider popup: snapshot, fill and click address the newest live page, then fall back to the main page when it closes', async () => {
    // 2026-09-23 justin-gmail: "Continue with Google" opened Google's window, but every snapshot kept
    // reading the main claude.ai page (provider-choice) — the drive clicked Google again and again
    // and timed out three times while the popup sat open.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-chrome-profile-'));
    dirs.push(profile);
    const browser = new ChromeCdpReloginBrowser({ userDataDir: profile, headless: true, launchTimeoutMs: 30_000 });
    try {
      // No <script> tag in the popup document: it is written from inside the main page's script,
      // where a literal </script> would end that script early.
      const popupHtml = `<!doctype html><html><body>
        <input type="email" autocomplete="username"><button id="next" onclick="window.close()">Next</button>
      </body></html>`;
      const mainHtml = `<!doctype html><html><body>
        <a id="google" href="javascript:void(0)">Continue with Google</a>
        <script>document.getElementById('google').addEventListener('click', () => {
          document.getElementById('google').remove();
          // Chrome refuses data: URLs in window.open; write the popup document into a blank window instead.
          const w = window.open('', 'provider', 'width=500,height=600');
          if (!w) { document.body.insertAdjacentHTML('beforeend', '<p>popup blocked</p>'); return; }
          w.document.write(${JSON.stringify(popupHtml)}); w.document.close();
          document.body.insertAdjacentHTML('beforeend', '<p>Authorization complete. You can close this window.</p>');
        });</script>
      </body></html>`;
      await browser.open(`data:text/html,${encodeURIComponent(mainHtml)}`);
      expect(await browser.snapshot('operator@example.com')).toMatchObject({ pageClass: 'provider-choice', hasGoogleSignIn: true });
      await browser.click('google');
      // The popup is now the page the drive sees.
      let popup: Awaited<ReturnType<typeof browser.snapshot>> | null = null;
      for (let i = 0; i < 20 && popup?.pageClass !== 'email'; i++) { await browser.wait(250); popup = await browser.snapshot('operator@example.com'); }
      expect(popup).toMatchObject({ pageClass: 'email', hasNext: true });
      // Filling submits inside the popup, which closes itself; the main page is read again.
      await browser.fillPublic('email', 'operator@example.com');
      let main: Awaited<ReturnType<typeof browser.snapshot>> | null = null;
      for (let i = 0; i < 20 && main?.pageClass !== 'success'; i++) { await browser.wait(250); main = await browser.snapshot('operator@example.com'); }
      expect(main).toMatchObject({ pageClass: 'success' });
    } finally {
      await browser.close();
    }
  }, 60_000);
  it.skipIf(resolveChromeExecutable() === null)('launches isolated Chrome, classifies, fills and submits the form, and closes', async () => {
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
        <a id="google" href="javascript:void(0)">Continue with Google</a>
        <script>
          document.getElementById('google').addEventListener('click', () => {
            document.body.innerHTML = '<input type="email" autocomplete="username"><button id="next">Next</button>';
            document.getElementById('next').addEventListener('click', () => {
              document.body.textContent = 'Authorization complete. You can close this window.';
            });
          });
        </script>
      </body></html>`;
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      expect(await browser.snapshot('operator@example.com')).toMatchObject({
        origin: 'null', pageClass: 'provider-choice', hasGoogleSignIn: true,
      });
      await browser.click('google');
      expect(await browser.snapshot('operator@example.com')).toMatchObject({ pageClass: 'email', hasNext: true });
      await browser.fillPublic('email', 'operator@example.com');
      expect(await browser.snapshot('operator@example.com')).toMatchObject({ pageClass: 'success' });
    } finally {
      await browser.close();
    }
  }, 60_000);

  it.skipIf(resolveChromeExecutable() === null)('matches one exact chooser leaf and refuses missing, duplicate, and substring collisions', async () => {
    const withPage = async (html: string, run: (browser: ChromeCdpReloginBrowser) => Promise<void>) => {
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-chooser-profile-'));
      dirs.push(profile);
      const browser = new ChromeCdpReloginBrowser({ userDataDir: profile, headless: true, launchTimeoutMs: 30_000 });
      try { await browser.open(`data:text/html,${encodeURIComponent(html)}`); await run(browser); }
      finally { await browser.close(); }
    };

      const unique = `<!doctype html><body>Choose an account
        <button data-email="operator@example.com">Operator operator@example.com</button>
        <button data-email="other-operator@example.com">Other other-operator@example.com</button>
        <script>document.querySelector('[data-email="operator@example.com"]').onclick=()=>document.body.dataset.picked='expected'</script>`;
    await withPage(unique, async (browser) => {
      expect(await browser.snapshot('operator@example.com')).toMatchObject({
        pageClass: 'account-chooser', expectedAccountVisible: true, expectedAccountMatchCount: 1,
      });
      await browser.chooseExpectedAccount('operator@example.com');
    });

    const missing = '<!doctype html><body>Choose an account<button data-email="someone@example.com">someone@example.com</button>';
    await withPage(missing, async (browser) => {
      expect(await browser.snapshot('operator@example.com')).toMatchObject({
        pageClass: 'account-chooser', expectedAccountVisible: false, expectedAccountMatchCount: 0,
      });
      await expect(browser.chooseExpectedAccount('operator@example.com')).rejects.toThrow('browser-element-not-found');
    });

    const duplicate = '<!doctype html><body>Choose an account<button data-email="operator@example.com">operator@example.com</button><button data-identifier="operator@example.com">operator@example.com</button>';
    await withPage(duplicate, async (browser) => {
      expect(await browser.snapshot('operator@example.com')).toMatchObject({
        pageClass: 'account-chooser', expectedAccountVisible: false, expectedAccountMatchCount: 2,
      });
      await expect(browser.chooseExpectedAccount('operator@example.com')).rejects.toThrow('browser-element-not-found');
    });
  }, 60_000);
});
