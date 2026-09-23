import { describe, expect, it } from 'vitest';
import { ChromeCdpReloginBrowser, type WebAuthnCredential } from '../../src/core/ChromeCdpReloginBrowser.js';
import type { OriginPolicy } from '../../src/core/PasskeyBrowserPolicy.js';

// Spec docs/specs/agent-held-google-passkey.md §3.1 / §3.5 — the two credential-placement
// gaps the second-pass review found in Increment 3, reproduced deterministically against a
// scripted CDP `send` (no Chrome): (1) a removal that skips a target mid-preparation while
// that target then loads the key; (2) an add on the main page re-arming a popup that sits
// on another RP-family origin; (3) unknown frame identity falling OPEN on a top-level move.

const POLICY: OriginPolicy = { holderOrigin: 'http://localhost:9', apexHost: 'localhost', allowInsecure: true };
const CRED: WebAuthnCredential = {
  credentialId: 'Y3JlZA==', isResidentCredential: true, rpId: 'localhost', privateKey: 'cGs=',
  userHandle: 'dQ==', signCount: 0,
};

interface Scripted {
  browser: ChromeCdpReloginBrowser;
  auths: Map<string, Set<string>>;
  urls: Map<string, string>;
  delays: { removeMs: number; addAuthMs: number; addAuthFor: string | null };
  calls: string[];
  attach: (sessionId: string, type: string) => Promise<void>;
  paused: (sessionId: string | undefined, url: string, frameId: string) => Promise<void>;
}

function scripted(): Scripted {
  const browser = new ChromeCdpReloginBrowser({ userDataDir: '/tmp/unused', chromePath: '/bin/true', passkeyMode: true, originPolicy: POLICY });
  const auths = new Map<string, Set<string>>();
  const urls = new Map<string, string>();
  const delays: Scripted['delays'] = { removeMs: 0, addAuthMs: 0, addAuthFor: null };
  const calls: string[] = [];
  let n = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    calls.push(`${method}@${sessionId ?? 'browser'}`);
    switch (method) {
      case 'WebAuthn.addVirtualAuthenticator': {
        if (delays.addAuthMs && (delays.addAuthFor === null || delays.addAuthFor === sessionId)) await sleep(delays.addAuthMs);
        const id = `auth-${++n}`; auths.set(id, new Set()); return { authenticatorId: id };
      }
      case 'WebAuthn.addCredential':
        auths.get(String(params.authenticatorId))!.add((params.credential as WebAuthnCredential).credentialId); return {};
      case 'WebAuthn.removeCredential':
        if (delays.removeMs) await sleep(delays.removeMs);
        auths.get(String(params.authenticatorId))!.delete(String(params.credentialId)); return {};
      case 'WebAuthn.getCredentials':
        return { credentials: [...auths.get(String(params.authenticatorId))!].map((credentialId) => ({ credentialId })) };
      case 'Page.getFrameTree': {
        const url = urls.get(sessionId ?? '');
        if (url === undefined) throw new Error('Page.getFrameTree: no frame tree');
        return { frameTree: { frame: { id: `frame-${sessionId}`, url, securityOrigin: url === 'about:blank' ? '://' : new URL(url).origin }, childFrames: [] } };
      }
      default: return {};
    }
  };
  (browser as unknown as { send: typeof send }).send = send;
  const priv = browser as unknown as {
    onAttached: (p: Record<string, unknown>) => Promise<void>;
    onRequestPaused: (p: Record<string, unknown>, sid: string | undefined) => Promise<void>;
  };
  return {
    browser, auths, urls, delays, calls,
    attach: (sessionId, type) => priv.onAttached({ sessionId, targetInfo: { targetId: `t-${sessionId}`, type }, waitingForDebugger: true }),
    paused: (sessionId, url, frameId) => priv.onRequestPaused({ requestId: 'r1', resourceType: 'Document', request: { url }, frameId }, sessionId),
  };
}

const held = (s: Scripted) => [...s.auths.values()].map((set) => set.size);

describe('ChromeCdpReloginBrowser — credential placement invariants (scripted CDP)', () => {
  it('a removal that skips a popup mid-preparation leaves NO authenticator holding the key', async () => {
    const s = scripted();
    s.urls.set('main', `${POLICY.holderOrigin}/`);
    await s.attach('main', 'page');
    await s.browser.addCredential(CRED);
    expect(held(s)).toEqual([1]);

    // The popup is in the session map but its authenticator is still being created when
    // the removal sweep visits it (skipped: nothing to remove yet); a LATER session in
    // map order keeps the sweep busy, and the popup finishes preparing in that window.
    s.delays.addAuthFor = 'popup';
    s.delays.addAuthMs = 60;
    s.delays.removeMs = 40;
    s.urls.set('popup', 'about:blank');
    s.urls.set('frame', `${POLICY.holderOrigin}/f`);
    const popupAttach = s.attach('popup', 'page');
    await s.attach('frame', 'iframe');
    const removal = s.browser.removeCredential();
    await Promise.all([removal, popupAttach]);

    expect(s.browser.hasCredential()).toBe(false);
    expect(held(s)).toEqual([0, 0, 0]);
    // And a later forbidden navigation of that popup still sweeps by id, flag or no flag.
    s.auths.get('auth-3')!.add(CRED.credentialId); // simulate a stray load
    await s.paused('popup', 'http://other.localhost:9/x', 'frame-popup');
    expect(held(s)).toEqual([0, 0, 0]);
    expect(s.calls.at(-1)).toBe('Fetch.continueRequest@popup');
  });

  it('a popup that attaches BEFORE a removal is included in the sweep', async () => {
    const s = scripted();
    s.urls.set('main', `${POLICY.holderOrigin}/`);
    await s.attach('main', 'page');
    await s.browser.addCredential(CRED);
    s.delays.addAuthMs = 40;
    s.urls.set('popup', 'about:blank');
    const attach = s.attach('popup', 'page');
    await new Promise((r) => setTimeout(r, 5));
    const removal = s.browser.removeCredential();
    await Promise.all([removal, attach]);
    expect(held(s)).toEqual([0, 0]);
    expect(s.browser.hasCredential()).toBe(false);
  });

  it('refuses to add while a popup sits on another RP-family origin, and allows it once the popup is back on the holder origin', async () => {
    const s = scripted();
    s.urls.set('main', `${POLICY.holderOrigin}/`);
    s.urls.set('popup', 'about:blank');
    await s.attach('main', 'page');
    await s.attach('popup', 'page');
    await s.browser.addCredential(CRED); // blank popup is fine (still paused)
    expect(held(s)).toEqual([1, 1]);

    // Popup moves to another RP-family origin → removal at request time.
    s.urls.set('popup', 'http://other.localhost:9/x');
    await s.paused('popup', 'http://other.localhost:9/x', 'frame-popup');
    expect(held(s)).toEqual([0, 0]);

    // Main page is still on the holder origin — the popup must veto the re-add.
    await expect(s.browser.addCredential(CRED)).rejects.toThrow('passkey-origin-not-allowed');
    expect(held(s)).toEqual([0, 0]);
    expect(s.browser.hasCredential()).toBe(false);

    s.urls.set('popup', `${POLICY.holderOrigin}/popup`);
    await s.browser.addCredential(CRED);
    expect(held(s)).toEqual([1, 1]);
  });

  it('an unrelated-origin popup does not veto the add (it cannot claim the relying party)', async () => {
    const s = scripted();
    s.urls.set('main', `${POLICY.holderOrigin}/`);
    s.urls.set('popup', 'http://127.0.0.1:9/help');
    await s.attach('main', 'page');
    await s.attach('popup', 'page');
    await s.browser.addCredential(CRED);
    expect(held(s)).toEqual([1, 1]);
  });

  it('treats an UNKNOWN frame identity as top-level: a move to a non-RP origin still removes the key', async () => {
    const s = scripted();
    // No frame tree for main → mainFrameId stays undefined.
    await s.attach('main', 'page');
    s.urls.set('main', `${POLICY.holderOrigin}/`);
    await s.browser.addCredential(CRED);
    expect(held(s)).toEqual([1]);
    await s.paused('main', 'https://example.com/', 'whatever');
    expect(held(s)).toEqual([0]);
    expect(s.browser.hasCredential()).toBe(false);
  });

  it('a subframe document on an unrelated origin keeps the key when the frame identity IS known', async () => {
    const s = scripted();
    s.urls.set('main', `${POLICY.holderOrigin}/`);
    await s.attach('main', 'page');
    await s.browser.addCredential(CRED);
    await s.paused('main', 'https://example.com/', 'child-frame');
    expect(held(s)).toEqual([1]);
    expect(s.browser.hasCredential()).toBe(true);
  });

  it('runInPage / clickSelector are refused under the production Google policy', async () => {
    const b = new ChromeCdpReloginBrowser({ userDataDir: '/tmp/unused', chromePath: '/bin/true', passkeyMode: true });
    await expect(b.runInPage('1')).rejects.toThrow('run-in-page-fixture-only');
    await expect(b.clickSelector('#x')).rejects.toThrow('click-selector-fixture-only');
  });
});
