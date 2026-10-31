import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicReloginBrowserDriver,
  INTERSTITIAL_POLL_MS,
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
    provider: 'anthropic' as const,
    expectedIdentity: 'operator@example.com',
    loginMethod: 'password+totp' as const,
    secretRefs: { password: 'password-ref', totp: 'totp-ref' },
    allowedScopes: ['user:profile'],
  };
  return { browser, resolveSecret, supervise, seatLease, driver, request };
}

function state(pageClass: ReloginBrowserSnapshot['pageClass'], extra: Partial<ReloginBrowserSnapshot> = {}): ReloginBrowserSnapshot {
  return { origin: 'https://accounts.google.com', pageClass, expectedAccountVisible: true,
    hasGoogleSignIn: false, hasNext: true, hasAuthorize: false, requestedScopes: [], ...extra };
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

  it('drives both provider-owned Continue with Google entry and an OpenAI device code without operator clicks', async () => {
    const f = fixture([
      state('device-code', { origin: 'https://auth.openai.com' }),
      state('provider-choice', { origin: 'https://auth.openai.com', hasGoogleSignIn: true }),
      state('account-chooser'),
      state('device-approval', { origin: 'https://auth.openai.com', hasAuthorize: true }),
      state('success', { origin: 'https://auth.openai.com' }),
    ]);
    const result = await f.driver.drive({ ...f.request, provider: 'openai',
      verificationUrl: 'https://auth.openai.com/codex/device',
      artifact: { ...artifact, kind: 'device-code', userCode: 'ABCD-1234' } });
    expect(result).toEqual({ outcome: 'approved' });
    expect(f.browser.fillPublic).toHaveBeenCalledWith('device-code', 'ABCD-1234');
    expect(f.browser.click).toHaveBeenCalledWith('google');
    expect(f.browser.chooseExpectedAccount).toHaveBeenCalledWith('operator@example.com');
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

  it('refuses an unmeasured generic consent page before the authorize click', async () => {
    const f = fixture([state('authorize', { origin: 'https://claude.ai', hasAuthorize: true,
      requestedScopes: [] })]);
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'operator-only', failureClass: 'permission-expansion' });
    expect(f.browser.click).not.toHaveBeenCalled();
  });

  it('does not let a Codex device artifact turn an unmeasured consent page into a safe device approval', async () => {
    const f = fixture([state('authorize', { origin: 'https://auth.openai.com', hasAuthorize: true,
      requestedScopes: [] })]);
    const request = { ...f.request, provider: 'openai' as const,
      verificationUrl: 'https://auth.openai.com/codex/device',
      artifact: { ...artifact, kind: 'device-code' as const, userCode: 'ABCD-1234' } };
    expect(await f.driver.drive(request)).toEqual({ outcome: 'operator-only', failureClass: 'permission-expansion' });
    expect(f.browser.click).not.toHaveBeenCalled();
  });

  it.each([0, 2])('refuses a chooser unless exactly one expected identity leaf exists (count=%i)', async (count) => {
    const f = fixture([state('account-chooser', {
      expectedAccountVisible: count === 1, expectedAccountMatchCount: count,
    })]);
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'refused', failureClass: 'wrong-identity' });
    expect(f.browser.chooseExpectedAccount).not.toHaveBeenCalled();
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
    expect(allowedActions(state('password'), { artifact, loginMethod: 'session-cookie', secretRefs: {} })).toEqual([]);
  });
});

describe('AnthropicReloginBrowserDriver — bot-check interstitial', () => {
  const claude = { origin: 'https://claude.ai' };
  it('waits out a "Just a moment" interstitial on its own budget, without supervision, then continues the drive', async () => {
    // 2026-09-23 justin-gmail: three attempts died on the interstitial in 15 s each (20 × 750 ms).
    const holds = Array.from({ length: 12 }, () => state('interstitial', claude)); // 12 × 3 s = 36 s > the old 15 s
    const f = fixture([...holds, state('authorize', { ...claude, hasAuthorize: true, requestedScopes: ['user:profile'] }), state('paste-code', claude)]);
    const result = await f.driver.drive({ ...f.request, loginMethod: 'session-cookie', secretRefs: {} });
    expect(result).toEqual({ outcome: 'approved', pasteCode: 'returned-code' });
    expect(f.browser.wait).toHaveBeenCalledTimes(12);
    expect(f.browser.wait).toHaveBeenCalledWith(INTERSTITIAL_POLL_MS);
    // Interstitial polls never reach the supervisor and never consume a drive step (maxSteps is 10 here).
    expect(f.supervise).toHaveBeenCalledTimes(1);
    expect(f.supervise.mock.calls[0][0].snapshot.pageClass).toBe('authorize');
  });
  it('gives up as transient once the interstitial budget is spent, never as a CAPTCHA', async () => {
    const f = fixture([state('interstitial', claude)]);
    const driver = new AnthropicReloginBrowserDriver({ browser: f.browser, resolveSecret: f.resolveSecret,
      supervise: f.supervise, seatLease: f.seatLease, now: () => NOW, maxSteps: 10, interstitialMaxMs: 9_000 });
    expect(await driver.drive(f.request)).toEqual({ outcome: 'transient', failureClass: 'provider-transient' });
    expect(f.browser.wait).toHaveBeenCalledTimes(3); // 3 × 3 s = the 9 s budget
    expect(f.supervise).not.toHaveBeenCalled();
    expect(f.browser.close).toHaveBeenCalled();
  });
  it('offers only a wait on an interstitial', () => {
    expect(allowedActions(state('interstitial', claude), { artifact, loginMethod: 'password', secretRefs: { password: 'p' } }))
      .toEqual(['wait']);
  });

  it('names the failure reason, and hands a macOS automation-permission refusal to the operator instead of retrying', async () => {
    const launch = fixture([state('password')]);
    (launch.browser.open as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('chrome-launch-timeout'));
    expect(await launch.driver.drive(launch.request))
      .toEqual({ outcome: 'transient', failureClass: 'provider-transient', reason: 'chrome-launch-timeout' });

    const denied = fixture([state('password')]);
    (denied.browser.open as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('plain-browser-automation-not-permitted'));
    expect(await denied.driver.drive(denied.request))
      .toEqual({ outcome: 'operator-only', failureClass: 'automation-permission', reason: 'plain-browser-automation-not-permitted' });
    expect(denied.browser.close).toHaveBeenCalled();
  });

  it('a password account uses ONE backup code on Google\'s backup-code page, taken out of the vault first', async () => {
    const f = fixture([
      state('google-backup-code-entry' as never),
      state('authorize', { origin: 'https://claude.ai', hasAuthorize: true, requestedScopes: ['user:profile'] }),
      state('paste-code', { origin: 'https://claude.ai' }),
    ]);
    const takeBackupCode = vi.fn(async () => '12345678');
    const driver = new AnthropicReloginBrowserDriver({ browser: f.browser, resolveSecret: f.resolveSecret, takeBackupCode,
      supervise: f.supervise, seatLease: f.seatLease, now: () => NOW, maxSteps: 10 });
    const result = await driver.drive({ ...f.request, loginMethod: 'password', secretRefs: { password: 'password-ref', backupCode: 'codes-ref' } });
    expect(result).toEqual({ outcome: 'approved', pasteCode: 'returned-code' });
    expect(takeBackupCode).toHaveBeenCalledTimes(1);
    expect(takeBackupCode).toHaveBeenCalledWith('codes-ref');
    expect(f.browser.fillSecret).toHaveBeenCalledWith('backup-code', '12345678');
    // The supervisor only ever saw the action token, never the code.
    expect(JSON.stringify(f.supervise.mock.calls)).not.toContain('12345678');
  });

  it('without a backup-code taker, or without a codes entry, a repair never offers the backup-code fill', async () => {
    const f = fixture([state('google-backup-code-entry' as never)]);
    const result = await f.driver.drive({ ...f.request, loginMethod: 'password', secretRefs: { password: 'password-ref', backupCode: 'codes-ref' } });
    expect(f.browser.fillSecret).not.toHaveBeenCalledWith('backup-code', expect.anything());
    expect(result.outcome).not.toBe('approved');
  });

  it('takes at most ONE backup code per drive: a rejected code ends the attempt instead of draining the list', async () => {
    const f = fixture([state('google-backup-code-entry' as never), state('google-backup-code-entry' as never), state('google-backup-code-entry' as never)]);
    const takeBackupCode = vi.fn(async () => '12345678');
    const driver = new AnthropicReloginBrowserDriver({ browser: f.browser, resolveSecret: f.resolveSecret, takeBackupCode,
      supervise: f.supervise, seatLease: f.seatLease, now: () => NOW, maxSteps: 10 });
    const result = await driver.drive({ ...f.request, loginMethod: 'password', secretRefs: { password: 'password-ref', backupCode: 'codes-ref' } });
    expect(takeBackupCode).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'transient' });
  });

  it('waits through a window that is still blank (origin "null") instead of refusing, but refuses one that stays blank', async () => {
    const loading = fixture([
      state('unknown', { origin: 'null' }), state('unknown', { origin: 'null' }),
      state('authorize', { origin: 'https://claude.ai', hasAuthorize: true, requestedScopes: ['user:profile'] }),
      state('paste-code', { origin: 'https://claude.ai' }),
    ]);
    expect(await loading.driver.drive(loading.request)).toEqual({ outcome: 'approved', pasteCode: 'returned-code' });
    expect(loading.browser.wait).toHaveBeenCalledWith(1_000);

    const stuck = fixture([state('unknown', { origin: 'null' })]);
    expect(await stuck.driver.drive(stuck.request)).toEqual({ outcome: 'refused', failureClass: 'unexpected-origin' });
  });

  it('a Chrome that never answers control requests at launch is handed to the operator as a permission need', async () => {
    const f = fixture([state('password')]);
    (f.browser.open as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('chrome-launch-timeout-apple-event-no-reply'));
    expect(await f.driver.drive(f.request))
      .toEqual({ outcome: 'operator-only', failureClass: 'automation-permission', reason: 'chrome-launch-timeout-apple-event-no-reply' });
  });
});

describe('AnthropicReloginBrowserDriver device-limit page judgement (codex-device-limit-tripwire §2 C)', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  function dlFixture(states: ReloginBrowserSnapshot[], opts: {
    judge?: (text: string) => Promise<boolean>; mainText?: (() => Promise<string>) | null;
    beforeSnapshot?: (index: number) => void | Promise<void>; maxSteps?: number;
  } = {}) {
    let index = 0;
    const browser: ReloginBrowserPort = {
      open: vi.fn(async () => {}),
      snapshot: vi.fn(async () => {
        const i = index++;
        await opts.beforeSnapshot?.(i);
        await flush(); // let any pending verdict land before the step boundary
        return states[Math.min(i, states.length - 1)]!;
      }),
      chooseExpectedAccount: vi.fn(async () => {}), fillPublic: vi.fn(async () => {}), fillSecret: vi.fn(async () => {}),
      click: vi.fn(async () => {}), readPasteCode: vi.fn(async () => 'returned-code'),
      wait: vi.fn(async () => {}), close: vi.fn(async () => {}),
      ...(opts.mainText === null ? {} : { mainText: vi.fn(opts.mainText ?? (async () => 'You have reached the device limit for paid accounts.')) }),
    };
    const judge = vi.fn(opts.judge ?? (async () => true));
    const supervise = vi.fn(async ({ allowedActions }: { allowedActions: string[] }) => allowedActions[0] as never);
    const seatLease = { acquire: vi.fn(() => ({ acquired: true })), release: vi.fn() };
    const driver = new AnthropicReloginBrowserDriver({ browser, resolveSecret: async () => null, supervise, seatLease,
      now: () => NOW, maxSteps: opts.maxSteps ?? 6, judgeDeviceLimitPage: judge });
    const request = { artifact: { ...artifact, kind: 'device-code' as const, userCode: 'ABCD-1234' },
      verificationUrl: 'https://auth.openai.com/codex/device', provider: 'openai' as const,
      expectedIdentity: 'operator@example.com', loginMethod: 'session-cookie' as const, secretRefs: {}, allowedScopes: [] };
    return { browser, judge, driver, request, seatLease };
  }
  const openai = (pageClass: ReloginBrowserSnapshot['pageClass'], origin = 'https://auth.openai.com') => state(pageClass, { origin });

  it('a true verdict on an unknown auth.openai.com page ends the drive refused/device-limit on the same page', async () => {
    const f = dlFixture([openai('unknown'), openai('unknown'), openai('unknown'), openai('success')]);
    const result = await f.driver.drive(f.request);
    expect(result).toEqual({ outcome: 'refused', failureClass: 'device-limit', reason: 'browser-page-judged-device-limit' });
    expect(f.judge).toHaveBeenCalledOnce();
    expect(f.judge).toHaveBeenCalledWith('You have reached the device limit for paid accounts.');
    expect(f.browser.close).toHaveBeenCalled();
    expect(f.seatLease.release).toHaveBeenCalled();
  });

  it('also judges an unknown page on https://chatgpt.com', async () => {
    const f = dlFixture([openai('unknown', 'https://chatgpt.com'), openai('unknown', 'https://chatgpt.com'), openai('success')]);
    expect(await f.driver.drive(f.request)).toMatchObject({ outcome: 'refused', failureClass: 'device-limit' });
  });

  it('a verdict that arrives after the page changed is stale and never stops the drive', async () => {
    let resolveJudge!: (v: boolean) => void;
    const f = dlFixture([openai('unknown'), openai('success')], {
      judge: () => new Promise<boolean>((resolve) => { resolveJudge = resolve; }),
      // The verdict lands while the next snapshot (a different page class) is being taken.
      beforeSnapshot: (i) => { if (i === 1) resolveJudge(true); },
    });
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'approved' });
    expect(f.judge).toHaveBeenCalledOnce();
  });

  it('a verdict for a page left by origin (same class) is stale', async () => {
    let resolveJudge!: (v: boolean) => void;
    const f = dlFixture([openai('unknown'), openai('unknown', 'https://chatgpt.com'), openai('success')], {
      judge: vi.fn()
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveJudge = resolve; }))
        .mockImplementation(async () => false),
      beforeSnapshot: (i) => { if (i === 1) resolveJudge(true); },
    });
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'approved' });
    expect(f.judge).toHaveBeenCalledTimes(2); // once per page generation
  });

  it('returning to a page after leaving it is a new generation: judged again, and an old verdict does not apply', async () => {
    const answers = [false, false];
    const f = dlFixture([openai('unknown'), openai('device-code'), openai('unknown'), openai('unknown'), openai('success')], {
      judge: vi.fn(async () => answers.shift() ?? false),
    });
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'approved' });
    expect(f.judge).toHaveBeenCalledTimes(2);
  });

  it('is called at most once per page generation even across many steps on that page', async () => {
    const f = dlFixture(Array.from({ length: 6 }, () => openai('unknown')), { judge: async () => false, maxSteps: 6 });
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'transient', failureClass: 'provider-transient' });
    expect(f.judge).toHaveBeenCalledOnce();
  });

  it('is never asked for a non-openai provider, a non-allowed origin, or a non-unknown page', async () => {
    // Anthropic drive with an unknown page.
    const anth = dlFixture([state('unknown', { origin: 'https://claude.ai' }), state('success', { origin: 'https://claude.ai' })]);
    expect(await anth.driver.drive({ ...anth.request, provider: 'anthropic', verificationUrl: 'https://claude.ai/oauth/authorize?x=1',
      artifact })).toEqual({ outcome: 'approved' });
    expect(anth.judge).not.toHaveBeenCalled();
    // OpenAI drive, unknown page on an allowed but not-judged origin (platform.openai.com / Google).
    for (const origin of ['https://platform.openai.com', 'https://accounts.google.com']) {
      const other = dlFixture([openai('unknown', origin), openai('success')]);
      expect(await other.driver.drive(other.request)).toEqual({ outcome: 'approved' });
      expect(other.judge).not.toHaveBeenCalled();
    }
    // OpenAI drive on auth.openai.com, but a classified page.
    const classified = dlFixture([openai('device-code'), openai('success')]);
    expect(await classified.driver.drive(classified.request)).toEqual({ outcome: 'approved' });
    expect(classified.judge).not.toHaveBeenCalled();
  });

  it('is never asked when the browser cannot read main text, or the text is empty', async () => {
    const noText = dlFixture([openai('unknown'), openai('success')], { mainText: null });
    expect(await noText.driver.drive(noText.request)).toEqual({ outcome: 'approved' });
    expect(noText.judge).not.toHaveBeenCalled();
    const empty = dlFixture([openai('unknown'), openai('success')], { mainText: async () => '' });
    expect(await empty.driver.drive(empty.request)).toEqual({ outcome: 'approved' });
    expect(empty.judge).not.toHaveBeenCalled();
  });

  it('a judge that rejects, or a mainText that throws, never breaks the drive', async () => {
    const rejecting = dlFixture([openai('unknown'), openai('unknown'), openai('success')], { judge: async () => { throw new Error('jev down'); } });
    expect(await rejecting.driver.drive(rejecting.request)).toEqual({ outcome: 'approved' });
    expect(rejecting.judge).toHaveBeenCalledOnce();
    const throwing = dlFixture([openai('unknown'), openai('unknown'), openai('success')], { mainText: async () => { throw new Error('cdp gone'); } });
    expect(await throwing.driver.drive(throwing.request)).toEqual({ outcome: 'approved' });
  });

  it('a false verdict leaves the drive exactly as today', async () => {
    const f = dlFixture([openai('unknown'), openai('unknown'), openai('success')], { judge: async () => false });
    expect(await f.driver.drive(f.request)).toEqual({ outcome: 'approved' });
  });
});
