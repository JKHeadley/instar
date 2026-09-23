import { describe, expect, it } from 'vitest';
import {
  GOOGLE_PASSKEY_PAGE_CLASSES,
  PAGE_CLASS_PROVENANCE,
  TERMINAL_GOOGLE_PAGE_CLASSES,
  classifyGooglePasskeyPage,
  mapPasskeySignInOutcome,
  type GooglePageFacts,
  type PasskeySignInObservation,
} from '../../src/core/GooglePasskeyPageClasses.js';
import { GOOGLE_ORIGIN_POLICY } from '../../src/core/PasskeyBrowserPolicy.js';

// Spec docs/specs/agent-held-google-passkey.md §3.6 — the closed page classes are
// STRUCTURAL matches (exact origin, sign-in route, ids/roles/exact labels) and an
// unmatched page is null (⇒ the parent chain ⇒ `unknown`), plus the outcome mapping.

const ORIGINS = { holderOrigin: 'https://accounts.google.com', accountOrigin: 'https://myaccount.google.com' };

function facts(over: Partial<GooglePageFacts> = {}): GooglePageFacts {
  return {
    origin: ORIGINS.holderOrigin, pathname: '/', ids: [], controlLabels: [],
    hasPasswordInput: false, hasDialog: false, hasAlert: false, hasCaptchaWidget: false, hasAdminHelpLink: false,
    ...over,
  };
}
const classify = (over: Partial<GooglePageFacts>) => classifyGooglePasskeyPage(facts(over), ORIGINS);

describe('classifyGooglePasskeyPage — closed structural classes (§3.6)', () => {
  it('names every class exactly once, with a provenance row each, and the production policy carries the account origin', () => {
    expect(new Set(GOOGLE_PASSKEY_PAGE_CLASSES).size).toBe(12);
    for (const cls of GOOGLE_PASSKEY_PAGE_CLASSES) expect(['measured', 'documented']).toContain(PAGE_CLASS_PROVENANCE[cls]);
    expect(GOOGLE_ORIGIN_POLICY.accountOrigin).toBe('https://myaccount.google.com');
    expect(GOOGLE_ORIGIN_POLICY.holderOrigin).toBe('https://accounts.google.com');
  });

  it('matches the sign-in pages on the holder origin by route + stable id, on every route generation', () => {
    for (const prefix of ['/v3/signin', '/signin/v2', '/signin']) {
      expect(classify({ pathname: `${prefix}/identifier`, ids: ['identifierId'] })).toBe('google-account-identity');
      expect(classify({ pathname: `${prefix}/challenge/pk/presend`, controlLabels: ['continue', 'try another way'] })).toBe('google-passkey-challenge');
      expect(classify({ pathname: `${prefix}/challenge/pk`, controlLabels: ['Continue'] })).toBe('google-passkey-challenge');
      expect(classify({ pathname: `${prefix}/challenge/totp`, ids: ['totpPin'] })).toBe('google-totp-entry');
      expect(classify({ pathname: `${prefix}/challenge/bc`, ids: ['backupCodePin'] })).toBe('google-backup-code-entry');
      expect(classify({ pathname: `${prefix}/challenge/recaptcha` })).toBe('google-risk-challenge');
      expect(classify({ pathname: `${prefix}/challenge/ipp` })).toBe('google-risk-challenge');
      expect(classify({ pathname: `${prefix}/rejected` })).toBe('google-risk-challenge');
    }
  });

  it('requires the stable id, not the route alone, for identifier / TOTP / backup-code pages', () => {
    expect(classify({ pathname: '/v3/signin/identifier' })).toBeNull();
    expect(classify({ pathname: '/v3/signin/challenge/totp', ids: ['other'] })).toBeNull();
    expect(classify({ pathname: '/v3/signin/challenge/bc' })).toBeNull();
    // A passkey route with no Continue control is not the challenge page.
    expect(classify({ pathname: '/v3/signin/challenge/pk/presend', controlLabels: ['next'] })).toBeNull();
  });

  it('errs toward restriction: a CAPTCHA widget or risk route wins over every other page shape', () => {
    expect(classify({ pathname: '/v3/signin/challenge/pk/presend', controlLabels: ['continue'], hasCaptchaWidget: true })).toBe('google-risk-challenge');
    expect(classify({ pathname: '/v3/signin/identifier', ids: ['identifierId'], hasCaptchaWidget: true })).toBe('google-risk-challenge');
    expect(classify({ pathname: '/v3/signin/challenge/recaptcha', hasPasswordInput: true })).toBe('google-risk-challenge');
  });

  it('splits the passkey challenge by its alert state: a live Continue is ALWAYS the prompt; rejection needs the action gone + a visible alert', () => {
    const base = { pathname: '/v3/signin/challenge/pk/presend', controlLabels: ['continue', 'try another way'] };
    expect(classify(base)).toBe('google-passkey-challenge');
    // A live region announcing something on a prompt that still offers Continue is NOT a rejection
    // (a false `credential-not-recognized` feeds suspension — the one mis-read that is not safe).
    expect(classify({ ...base, hasAlert: true })).toBe('google-passkey-challenge');
    expect(classify({ ...base, hasAlert: true, controlLabels: ['try another way'] })).toBe('google-credential-not-recognized');
    expect(classify({ ...base, hasAlert: true, controlLabels: ['try again later', 'try another way'] })).toBe('google-passkey-throttled');
    // Alert with neither control, or no alert with no Continue: unknown, never a rejection.
    expect(classify({ ...base, hasAlert: true, controlLabels: [] })).toBeNull();
    expect(classify({ ...base, controlLabels: ['try another way'] })).toBeNull();
  });

  it('recognises the enrollment speedbump and its confirm dialog on the holder origin', () => {
    expect(classify({ pathname: '/speedbump/passkeyenrollment', controlLabels: ['create a passkey', 'not now'] })).toBe('google-passkey-create');
    expect(classify({ pathname: '/signin/v2/speedbump/passkeyenrollment', controlLabels: ['create a passkey'] })).toBe('google-passkey-create');
    expect(classify({ pathname: '/speedbump/passkeyenrollment', controlLabels: ['create a passkey', 'continue'], hasDialog: true })).toBe('google-passkey-create-confirm');
    expect(classify({ pathname: '/speedbump/passkeyenrollment', controlLabels: ['not now'] })).toBeNull();
  });

  it('classifies the account-origin passkey settings page: list, create, confirm, already enrolled, Workspace blocked', () => {
    const acct = { origin: ORIGINS.accountOrigin, pathname: '/signinoptions/passkeys' };
    expect(classify(acct)).toBe('google-passkey-list');
    expect(classify({ ...acct, controlLabels: ['create a passkey'] })).toBe('google-passkey-create');
    expect(classify({ ...acct, controlLabels: ['create a passkey', 'continue'], hasDialog: true })).toBe('google-passkey-create-confirm');
    expect(classify({ ...acct, controlLabels: ['done'], hasDialog: true })).toBe('google-already-enrolled');
    expect(classify({ ...acct, controlLabels: ['done', 'create a passkey'], hasDialog: true })).toBe('google-passkey-create');
    expect(classify({ ...acct, hasAlert: true, hasAdminHelpLink: true })).toBe('google-workspace-policy-blocked');
    // An alert WITHOUT the admin link is not the Workspace refusal — it stays the read-only list.
    expect(classify({ ...acct, hasAlert: true })).toBe('google-passkey-list');
  });

  it('never matches off the exact origins: look-alike hosts, the wrong origin for a route, or an empty account origin', () => {
    expect(classify({ origin: 'https://accounts.google.com.evil.example', pathname: '/v3/signin/identifier', ids: ['identifierId'] })).toBeNull();
    expect(classify({ origin: 'https://myaccount.google.com', pathname: '/v3/signin/identifier', ids: ['identifierId'] })).toBeNull();
    expect(classify({ origin: 'https://accounts.google.com', pathname: '/signinoptions/passkeys', controlLabels: ['create a passkey'] })).toBeNull();
    expect(classifyGooglePasskeyPage(facts({ origin: '', pathname: '/signinoptions/passkeys' }), { holderOrigin: 'https://accounts.google.com', accountOrigin: '' })).toBeNull();
    expect(classify({ pathname: '/', controlLabels: ['continue'] })).toBeNull();
  });

  it('is self-contained: the serialised function (as the browser injects it) yields the same verdicts', () => {
    const injected = new Function(`return (${classifyGooglePasskeyPage.toString()});`)() as typeof classifyGooglePasskeyPage;
    const cases: Partial<GooglePageFacts>[] = [
      { pathname: '/v3/signin/identifier', ids: ['identifierId'] },
      { pathname: '/v3/signin/challenge/pk/presend', controlLabels: ['continue'], hasAlert: true },
      { origin: ORIGINS.accountOrigin, pathname: '/signinoptions/passkeys', hasAlert: true, hasAdminHelpLink: true },
      { pathname: '/nowhere' },
    ];
    for (const c of cases) expect(injected(facts(c), ORIGINS)).toBe(classify(c));
  });

  it('marks exactly the six no-action classes terminal', () => {
    expect([...TERMINAL_GOOGLE_PAGE_CLASSES].sort()).toEqual([
      'google-already-enrolled', 'google-credential-not-recognized', 'google-passkey-list',
      'google-passkey-throttled', 'google-risk-challenge', 'google-workspace-policy-blocked',
    ]);
  });
});

describe('mapPasskeySignInOutcome (§3.6 outcome mapping, §3.8 ready conditions)', () => {
  const obs = (over: Partial<PasskeySignInObservation> = {}): PasskeySignInObservation => ({
    finalPageClass: 'success', signedInIdentity: 'match', observedAssertion: true, singleCredential: true,
    transportError: false, googleSideRemoval: 'none', ...over,
  });

  it('ready requires identity match AND observed assertion AND a single-credential authenticator', () => {
    expect(mapPasskeySignInOutcome(obs())).toBe('ready');
    expect(mapPasskeySignInOutcome(obs({ observedAssertion: false }))).toBe('unknown');
    expect(mapPasskeySignInOutcome(obs({ singleCredential: false }))).toBe('unknown');
  });

  it('a different signed-in identity is security, before anything else', () => {
    expect(mapPasskeySignInOutcome(obs({ signedInIdentity: 'mismatch' }))).toBe('security');
    expect(mapPasskeySignInOutcome(obs({ signedInIdentity: 'mismatch', transportError: true }))).toBe('security');
    expect(mapPasskeySignInOutcome(obs({ signedInIdentity: 'mismatch', finalPageClass: 'google-credential-not-recognized' }))).toBe('security');
  });

  it('the not-recognized page is credential-rejected, or removed-on-google while removal is pending/attested/verified', () => {
    const rej = { finalPageClass: 'google-credential-not-recognized', signedInIdentity: 'none' as const, observedAssertion: true };
    expect(mapPasskeySignInOutcome(obs(rej))).toBe('credential-rejected');
    for (const state of ['pending', 'attested', 'verified'] as const)
      expect(mapPasskeySignInOutcome(obs({ ...rej, googleSideRemoval: state }))).toBe('removed-on-google');
    // Restriction wins over a stale identity read: a rejection page with a matching identity is still rejected.
    expect(mapPasskeySignInOutcome(obs({ ...rej, signedInIdentity: 'match' }))).toBe('credential-rejected');
  });

  it('transport errors, risk pages, throttling and unmatched pages are unknown; a reached-but-not-signed-in page is failed', () => {
    expect(mapPasskeySignInOutcome(obs({ transportError: true, signedInIdentity: 'none' }))).toBe('unknown');
    for (const cls of ['google-risk-challenge', 'google-passkey-throttled', 'unknown'])
      expect(mapPasskeySignInOutcome(obs({ finalPageClass: cls, signedInIdentity: 'none' }))).toBe('unknown');
    expect(mapPasskeySignInOutcome(obs({ finalPageClass: 'password', signedInIdentity: 'none' }))).toBe('failed');
    expect(mapPasskeySignInOutcome(obs({ finalPageClass: 'google-passkey-challenge', signedInIdentity: 'none' }))).toBe('failed');
  });
});
