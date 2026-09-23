import { describe, expect, it, vi } from 'vitest';
import { runPasskeyColdProof, type ProofBrowser } from '../../src/core/PasskeyColdProof.js';
import type { ReloginBrowserSnapshot } from '../../src/core/AnthropicReloginBrowserDriver.js';

// Spec docs/specs/agent-held-google-passkey.md §3.8 — the cold proof: cleared + confirmed signed out
// BEFORE the credential is added; `ready` only with the observed assertion + a single credential + an
// identity match; teardown (remove + sign out) on every path; states only in the result.

const RECORD = { credentialId: 'cred-1', rpId: 'google.com', privateKey: 'pk', userHandle: 'uh', signCount: 0 };
const INPUT = { canonicalEmail: 'a@example.com', record: RECORD, signInUrl: 'https://accounts.google.com/v3/signin/identifier', signOutUrl: 'https://accounts.google.com/Logout' };

function snap(pageClass: ReloginBrowserSnapshot['pageClass'], extra: Partial<ReloginBrowserSnapshot> = {}): ReloginBrowserSnapshot {
  return { origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: false, hasGoogleSignIn: false, hasNext: true, hasAuthorize: false, requestedScopes: [], ...extra };
}

/** A scripted browser: pages in order, an identity read per page, an assertion when Continue is clicked. */
function fake(opts: { pages: ReloginBrowserSnapshot[]; identity?: Array<'match' | 'other' | 'none'>; assertOnContinue?: boolean; credentialCount?: number; failOn?: keyof ProofBrowser }) {
  let i = -1; let asserted = false;
  const calls: string[] = [];
  const maybeFail = (name: keyof ProofBrowser) => { if (opts.failOn === name) throw new Error(`boom-${name}`); };
  const browser: ProofBrowser = {
    open: vi.fn(async () => { calls.push('open'); maybeFail('open'); }),
    navigateTo: vi.fn(async (url: string) => { calls.push(`navigate:${new URL(url).pathname}`); maybeFail('navigateTo'); }),
    clearBrowsingData: vi.fn(async () => { calls.push('clear'); maybeFail('clearBrowsingData'); }),
    snapshot: vi.fn(async () => { i = Math.min(i + 1, opts.pages.length - 1); calls.push(`snapshot:${opts.pages[i].pageClass}`); maybeFail('snapshot'); return opts.pages[i]; }),
    click: vi.fn(async (a: string) => { calls.push(`click:${a}`); if (a === 'passkey-continue' && opts.assertOnContinue !== false) asserted = true; }),
    chooseExpectedAccount: vi.fn(async () => { calls.push('choose'); }),
    fillPublic: vi.fn(async (f: string) => { calls.push(`fill:${f}`); }),
    wait: vi.fn(async () => {}),
    addCredential: vi.fn(async () => { calls.push('add'); maybeFail('addCredential'); }),
    removeCredential: vi.fn(async () => { calls.push('remove'); }),
    credentialCount: vi.fn(async () => opts.credentialCount ?? 1),
    observedAssertion: vi.fn(() => asserted),
    readSignedInIdentity: vi.fn(async () => (opts.identity ?? [])[Math.max(0, i)] ?? 'none'),
    close: vi.fn(async () => { calls.push('close'); }),
  };
  return { browser, calls };
}

describe('runPasskeyColdProof (§3.8)', () => {
  it('ready: cleared → confirmed signed out → credential added → identifier filled → Continue asserts → identity matches → removed + signed out', async () => {
    const f = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('unknown')], identity: ['none', 'none', 'match'] });
    const r = await runPasskeyColdProof({ openBrowser: () => f.browser }, INPUT);
    expect(r.outcome).toBe('ready');
    expect(r).toMatchObject({ observedAssertion: true, singleCredential: true, signedInIdentity: 'match', riskPage: false, teardown: { credentialRemoved: true, signedOut: true } });
    expect(r.steps.map((s) => `${s.pageClass}:${s.action}`)).toEqual(['google-account-identity:fill-email', 'google-passkey-challenge:click-passkey-continue', 'unknown:stop']);
    // Order of the guarantees: clear and confirm BEFORE add; remove and sign out AFTER.
    const idx = (k: string) => f.calls.indexOf(k);
    expect(idx('clear')).toBeLessThan(idx('add'));
    expect(idx('snapshot:google-account-identity')).toBeLessThan(idx('add'));
    expect(idx('remove')).toBeGreaterThan(idx('click:passkey-continue'));
    expect(idx('navigate:/Logout')).toBeGreaterThan(idx('remove'));
    expect(idx('close')).toBe(f.calls.length - 1);
    expect(JSON.stringify(r)).not.toContain('a@example.com');
  });

  it('not signed out (a warm session) ⇒ unknown, and the credential is NEVER added', async () => {
    const f = fake({ pages: [snap('unknown')], identity: ['match'] });
    const r = await runPasskeyColdProof({ openBrowser: () => f.browser }, INPUT);
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'not-signed-out', observedAssertion: false });
    expect(f.browser.addCredential).not.toHaveBeenCalled();
    expect(r.teardown).toMatchObject({ credentialRemoved: true, signedOut: true });
  });

  it('a signed-in match WITHOUT an observed assertion is unknown, never ready; more than one credential is unknown too', async () => {
    const noAssert = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('unknown')], identity: ['none', 'none', 'match'], assertOnContinue: false });
    expect((await runPasskeyColdProof({ openBrowser: () => noAssert.browser }, INPUT)).outcome).toBe('unknown');
    const two = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('unknown')], identity: ['none', 'none', 'match'], credentialCount: 2 });
    const r = await runPasskeyColdProof({ openBrowser: () => two.browser }, INPUT);
    expect(r).toMatchObject({ outcome: 'unknown', singleCredential: false });
  });

  it('a DIFFERENT identity signed in is security; the not-recognised page is credential-rejected (or removed-on-google for a pending cell); throttled and risk pages are unknown and flagged', async () => {
    const other = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('unknown')], identity: ['none', 'none', 'other'] });
    expect((await runPasskeyColdProof({ openBrowser: () => other.browser }, INPUT)).outcome).toBe('security');
    const rej = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('google-credential-not-recognized')] });
    expect(await runPasskeyColdProof({ openBrowser: () => rej.browser }, INPUT)).toMatchObject({ outcome: 'credential-rejected', reason: 'google-credential-not-recognized' });
    const pending = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('google-credential-not-recognized')] });
    expect((await runPasskeyColdProof({ openBrowser: () => pending.browser }, { ...INPUT, googleSideRemoval: 'pending' })).outcome).toBe('removed-on-google');
    const thr = fake({ pages: [snap('google-account-identity'), snap('google-passkey-throttled')] });
    expect(await runPasskeyColdProof({ openBrowser: () => thr.browser }, INPUT)).toMatchObject({ outcome: 'unknown', throttled: true, reason: 'throttled' });
    const risk = fake({ pages: [snap('google-account-identity'), snap('google-risk-challenge')] });
    expect(await runPasskeyColdProof({ openBrowser: () => risk.browser }, INPUT)).toMatchObject({ outcome: 'unknown', riskPage: true, reason: 'risk-page' });
    const riskFirst = fake({ pages: [snap('google-risk-challenge')] });
    const rf = await runPasskeyColdProof({ openBrowser: () => riskFirst.browser }, INPUT);
    expect(rf).toMatchObject({ outcome: 'unknown', riskPage: true, reason: 'risk-page-before-sign-in' });
    expect(riskFirst.browser.addCredential).not.toHaveBeenCalled();
  });

  it('reached Google, did not sign in, no rejection ⇒ failed; a supervisor picking an un-offered action stops the proof; step budget bounds it', async () => {
    const stuck = fake({ pages: [snap('google-account-identity'), snap('password')] });
    const r = await runPasskeyColdProof({ openBrowser: () => stuck.browser }, INPUT);
    expect(r).toMatchObject({ outcome: 'failed', reason: 'no-action-on-password' });
    const rogue = fake({ pages: [snap('google-account-identity')] });
    const rr = await runPasskeyColdProof({ openBrowser: () => rogue.browser, supervise: async () => 'click-create-passkey' }, INPUT);
    expect(rr).toMatchObject({ outcome: 'failed', reason: 'supervisor-chose-unoffered-action' });
    expect(rogue.browser.click).not.toHaveBeenCalled();
    const loop = fake({ pages: Array.from({ length: 30 }, () => snap('unknown')), identity: Array.from({ length: 30 }, () => 'none' as const) });
    const rl = await runPasskeyColdProof({ openBrowser: () => loop.browser, maxSteps: 3 }, { ...INPUT });
    expect(rl.steps.length).toBeLessThanOrEqual(3);
    expect(rl.outcome).toBe('unknown');
  });

  it('the identity read is POST-SIGN-IN only: an account chip on the passkey prompt never stops the proof early, an email on a refusal page is never security, and a different identity WITHOUT an assertion is unknown', async () => {
    // (a) Google's prompt shows the typed identifier as a chip ⇒ a read there would be a premature `match`.
    const chip = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('unknown')], identity: ['none', 'match', 'match'] });
    const r = await runPasskeyColdProof({ openBrowser: () => chip.browser }, INPUT);
    expect(r.outcome).toBe('ready');
    expect(r.steps.map((s) => `${s.pageClass}:${s.action}`)).toEqual(['google-account-identity:fill-email', 'google-passkey-challenge:click-passkey-continue', 'unknown:stop']);
    // The read happened exactly once — on the unclassified page, after the assertion.
    expect(chip.browser.readSignedInIdentity).toHaveBeenCalledTimes(1);
    // The browser opens BLANK, clears, and only then loads the sign-in page.
    expect(chip.browser.open).toHaveBeenCalledWith('about:blank');
    expect(chip.calls.indexOf('clear')).toBeLessThan(chip.calls.indexOf('navigate:/v3/signin/identifier'));
    // (b) A different email printed on a terminal refusal page is NOT a signed-in identity.
    const refusal = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('google-workspace-policy-blocked')], identity: ['none', 'other', 'other'] });
    const rb = await runPasskeyColdProof({ openBrowser: () => refusal.browser }, INPUT);
    expect(rb).toMatchObject({ outcome: 'failed', signedInIdentity: 'none', reason: 'google-workspace-policy-blocked' });
    expect(refusal.browser.readSignedInIdentity).not.toHaveBeenCalled();
    // (c) A different identity on an unclassified page but with NO assertion consumed: unknown, never security.
    const noAssert = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('unknown')], identity: ['none', 'none', 'other'], assertOnContinue: false });
    const rc = await runPasskeyColdProof({ openBrowser: () => noAssert.browser }, INPUT);
    expect(rc).toMatchObject({ outcome: 'unknown', signedInIdentity: 'none' });
    expect(noAssert.browser.readSignedInIdentity).not.toHaveBeenCalled();
    // (d) A CAPTCHA (parent class) thrown AFTER the assertion, with the email visible, is a risk page ⇒ unknown, never ready.
    const captcha = fake({ pages: [snap('google-account-identity'), snap('google-passkey-challenge'), snap('captcha')], identity: ['none', 'none', 'match'] });
    const rd = await runPasskeyColdProof({ openBrowser: () => captcha.browser }, INPUT);
    expect(rd).toMatchObject({ outcome: 'unknown', riskPage: true, reason: 'risk-page', observedAssertion: true, signedInIdentity: 'none' });
  });

  it('a transport failure is unknown with the error CLASS only, and teardown still runs', async () => {
    const f = fake({ pages: [snap('google-account-identity')], failOn: 'addCredential' });
    const r = await runPasskeyColdProof({ openBrowser: () => f.browser }, INPUT);
    expect(r).toMatchObject({ outcome: 'unknown', reason: 'transport:Error', teardown: { credentialRemoved: true, signedOut: true } });
    // The add failed, so there is nothing to remove; sign-out and close still run.
    expect(f.calls).not.toContain('remove');
    expect(f.calls).toContain('navigate:/Logout');
    expect(f.calls[f.calls.length - 1]).toBe('close');
    expect(JSON.stringify(r)).not.toMatch(/boom|a@example\.com|"pk"/);
  });
});
