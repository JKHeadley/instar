import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChromeCdpReloginBrowser, resolveChromeExecutable, type WebAuthnCredential } from '../../src/core/ChromeCdpReloginBrowser.js';
import { startPasskeyFixture, type PasskeyFixture } from '../../src/core/PasskeyWebAuthnFixture.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Spec docs/specs/agent-held-google-passkey.md §3.5 / §8 — the browser foundation,
// exercised against the local WebAuthn fixture with REAL headless Chrome. Every
// case here is one the spec names: pipe transport (no DevToolsActivePort),
// attach-before-navigate, popup auto-attach, request-time removal on a top-level
// move / a 302 redirect / an RP-family iframe, an unrelated iframe NOT removing,
// observed assertion, identity read, real input clicks, and credential export +
// re-injection (portability).

const HAS_CHROME = resolveChromeExecutable() !== null;
const LAUNCH = { headless: true, launchTimeoutMs: 30_000, operationTimeoutMs: 20_000 } as const;

describe.skipIf(!HAS_CHROME)('ChromeCdpReloginBrowser — passkey mode against the local WebAuthn fixture', () => {
  let fixture: PasskeyFixture;
  const dirs: string[] = [];
  const browsers: ChromeCdpReloginBrowser[] = [];

  const profile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-browser-')); dirs.push(d); return d; };
  const open = async (url: string, extra: Partial<ConstructorParameters<typeof ChromeCdpReloginBrowser>[0]> = {}) => {
    const b = new ChromeCdpReloginBrowser({ userDataDir: profile(), passkeyMode: true, originPolicy: fixture.policy, ...LAUNCH, ...extra });
    browsers.push(b);
    await b.open(url);
    return b;
  };
  /** Mint a resident credential on the holder origin and export it. */
  const mint = async () => {
    const b = await open(`${fixture.holderOrigin}/`);
    const id = await b.runInPage<string>(`window.__create('agent@example.com')`);
    const creds = await b.exportCredentials();
    expect(creds).toHaveLength(1);
    expect(creds[0].credentialId).toBe(id);
    await b.close();
    return creds[0];
  };

  beforeAll(async () => { fixture = await startPasskeyFixture(); });
  afterAll(async () => { await fixture.close(); });
  afterEach(async () => {
    for (const b of browsers.splice(0)) await b.close().catch(() => {});
    for (const dir of dirs.splice(0)) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await SafeFsExecutor.safeRm(dir, { recursive: true, force: true, maxRetries: 0, operation: 'passkey-browser-fixture.test cleanup' });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) throw error;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    }
  }, 40_000);

  it('uses the debugging pipe: no DevToolsActivePort is ever written, and the page is reachable', async () => {
    const b = await open(`${fixture.holderOrigin}/`);
    const dir = dirs[dirs.length - 1];
    expect(fs.existsSync(path.join(dir, 'DevToolsActivePort'))).toBe(false);
    expect(await b.runInPage<string>('location.origin')).toBe(fixture.holderOrigin);
    expect(b.sawNavigationBeforeAttach()).toBe(false);
  }, 60_000);

  it('mints a resident credential, exports it, re-injects it in a FRESH browser and asserts with it (portability)', async () => {
    const cred: WebAuthnCredential = await mint();
    expect(cred.isResidentCredential).toBe(true);
    expect(cred.rpId).toBe('localhost');

    const b = await open(`${fixture.holderOrigin}/`);
    expect(await b.credentialCount()).toBe(0);
    await b.addCredential(cred);
    expect(b.hasCredential()).toBe(true);
    expect(await b.credentialCount()).toBe(1);
    expect(b.observedAssertion(cred.credentialId)).toBe(false);
    const assertedId = await b.runInPage<string>('window.__get()');
    expect(assertedId).toBe(cred.credentialId);
    expect(b.observedAssertion(cred.credentialId)).toBe(true);
  }, 90_000);

  it('refuses to add the credential while the top-level frame is not on the holder origin', async () => {
    const cred = await mint();
    const b = await open(`${fixture.otherOrigin}/other`);
    await expect(b.addCredential(cred)).rejects.toThrow('passkey-origin-not-allowed');
    expect(b.hasCredential()).toBe(false);
  }, 60_000);

  it('removes the credential BEFORE a top-level navigation to another RP-family origin', async () => {
    const cred = await mint();
    const b = await open(`${fixture.holderOrigin}/`);
    await b.addCredential(cred);
    await b.runInPage(`location.assign(${JSON.stringify(`${fixture.otherOrigin}/other`)})`);
    await b.wait(1500);
    expect(await b.runInPage<string>('location.origin')).toBe(fixture.otherOrigin);
    expect(b.hasCredential()).toBe(false);
    expect(await b.credentialCount()).toBe(0);
    await expect(b.runInPage<string>('window.__get()')).rejects.toThrow();
  }, 60_000);

  it('removes the credential on a 302 redirect hop to another RP-family origin', async () => {
    const cred = await mint();
    const b = await open(`${fixture.holderOrigin}/`);
    await b.addCredential(cred);
    await b.runInPage(`location.assign(${JSON.stringify(`${fixture.holderOrigin}/redirect`)})`);
    await b.wait(1500);
    expect(await b.runInPage<string>('location.origin')).toBe(fixture.otherOrigin);
    expect(b.hasCredential()).toBe(false);
    expect(await b.credentialCount()).toBe(0);
  }, 60_000);

  it('removes the credential when an IFRAME navigates to another RP-family origin', async () => {
    const cred = await mint();
    const b = await open(`${fixture.holderOrigin}/`);
    await b.addCredential(cred);
    await b.runInPage(`location.assign(${JSON.stringify(`${fixture.holderOrigin}/with-frame`)})`);
    await b.wait(2000);
    expect(await b.runInPage<string>('location.origin')).toBe(fixture.holderOrigin); // top-level stayed
    expect(b.hasCredential()).toBe(false);
  }, 60_000);

  it('keeps the credential when an iframe is on an UNRELATED origin (it cannot claim the RP)', async () => {
    const cred = await mint();
    const b = await open(`${fixture.holderOrigin}/with-unrelated-frame`);
    await b.wait(1000);
    await b.addCredential(cred);
    expect(b.hasCredential()).toBe(true);
    expect(await b.credentialCount()).toBe(1);
    // Still usable from the top-level holder page.
    expect(await b.runInPage<string>('window.__get()')).toBe(cred.credentialId);
  }, 60_000);

  it('auto-attaches a popup and gives it an authenticator BEFORE it navigates (holder-origin popup keeps the credential)', async () => {
    const cred = await mint();
    const b = await open(`${fixture.holderOrigin}/popup-opener`);
    await b.addCredential(cred);
    await b.clickSelector('#open');
    await b.wait(2000);
    // The popup stayed on the holder origin, so the credential was NOT removed and
    // the popup's own authenticator received it.
    expect(b.hasCredential()).toBe(true);
    expect(b.sawNavigationBeforeAttach()).toBe(false);
    // Two page targets (opener + popup), and BOTH authenticators hold the credential.
    const counts = await b.credentialCountsByTarget();
    expect(counts).toHaveLength(2);
    expect(counts).toEqual([1, 1]);
  }, 60_000);

  it('a popup that moved to another RP-family origin vetoes a re-add on the main page until it returns', async () => {
    const cred = await mint();
    const b = await open(`${fixture.holderOrigin}/popup-opener`);
    await b.addCredential(cred);
    await b.clickSelector('#open');
    await b.wait(2000);
    expect(await b.credentialCountsByTarget()).toEqual([1, 1]);
    // Opener moves the popup (by window NAME — a cross-origin WindowProxy may not be scripted)
    // to the OTHER RP-family origin → request-time removal everywhere.
    await b.runInPage(`window.open(${JSON.stringify(`${fixture.otherOrigin}/other`)}, 'pk'); true`);
    await b.wait(2000);
    expect(b.hasCredential()).toBe(false);
    expect(await b.credentialCountsByTarget()).toEqual([0, 0]);
    // Main page is still on the holder origin, but the popup must veto the re-add.
    await expect(b.addCredential(cred)).rejects.toThrow('passkey-origin-not-allowed');
    expect(await b.credentialCountsByTarget()).toEqual([0, 0]);
    // Back on the holder origin → the add is allowed again and BOTH targets are loaded.
    await b.runInPage(`window.open(${JSON.stringify(`${fixture.holderOrigin}/popup`)}, 'pk'); true`);
    await b.wait(2000);
    await b.addCredential(cred);
    expect(await b.credentialCountsByTarget()).toEqual([1, 1]);
  }, 90_000);

  it('reads the signed-in identity structurally and returns only a boolean', async () => {
    const b = await open(`${fixture.holderOrigin}/account?email=Agent%40Example.com`);
    expect(await b.readSignedInIdentityMatches('agent@example.com')).toBe(true);
    expect(await b.readSignedInIdentityMatches('other@example.com')).toBe(false);
    expect(await b.readSignedInIdentityMatches('')).toBe(false);
  }, 60_000);

  it('clicks with real pointer events (a list item and a button both register)', async () => {
    const b = await open(`${fixture.holderOrigin}/`);
    await b.clickSelector('#btn');
    await b.clickSelector('#item');
    expect(await b.runInPage<string>(`document.getElementById('clicked').textContent`)).toBe('yes');
    expect(await b.runInPage<string>(`document.getElementById('item-clicked').textContent`)).toBe('yes');
  }, 60_000);
});
