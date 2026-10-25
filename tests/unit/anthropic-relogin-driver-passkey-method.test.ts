import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicReloginBrowserDriver,
  allowedActions,
  type ReloginBrowserPort,
  type ReloginBrowserSnapshot,
} from '../../src/core/AnthropicReloginBrowserDriver.js';

// Spec docs/specs/agent-held-google-passkey.md §3.4 — NO fall-through: a repair admitted under
// `google-passkey` never fills a password, even when a password binding is also present.

const artifact = { attemptId: 'attempt-1', kind: 'url-code-paste' as const, expiresAt: '1970-01-01T00:02:00.000Z', reissueCount: 0 };
const state = (pageClass: ReloginBrowserSnapshot['pageClass']): ReloginBrowserSnapshot => ({
  origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: true,
  hasGoogleSignIn: false, hasNext: true, hasAuthorize: false, requestedScopes: [],
});

describe('AnthropicReloginBrowserDriver — google-passkey has no password fall-through', () => {
  it('allowedActions: a password page offers NO fill under google-passkey even with a password ref; totp likewise', () => {
    const refs = { password: 'password-ref', totp: 'totp-ref' };
    expect(allowedActions(state('password'), { artifact, loginMethod: 'google-passkey', secretRefs: refs })).toEqual([]);
    expect(allowedActions(state('totp'), { artifact, loginMethod: 'google-passkey', secretRefs: refs })).toEqual([]);
    // The password-family methods are unchanged.
    expect(allowedActions(state('password'), { artifact, loginMethod: 'password', secretRefs: refs })).toEqual(['fill-password']);
    expect(allowedActions(state('password'), { artifact, loginMethod: 'password+totp', secretRefs: refs })).toEqual(['fill-password']);
    expect(allowedActions(state('totp'), { artifact, loginMethod: 'password+totp', secretRefs: refs })).toEqual(['fill-totp']);
    expect(allowedActions(state('password'), { artifact, loginMethod: 'session-cookie', secretRefs: refs })).toEqual([]);
  });

  it('perform: a fill-password action chosen for a google-passkey request is refused before any secret is resolved', async () => {
    const browser: ReloginBrowserPort = {
      open: vi.fn(async () => {}), snapshot: vi.fn(async () => state('password')), chooseExpectedAccount: vi.fn(async () => {}),
      fillPublic: vi.fn(async () => {}), fillSecret: vi.fn(async () => {}), click: vi.fn(async () => {}),
      readPasteCode: vi.fn(async () => null), wait: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    const resolveSecret = vi.fn(async () => 'hunter-2');
    // A supervisor that (wrongly) insists on a password fill: the driver must still not do it.
    const supervise = vi.fn(async () => 'fill-password' as never);
    const driver = new AnthropicReloginBrowserDriver({ browser, resolveSecret, supervise,
      seatLease: { acquire: vi.fn(() => ({ acquired: true })), release: vi.fn() } as never, now: () => 59_000 });
    const result = await driver.drive({ artifact, verificationUrl: 'https://claude.ai/oauth/authorize', provider: 'anthropic',
      expectedIdentity: 'justin@example.com', loginMethod: 'google-passkey', secretRefs: { password: 'password-ref' }, allowedScopes: [] },
      new AbortController().signal);
    expect(browser.fillSecret).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(result.outcome).not.toBe('approved');
  });
});
