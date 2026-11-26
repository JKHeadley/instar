import { describe, it, expect } from 'vitest';
import {
  ACCOUNTS_GOOGLE_ORIGIN,
  isGoogleOrigin,
  mayAddCredential,
  mustRemoveCredentialBefore,
  originOf,
  PASSKEY_SESSION_CHROME_ARGS,
  isRpFamilyOrigin,
  type OriginPolicy,
} from '../../src/core/PasskeyBrowserPolicy.js';

const FIXTURE: OriginPolicy = { holderOrigin: 'http://localhost:4111', apexHost: 'localhost', allowInsecure: true };

// Spec agent-held-google-passkey §1.1 / §3.1 / §3.5: where the passkey may live.

describe('isGoogleOrigin', () => {
  it.each([
    ['https://accounts.google.com', true],
    ['https://google.com', true],
    ['https://myaccount.google.com', true],
    ['https://www.google.com', true],
    ['http://accounts.google.com', false], // not https
    ['https://google.com.evil.example', false],
    ['https://notgoogle.com', false],
    ['https://claude.ai', false],
    ['https://www.recaptcha.net', false],
  ])('%s → %s', (origin, expected) => {
    expect(isGoogleOrigin(origin)).toBe(expected);
  });
});

describe('mustRemoveCredentialBefore (request-time removal)', () => {
  it('keeps the credential for accounts.google.com documents, top-level or framed', () => {
    expect(mustRemoveCredentialBefore({ url: `${ACCOUNTS_GOOGLE_ORIGIN}/signin/v2`, topLevel: true })).toBe(false);
    expect(mustRemoveCredentialBefore({ url: `${ACCOUNTS_GOOGLE_ORIGIN}/o/oauth2/iframe`, topLevel: false })).toBe(false);
  });
  it('removes before ANY top-level navigation away from accounts.google.com', () => {
    expect(mustRemoveCredentialBefore({ url: 'https://myaccount.google.com/', topLevel: true })).toBe(true);
    expect(mustRemoveCredentialBefore({ url: 'https://claude.ai/login', topLevel: true })).toBe(true);
    expect(mustRemoveCredentialBefore({ url: 'https://auth.openai.com/device', topLevel: true })).toBe(true);
  });
  it('removes before a subframe navigates to another google.com origin (RP-bound, not origin-bound)', () => {
    expect(mustRemoveCredentialBefore({ url: 'https://myaccount.google.com/frame', topLevel: false })).toBe(true);
    expect(mustRemoveCredentialBefore({ url: 'https://www.google.com/recaptcha/api2/anchor', topLevel: false })).toBe(true);
  });
  it('allows a subframe on an unrelated site (it cannot claim a google.com passkey)', () => {
    expect(mustRemoveCredentialBefore({ url: 'https://www.recaptcha.net/recaptcha/api2/anchor', topLevel: false })).toBe(false);
    expect(mustRemoveCredentialBefore({ url: 'https://www.gstatic.com/frame', topLevel: false })).toBe(false);
  });
  it('fails closed on an unparseable URL', () => {
    expect(mustRemoveCredentialBefore({ url: 'not a url', topLevel: false })).toBe(true);
  });
});

describe('mayAddCredential (all-frames rule)', () => {
  it('requires the top-level frame on accounts.google.com', () => {
    expect(mayAddCredential([{ origin: ACCOUNTS_GOOGLE_ORIGIN, topLevel: true }])).toBe(true);
    expect(mayAddCredential([{ origin: 'https://myaccount.google.com', topLevel: true }])).toBe(false);
    expect(mayAddCredential([])).toBe(false);
  });
  it('refuses while any frame is on a different google.com origin, allows unrelated frames', () => {
    expect(mayAddCredential([
      { origin: ACCOUNTS_GOOGLE_ORIGIN, topLevel: true },
      { origin: 'https://www.google.com', topLevel: false },
    ])).toBe(false);
    expect(mayAddCredential([
      { origin: ACCOUNTS_GOOGLE_ORIGIN, topLevel: true },
      { origin: 'https://www.recaptcha.net', topLevel: false },
      { origin: ACCOUNTS_GOOGLE_ORIGIN, topLevel: false },
    ])).toBe(true);
  });
});

describe('fixture policy (the same rules against the local WebAuthn relying party)', () => {
  it('treats localhost on any port as the RP family, http allowed only by the fixture policy', () => {
    expect(isRpFamilyOrigin('http://localhost:4111', FIXTURE)).toBe(true);
    expect(isRpFamilyOrigin('http://localhost:4222', FIXTURE)).toBe(true);
    expect(isRpFamilyOrigin('http://localhost:4111')).toBe(false); // production policy: https + google.com only
    expect(isRpFamilyOrigin('http://127.0.0.1:4111', FIXTURE)).toBe(false);
  });
  it('removes before a top-level move to another localhost port and keeps for the holder origin', () => {
    expect(mustRemoveCredentialBefore({ url: 'http://localhost:4111/page', topLevel: true }, FIXTURE)).toBe(false);
    expect(mustRemoveCredentialBefore({ url: 'http://localhost:4222/other', topLevel: true }, FIXTURE)).toBe(true);
    expect(mustRemoveCredentialBefore({ url: 'http://localhost:4222/frame', topLevel: false }, FIXTURE)).toBe(true);
    expect(mustRemoveCredentialBefore({ url: 'http://127.0.0.1:4333/frame', topLevel: false }, FIXTURE)).toBe(false);
  });
});

describe('launch flags', () => {
  it('use the debugging pipe, disable extensions and prerendering', () => {
    expect(PASSKEY_SESSION_CHROME_ARGS).toContain('--remote-debugging-pipe');
    expect(PASSKEY_SESSION_CHROME_ARGS).toContain('--disable-extensions');
    expect(PASSKEY_SESSION_CHROME_ARGS).toContain('--disable-component-extensions-with-background-pages');
    expect(PASSKEY_SESSION_CHROME_ARGS.some((a) => a.includes('Prerender2'))).toBe(true);
    expect(PASSKEY_SESSION_CHROME_ARGS.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });
  it('originOf parses or returns null', () => {
    expect(originOf('https://accounts.google.com/x?y=1')).toBe(ACCOUNTS_GOOGLE_ORIGIN);
    expect(originOf('nope')).toBeNull();
  });
});
