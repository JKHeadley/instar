import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicReloginBrowserDriver,
  allowedActions,
  type ReloginBrowserPort,
  type ReloginBrowserSnapshot,
} from '../../src/core/AnthropicReloginBrowserDriver.js';
import { GOOGLE_PASSKEY_PAGE_CLASSES, TERMINAL_GOOGLE_PAGE_CLASSES } from '../../src/core/GooglePasskeyPageClasses.js';

// Spec docs/specs/agent-held-google-passkey.md §3.6 — "Credential-affecting actions have a
// structural floor": structure computes the allowed list, the Tier-1 supervisor may only
// choose from it or decline; it can never add a credential action, and a sign-in drive
// can never mint.

const NOW = 59_000;
const artifact = { attemptId: 'attempt-pk', kind: 'url-code-paste' as const,
  expiresAt: '1970-01-01T00:02:00.000Z', reissueCount: 0 };

function fixture(states: ReloginBrowserSnapshot[], pick?: (allowed: string[]) => string) {
  let index = 0;
  const browser: ReloginBrowserPort = {
    open: vi.fn(async () => {}),
    snapshot: vi.fn(async () => states[Math.min(index++, states.length - 1)]),
    chooseExpectedAccount: vi.fn(async () => {}),
    fillPublic: vi.fn(async () => {}),
    fillSecret: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    readPasteCode: vi.fn(async () => 'returned-code'),
    wait: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const resolveSecret = vi.fn(async (name: string) => name === 'backup-ref' ? 'ABCD-EFGH' : 'hunter-2');
  const supervise = vi.fn(async ({ allowedActions }: { allowedActions: string[] }) => (pick ? pick(allowedActions) : allowedActions[0]) as never);
  const seatLease = { acquire: vi.fn(() => ({ acquired: true })), release: vi.fn() };
  const driver = new AnthropicReloginBrowserDriver({ browser, resolveSecret, supervise, seatLease, now: () => NOW, maxSteps: 10 });
  return { browser, resolveSecret, supervise, driver };
}

function state(pageClass: ReloginBrowserSnapshot['pageClass'], extra: Partial<ReloginBrowserSnapshot> = {}): ReloginBrowserSnapshot {
  return { origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: true,
    hasGoogleSignIn: false, hasNext: true, hasAuthorize: false, requestedScopes: [], ...extra };
}

const passkeyRequest = {
  artifact, verificationUrl: 'https://claude.ai/oauth/authorize?opaque=1', provider: 'anthropic' as const,
  expectedIdentity: 'operator@example.com', loginMethod: 'google-passkey' as const,
  secretRefs: {}, allowedScopes: ['user:profile'],
};
const passwordRequest = { ...passkeyRequest, loginMethod: 'password+totp' as const, secretRefs: { password: 'p', totp: 't' } };

describe('allowedActions — the structural floor for the closed Google page classes', () => {
  it('lets a passkey drive continue the passkey prompt, and a password drive step past it; nothing else may touch it', () => {
    const snap = state('google-passkey-challenge');
    expect(allowedActions(snap, passkeyRequest)).toEqual(['click-passkey-continue']);
    expect(allowedActions(snap, passwordRequest)).toEqual(['click-try-another-way']);
    expect(allowedActions(snap, { ...passkeyRequest, loginMethod: 'session-cookie' })).toEqual([]);
  });

  it('exposes credential-CREATING controls only under intent: enroll, and only on their exact class', () => {
    const create = state('google-passkey-create', { hasNotNow: true });
    expect(allowedActions(create, passkeyRequest)).toEqual(['click-not-now']);
    expect(allowedActions(create, { ...passkeyRequest, intent: 'sign-in' })).toEqual(['click-not-now']);
    expect(allowedActions(create, { ...passkeyRequest, intent: 'enroll' })).toEqual(['click-create-passkey', 'click-not-now']);
    expect(allowedActions(state('google-passkey-create'), passkeyRequest)).toEqual([]);
    expect(allowedActions(state('google-passkey-create-confirm'), passkeyRequest)).toEqual([]);
    expect(allowedActions(state('google-passkey-create-confirm'), { ...passkeyRequest, intent: 'enroll' })).toEqual(['click-create-passkey-confirm']);
    // A create control never leaks onto a different class, whatever the intent.
    expect(allowedActions(state('google-passkey-challenge'), { ...passkeyRequest, intent: 'enroll' })).toEqual(['click-passkey-continue']);
    expect(allowedActions(state('google-account-identity'), { ...passkeyRequest, intent: 'enroll' })).toEqual(['fill-email']);
  });

  it('admits a backup-code fill only in an enroll drive that carries a code ref; TOTP keeps the parent rule', () => {
    const bc = state('google-backup-code-entry');
    expect(allowedActions(bc, passwordRequest)).toEqual([]);
    expect(allowedActions(bc, { ...passwordRequest, intent: 'enroll' })).toEqual([]);
    expect(allowedActions(bc, { ...passwordRequest, intent: 'enroll', secretRefs: { backupCode: 'backup-ref' } })).toEqual(['fill-backup-code']);
    expect(allowedActions(state('google-totp-entry'), passwordRequest)).toEqual(['fill-totp']);
    expect(allowedActions(state('google-totp-entry'), passkeyRequest)).toEqual([]);
  });

  it('allows nothing on every terminal class, and covers every class in the closed set', () => {
    for (const cls of GOOGLE_PASSKEY_PAGE_CLASSES) {
      const list = allowedActions(state(cls, { hasNotNow: true }), { ...passwordRequest, intent: 'enroll', secretRefs: { password: 'p', totp: 't', backupCode: 'b' } });
      if (TERMINAL_GOOGLE_PAGE_CLASSES.has(cls)) expect(list, cls).toEqual([]);
      else expect(list.length, cls).toBeGreaterThan(0);
    }
  });
});

describe('AnthropicReloginBrowserDriver — driving the closed Google page classes', () => {
  it('signs in through the passkey prompt with the passkey method (identifier → prompt → success)', async () => {
    const f = fixture([state('google-account-identity'), state('google-passkey-challenge'), state('success', { origin: 'https://claude.ai' })]);
    expect(await f.driver.drive(passkeyRequest)).toEqual({ outcome: 'approved' });
    expect(f.browser.fillPublic).toHaveBeenCalledWith('email', 'operator@example.com');
    expect(f.browser.click).toHaveBeenCalledWith('passkey-continue');
    expect(f.browser.fillSecret).not.toHaveBeenCalled();
  });

  it('a password drive steps past the passkey prompt with Try another way, never Continue', async () => {
    const f = fixture([state('google-passkey-challenge'), state('password'), state('success', { origin: 'https://claude.ai' })]);
    expect(await f.driver.drive(passwordRequest)).toEqual({ outcome: 'approved' });
    expect(f.browser.click).toHaveBeenCalledWith('try-another-way');
    expect(f.browser.click).not.toHaveBeenCalledWith('passkey-continue');
  });

  it('treats a Google risk page as an operator-only CAPTCHA, before any action', async () => {
    const f = fixture([state('google-risk-challenge')]);
    expect(await f.driver.drive(passkeyRequest)).toEqual({ outcome: 'operator-only', failureClass: 'captcha' });
    expect(f.supervise).not.toHaveBeenCalled();
  });

  it('ends on every terminal passkey page with the passkey-specific refusal and no supervision (account-origin classes on their real origin, under enroll)', async () => {
    const ACCOUNT_ORIGIN_CLASSES = new Set(['google-passkey-list', 'google-already-enrolled', 'google-workspace-policy-blocked']);
    for (const cls of TERMINAL_GOOGLE_PAGE_CLASSES) {
      if (cls === 'google-risk-challenge') continue;
      const onAccount = ACCOUNT_ORIGIN_CLASSES.has(cls);
      const f = fixture([state(cls, onAccount ? { origin: 'https://myaccount.google.com' } : {})]);
      const req = onAccount ? { ...passkeyRequest, intent: 'enroll' as const } : passkeyRequest;
      expect(await f.driver.drive(req), cls).toEqual({ outcome: 'refused', failureClass: 'passkey-refused' });
      expect(f.supervise).not.toHaveBeenCalled();
    }
  });

  it('a SIGN-IN drive that lands on the account origin is refused as an unexpected origin before any class logic', async () => {
    const f = fixture([state('google-passkey-create', { origin: 'https://myaccount.google.com', hasNotNow: true })]);
    expect(await f.driver.drive(passkeyRequest)).toEqual({ outcome: 'refused', failureClass: 'unexpected-origin' });
    expect(f.supervise).not.toHaveBeenCalled();
    expect(f.browser.click).not.toHaveBeenCalled();
  });

  it('a sign-in drive declines the enrollment speedbump (Not now) on accounts.google.com and never creates', async () => {
    const f = fixture([state('google-passkey-create', { hasNotNow: true }), state('success', { origin: 'https://claude.ai' })]);
    expect(await f.driver.drive(passkeyRequest)).toEqual({ outcome: 'approved' });
    expect(f.browser.click).toHaveBeenCalledWith('not-now');
    expect(f.browser.click).not.toHaveBeenCalledWith('create-passkey');
  });

  it('a supervisor that picks a create action it was not offered is refused — it can decline, never add', async () => {
    const f = fixture([state('google-passkey-create', { hasNotNow: true })], () => 'click-create-passkey');
    expect(await f.driver.drive(passkeyRequest)).toEqual({ outcome: 'refused', failureClass: 'provider-rejected' });
    expect(f.browser.click).not.toHaveBeenCalled();
  });

  it('an enroll drive creates and confirms, and a backup code is resolved only for the fill and never shown to supervision', async () => {
    const f = fixture([
      state('google-backup-code-entry'),
      state('google-passkey-create', { origin: 'https://myaccount.google.com' }),
      state('google-passkey-create-confirm', { origin: 'https://myaccount.google.com' }),
      state('success', { origin: 'https://claude.ai' }),
    ]);
    const enroll = { ...passkeyRequest, intent: 'enroll' as const, secretRefs: { backupCode: 'backup-ref' } };
    expect(await f.driver.drive(enroll)).toEqual({ outcome: 'approved' });
    expect(f.browser.fillSecret).toHaveBeenCalledWith('backup-code', 'ABCD-EFGH');
    expect(f.browser.click).toHaveBeenCalledWith('create-passkey');
    expect(f.browser.click).toHaveBeenCalledWith('create-passkey-confirm');
    expect(JSON.stringify(f.supervise.mock.calls)).not.toContain('ABCD-EFGH');
  });
});
