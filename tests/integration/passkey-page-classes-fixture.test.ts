import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChromeCdpReloginBrowser, resolveChromeExecutable } from '../../src/core/ChromeCdpReloginBrowser.js';
import { startPasskeyFixture, type PasskeyFixture } from '../../src/core/PasskeyWebAuthnFixture.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Spec docs/specs/agent-held-google-passkey.md §3.6 / §8 "page-class ordering fixtures":
// every redacted fixture page carries the STRUCTURE of one closed Google page AND prose
// the parent text-regex chain would classify differently. Through REAL headless Chrome
// and the real in-page snapshot, the structural class must win on every one of them,
// the new controls must be clickable by exact label, and an unmatched page must fall
// through to the parent chain unchanged.

const HAS_CHROME = resolveChromeExecutable() !== null;
const LAUNCH = { headless: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000 } as const;
const WHO = 'operator@example.com';

describe.skipIf(!HAS_CHROME)('closed Google page classes — ordering through real Chrome against the fixture', () => {
  let fixture: PasskeyFixture;
  const dirs: string[] = [];
  const browsers: ChromeCdpReloginBrowser[] = [];
  const open = async (url: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-classes-')); dirs.push(dir);
    const b = new ChromeCdpReloginBrowser({ userDataDir: dir, passkeyMode: true, originPolicy: fixture.policy, ...LAUNCH });
    browsers.push(b);
    await b.open(url);
    return b;
  };
  /** Navigate the SAME browser (open() is once-only) and wait for the new document. */
  const goto = async (b: ChromeCdpReloginBrowser, url: string) => {
    const target = new URL(url);
    await b.runInPage(`location.assign(${JSON.stringify(url)})`);
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const here = await b.runInPage<string>('document.readyState === "complete" ? location.origin + location.pathname + location.search : ""');
        if (here === target.origin + target.pathname + target.search) return;
      } catch { /* mid-navigation: the execution context is being replaced */ }
      if (Date.now() > deadline) throw new Error(`navigation-timeout:${target.pathname}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const picked = (b: ChromeCdpReloginBrowser) => b.runInPage<string>(`document.getElementById('picked').textContent`);

  beforeAll(async () => { fixture = await startPasskeyFixture(); });
  afterAll(async () => { await fixture.close(); });
  afterEach(async () => {
    for (const b of browsers.splice(0)) await b.close().catch(() => {});
    for (const dir of dirs.splice(0)) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { await SafeFsExecutor.safeRm(dir, { recursive: true, force: true, maxRetries: 0, operation: 'passkey-page-classes-fixture.test cleanup' }); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }, 40_000);

  it('classifies every holder-origin fixture page structurally although its prose would read otherwise', async () => {
    const b = await open(`${fixture.holderOrigin}/v3/signin/identifier`);
    // Prose says "verification code" (parent ⇒ totp); structure says identifier.
    expect(await b.snapshot(WHO)).toMatchObject({ pageClass: 'google-account-identity' });
    const expectClass = async (pathAndQuery: string, cls: string, extra: Record<string, unknown> = {}) => {
      await goto(b, `${fixture.holderOrigin}${pathAndQuery}`);
      expect(await b.snapshot(WHO), pathAndQuery).toMatchObject({ pageClass: cls, ...extra });
    };
    // The prompt carries a HIDDEN dialog + hidden "Not now": rendered-only facts must ignore them.
    await expectClass('/v3/signin/challenge/pk/presend', 'google-passkey-challenge', { hasNotNow: false });
    await expectClass('/v3/signin/challenge/pk/presend?v=alert', 'google-credential-not-recognized');
    await expectClass('/v3/signin/challenge/pk/presend?v=throttled', 'google-passkey-throttled');
    // The parent chain would read this `totp` too (by its input id) — the structural class must still be the
    // one reported, proving the structural layer answered first.
    await expectClass('/v3/signin/challenge/totp', 'google-totp-entry');
    // Prose says "choose an account" (parent ⇒ account-chooser).
    await expectClass('/v3/signin/challenge/bc', 'google-backup-code-entry');
    // A password input is present (parent ⇒ password); the CAPTCHA widget must win.
    await expectClass('/v3/signin/challenge/recaptcha', 'google-risk-challenge');
    await expectClass('/speedbump/passkeyenrollment', 'google-passkey-create', { hasNotNow: true });
    await expectClass('/speedbump/passkeyenrollment?v=confirm', 'google-passkey-create-confirm');
  }, 90_000);

  it('classifies the account-origin passkey settings page in each of its shapes', async () => {
    const b = await open(`${fixture.otherOrigin}/signinoptions/passkeys`);
    expect(await b.snapshot(WHO)).toMatchObject({ pageClass: 'google-passkey-list' });
    for (const [v, cls] of [['create', 'google-passkey-create'], ['confirm', 'google-passkey-create-confirm'],
      ['done', 'google-already-enrolled'], ['blocked', 'google-workspace-policy-blocked']] as const) {
      await goto(b, `${fixture.otherOrigin}/signinoptions/passkeys?v=${v}`);
      expect(await b.snapshot(WHO), v).toMatchObject({ pageClass: cls });
    }
  }, 60_000);

  it('leaves an unmatched page to the parent chain, and clicks the new controls by exact label with real input', async () => {
    const b = await open(`${fixture.holderOrigin}/parent-chain`);
    // No structural class ⇒ the parent's selector/prose chain answers.
    expect(await b.snapshot(WHO)).toMatchObject({ pageClass: 'email' });

    await goto(b, `${fixture.holderOrigin}/v3/signin/challenge/pk/presend`);
    await b.click('passkey-continue');
    expect(await picked(b)).toBe('continue');
    await goto(b, `${fixture.holderOrigin}/v3/signin/challenge/pk/presend?v=2`);
    await b.click('try-another-way');
    expect(await picked(b)).toBe('another');

    await goto(b, `${fixture.holderOrigin}/speedbump/passkeyenrollment`);
    await b.click('not-now');
    expect(await picked(b)).toBe('not-now');
    await goto(b, `${fixture.holderOrigin}/speedbump/passkeyenrollment?v=2`);
    await b.click('create-passkey');
    expect(await picked(b)).toBe('create');
    // The confirm click is dialog-scoped: with no open dialog there is nothing to click.
    await expect(b.click('create-passkey-confirm')).rejects.toThrow('browser-element-not-found');

    // The identifier fill reaches Google's `input[type="text"]#identifierId`.
    await goto(b, `${fixture.holderOrigin}/v3/signin/identifier`);
    await b.fillPublic('email', WHO);
    expect(await b.runInPage<string>(`document.getElementById('identifierId').value`)).toBe(WHO);
  }, 90_000);
});
