import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicReloginBrowserDriver,
  allowedActions,
  generateTotp,
  safeAllowedUrl,
  type ReloginBrowserPort,
  type ReloginBrowserSnapshot,
} from '../../src/core/AnthropicReloginBrowserDriver.js';

const NOW = 59_000;
const artifact = { attemptId: 'attempt-1', kind: 'url-code-paste' as const,
  expiresAt: '1970-01-01T00:02:00.000Z', reissueCount: 0 };

function fixture(states: ReloginBrowserSnapshot[]) {
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
  const resolveSecret = vi.fn(async (name: string) => name === 'password-ref' ? 'hunter-2' : 'JBSWY3DPEHPK3PXP');
  const supervise = vi.fn(async ({ allowedActions }: { allowedActions: string[] }) => allowedActions[0] as never);
  const seatLease = { acquire: vi.fn(() => ({ acquired: true })), release: vi.fn() };
  const driver = new AnthropicReloginBrowserDriver({ browser, resolveSecret, supervise, seatLease, now: () => NOW, maxSteps: 10 });
  const request = {
    artifact,
    verificationUrl: 'https://claude.ai/oauth/authorize?opaque=1',
    expectedIdentity: 'operator@example.com',
    loginMethod: 'password+totp' as const,
    secretRefs: { password: 'password-ref', totp: 'totp-ref' },
    allowedScopes: ['user:profile'],
  };
  return { browser, resolveSecret, supervise, seatLease, driver, request };
}

function state(pageClass: ReloginBrowserSnapshot['pageClass'], extra: Partial<ReloginBrowserSnapshot> = {}): ReloginBrowserSnapshot {
  return { origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: true,
    hasNext: true, hasAuthorize: false, requestedScopes: [], ...extra };
}

describe('AnthropicReloginBrowserDriver', () => {
  it('drives account, password, TOTP, authorization, and paste-back without exposing secret values to supervision', async () => {
    const f = fixture([
      state('account-chooser'), state('password'), state('totp'),
      state('authorize', { origin: 'https://claude.ai', hasAuthorize: true, requestedScopes: ['user:profile'] }),
      state('paste-code', { origin: 'https://claude.ai' }),
    ]);
    const result = await f.driver.drive(f.request);
    expect(result).toEqual({ outcome: 'approved', pasteCode: 'returned-code' });
    expect(f.browser.chooseExpectedAccount).toHaveBeenCalledWith('operator@example.com');
    expect(f.browser.fillSecret).toHaveBeenCalledWith('password', 'hunter-2');
    expect(f.browser.fillSecret).toHaveBeenCalledWith('totp', '996554');
    expect(JSON.stringify(f.supervise.mock.calls)).not.toContain('hunter-2');
    expect(JSON.stringify(f.supervise.mock.calls)).not.toContain('JBSWY3DPEHPK3PXP');
    expect(f.browser.close).toHaveBeenCalledOnce();
    expect(f.seatLease.release).toHaveBeenCalledWith('subscription-relogin:attempt-1');
  });

  it('refuses a busy host browser seat before opening or resolving any secret', async () => {
    const f = fixture([state('password')]);
    f.seatLease.acquire.mockReturnValue({ acquired: false });
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'transient', failureClass: 'seat-busy' });
    expect(f.browser.open).not.toHaveBeenCalled();
    expect(f.resolveSecret).not.toHaveBeenCalled();
    expect(f.seatLease.release).not.toHaveBeenCalled();
  });

  it('refuses any initial or redirected origin outside the exact allowlist', async () => {
    const initial = fixture([state('success')]);
    expect(await initial.driver.drive({ ...initial.request, verificationUrl: 'https://claude.ai.evil.example/oauth' }))
      .toEqual({ outcome: 'refused', failureClass: 'unexpected-origin' });
    expect(initial.browser.open).not.toHaveBeenCalled();

    const redirect = fixture([state('password', { origin: 'https://accounts.google.com.evil.example' })]);
    expect(await redirect.driver.drive(redirect.request)).toEqual({ outcome: 'refused', failureClass: 'unexpected-origin' });
  });

  it.each([
    ['captcha', 'captcha'], ['phone-confirmation', 'phone-confirmation'],
    ['permission-expansion', 'permission-expansion'],
  ] as const)('stops at operator-only page %s', async (pageClass, failureClass) => {
    const f = fixture([state(pageClass)]);
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'operator-only', failureClass });
    expect(f.browser.fillSecret).not.toHaveBeenCalled();
  });

  it('refuses scope expansion before the authorize click', async () => {
    const f = fixture([state('authorize', { origin: 'https://claude.ai', hasAuthorize: true,
      requestedScopes: ['user:profile', 'billing:write'] })]);
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'operator-only', failureClass: 'permission-expansion' });
    expect(f.browser.click).not.toHaveBeenCalled();
  });

  it('requires secret refs for secret-bearing pages and never substitutes an LLM guess', async () => {
    const f = fixture([state('password')]);
    const result = await f.driver.drive({ ...f.request, secretRefs: {} });
    expect(result).toEqual({ outcome: 'transient', failureClass: 'provider-transient' });
    expect(f.supervise).not.toHaveBeenCalled();
    expect(f.browser.fillSecret).not.toHaveBeenCalled();
  });

  it('rejects a supervisor action outside the deterministic allowed set', async () => {
    const f = fixture([state('password')]);
    f.supervise.mockResolvedValue('click-authorize' as never);
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'refused', failureClass: 'provider-rejected' });
    expect(f.browser.fillSecret).not.toHaveBeenCalled();
  });

  it('uses the RFC 6238 vector and validates URLs/actions independently', () => {
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000, 8)).toBe('94287082');
    expect(safeAllowedUrl('https://console.anthropic.com/oauth/authorize?x=1')).toBe(true);
    expect(safeAllowedUrl('https://claude.com/cai/oauth/authorize?scope=user%3Aprofile')).toBe(true);
    expect(safeAllowedUrl('https://platform.claude.com/oauth/code/callback')).toBe(true);
    expect(safeAllowedUrl('http://claude.ai/oauth')).toBe(false);
    expect(safeAllowedUrl('https://user:pass@claude.ai/oauth')).toBe(false);
    expect(allowedActions(state('password'), { loginMethod: 'session-cookie', secretRefs: {} })).toEqual([]);
  });
});
