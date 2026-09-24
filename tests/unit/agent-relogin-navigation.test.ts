import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicReloginBrowserDriver,
  buildAgentOffer,
  isBlockedControl,
  redactLabel,
  type AgentNavigationInput,
  type ReloginBrowserPort,
  type ReloginBrowserSnapshot,
  type ReloginControlObservation,
} from '../../src/core/AnthropicReloginBrowserDriver.js';

// Spec: docs/specs/agent-driven-relogin.md — the agent chooses each step from an open,
// floor-filtered list; the floors are deterministic and tested here on both sides.

const EXPECTED = 'operator@example.com';
const artifact = { attemptId: 'attempt-9', kind: 'url-code-paste' as const,
  expiresAt: '2999-01-01T00:00:00.000Z', reissueCount: 0 };
const baseRequest = {
  artifact,
  verificationUrl: 'https://claude.ai/oauth/authorize?opaque=1',
  provider: 'anthropic' as const,
  expectedIdentity: EXPECTED,
  loginMethod: 'password' as const,
  secretRefs: { password: 'password-ref' },
  allowedScopes: ['user:profile', 'user:inference'],
};

function snap(pageClass: ReloginBrowserSnapshot['pageClass'], extra: Partial<ReloginBrowserSnapshot> = {}): ReloginBrowserSnapshot {
  return { origin: 'https://claude.ai', pageClass, expectedAccountVisible: false, expectedAccountMatchCount: 0,
    hasGoogleSignIn: false, hasNext: false, hasAuthorize: false, requestedScopes: [], ...extra };
}

function obs(controls: { n: number; text: string; identities?: string[] }[], inputKinds: string[] = []): ReloginControlObservation {
  return { title: 'Sign in', path: '/login', inputKinds,
    controls: controls.map((c) => ({ n: c.n, text: c.text, identities: c.identities ?? [] })) };
}

describe('agent navigation floors (buildAgentOffer)', () => {
  it('offers ordinary controls on a page no classifier knows', () => {
    const offer = buildAgentOffer(snap('unknown'), obs([{ n: 1, text: 'Continue with Google' }, { n: 2, text: 'Next' }]), baseRequest, []);
    expect(offer.offered).toEqual(['click:1', 'click:2', 'wait', 'give-up']);
  });

  it('never offers a control naming another account, but does offer the expected one', () => {
    const offer = buildAgentOffer(snap('unknown'), obs([
      { n: 1, text: 'Someone Else other@example.com', identities: ['other@example.com'] },
      { n: 2, text: `Operator ${EXPECTED}`, identities: [EXPECTED] },
    ]), baseRequest, []);
    expect(offer.offered).not.toContain('click:1');
    expect(offer.offered).toContain('click:2');
  });

  it('never offers destructive or credential-creating controls, in any wording', () => {
    for (const text of ['Sign out of all sessions', 'Log out everywhere', 'Manage your Google Account',
      'Create a passkey', 'Use another account', 'Forgot password?', 'Set up 2-Step Verification', 'Delete account',
      'Create account', 'Sign up for free', 'Decline', 'Switch account', 'Deny', 'Not you?']) {
      expect(isBlockedControl(text), text).toBe(true);
    }
    for (const text of ['Continue', 'Next', 'Continue with Google', 'Sign in', 'Allow', 'Authorize']) {
      expect(isBlockedControl(text), text).toBe(false);
    }
  });

  it('offers consent only when scopes were read, are non-empty, and are within the allowed set', () => {
    const controls = obs([{ n: 1, text: 'Allow' }, { n: 2, text: 'Cancel' }]);
    expect(buildAgentOffer(snap('unknown'), controls, baseRequest, []).offered).not.toContain('click:1');
    expect(buildAgentOffer(snap('unknown', { requestedScopes: ['user:profile'] }), controls, baseRequest, []).offered)
      .toContain('click:1');
    expect(buildAgentOffer(snap('unknown', { requestedScopes: ['user:profile', 'org:admin'] }), controls, baseRequest, []).offered)
      .not.toContain('click:1');
    // On an authorize-class page EVERY control is consent-capable.
    expect(buildAgentOffer(snap('authorize'), obs([{ n: 1, text: 'Continue' }]), baseRequest, []).offered)
      .not.toContain('click:1');
  });

  it("on Claude's real authorize page (live 2026-09-24) offers Authorize only — never Decline or Switch account", () => {
    const page = obs([{ n: 1, text: 'Authorize' }, { n: 2, text: 'Decline' }, { n: 3, text: 'Switch account' }]);
    const offer = buildAgentOffer(snap('authorize', { requestedScopes: ['user:profile'] }), page, baseRequest, []);
    expect(offer.offered).toEqual(['click:1', 'wait', 'give-up']);
  });

  it('offers typed fills by input presence and login method, never as free text', () => {
    const offer = buildAgentOffer(snap('unknown'), obs([], ['email', 'password', 'code']), baseRequest, []);
    expect(offer.offered).toEqual(expect.arrayContaining(['fill-email', 'fill-password']));
    expect(offer.offered).not.toContain('fill-totp');
    expect(offer.offered).not.toContain('fill-device-code');
    const noPasswordRef = buildAgentOffer(snap('unknown'), obs([], ['password']), { ...baseRequest, secretRefs: {} }, []);
    expect(noPasswordRef.offered).not.toContain('fill-password');
  });

  it('redacts secrets verbatim, foreign emails, long tokens and digit runs, and discloses truncation', () => {
    expect(redactLabel('Welcome back hunter-2!', EXPECTED, ['hunter-2'])).toBe('Welcome back ‹secret›!');
    expect(redactLabel('Switch to other@example.com', EXPECTED, [])).toBe('Switch to ‹other-email›');
    expect(redactLabel(`Continue as ${EXPECTED}`, EXPECTED, [])).toBe(`Continue as ${EXPECTED}`);
    expect(redactLabel('Signed in as j•••@gmail.com', EXPECTED, [])).toBe('Signed in as ‹masked-email›');
    expect(redactLabel('code abcdefghijklmnopqrstuvwxyz0123 and 1234567', EXPECTED, [])).toBe('code ‹masked› and ‹masked›');
    const long = redactLabel('x '.repeat(80), EXPECTED, []);
    expect(long.endsWith('…(truncated)')).toBe(true);
  });
});

describe('AnthropicReloginBrowserDriver in agent navigation mode', () => {
  function fixture(pages: { snapshot: ReloginBrowserSnapshot; observation: ReloginControlObservation }[],
    choose: (input: AgentNavigationInput) => string, extra: { deadlineMs?: number } = {}) {
    let index = 0;
    let current = pages[0];
    const browser: ReloginBrowserPort = {
      open: vi.fn(async () => {}),
      snapshot: vi.fn(async () => { current = pages[Math.min(index++, pages.length - 1)]; return current.snapshot; }),
      chooseExpectedAccount: vi.fn(async () => {}),
      fillPublic: vi.fn(async () => {}),
      fillSecret: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      readPasteCode: vi.fn(async () => 'returned-code'),
      wait: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      observeControls: vi.fn(async () => current.observation),
      clickControl: vi.fn(async () => {}),
    };
    const navigate = vi.fn(async (input: AgentNavigationInput) => choose(input));
    const supervise = vi.fn(async () => { throw new Error('closed supervisor must not run in agent mode'); });
    const seatLease = { acquire: vi.fn(() => ({ acquired: true })), release: vi.fn() };
    const driver = new AnthropicReloginBrowserDriver({ browser, supervise, seatLease, navigate,
      resolveSecret: async () => 'hunter-2', navigation: 'agent', maxSteps: 10, driveDeadlineMs: extra.deadlineMs });
    return { browser, navigate, supervise, seatLease, driver };
  }

  it('gets through a page nobody predicted by clicking the control the agent chose, then finishes on the paste code', async () => {
    const f = fixture([
      { snapshot: snap('unknown'), observation: obs([{ n: 1, text: 'Review our new terms' }, { n: 2, text: 'I agree and continue' }]) },
      { snapshot: snap('unknown'), observation: obs([], ['password']) },
      { snapshot: snap('paste-code'), observation: obs([]) },
    ], (input) => input.offered.includes('click:2') ? 'click:2' : 'fill-password');
    const result = await f.driver.drive(baseRequest);
    expect(result).toEqual({ outcome: 'approved', pasteCode: 'returned-code' });
    expect(f.browser.clickControl).toHaveBeenCalledWith(2, 'I agree and continue', []);
    expect(f.browser.fillSecret).toHaveBeenCalledWith('password', 'hunter-2');
    expect(f.supervise).not.toHaveBeenCalled();
    expect(JSON.stringify(f.navigate.mock.calls)).not.toContain('hunter-2');
    expect(f.seatLease.release).toHaveBeenCalledOnce();
  });

  it('ends the drive when the agent answers with anything not offered', async () => {
    const f = fixture([{ snapshot: snap('unknown'), observation: obs([{ n: 1, text: 'Sign out' }]) }], () => 'click:1');
    expect(await f.driver.drive(baseRequest)).toEqual({ outcome: 'transient', failureClass: 'provider-transient' });
    expect(f.browser.clickControl).not.toHaveBeenCalled();
  });

  it('keeps deterministic handling of safety pages — the agent is never asked about a CAPTCHA', async () => {
    const f = fixture([{ snapshot: snap('captcha'), observation: obs([{ n: 1, text: 'Continue' }]) }], () => 'click:1');
    expect(await f.driver.drive(baseRequest)).toEqual({ outcome: 'operator-only', failureClass: 'captcha' });
    expect(f.navigate).not.toHaveBeenCalled();
  });

  it('enforces the hard deadline even when a call stalls forever', async () => {
    const f = fixture([{ snapshot: snap('unknown'), observation: obs([{ n: 1, text: 'Next' }]) }], () => 'click:1', { deadlineMs: 60_000 });
    vi.useFakeTimers();
    try {
      (f.navigate as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
      const pending = f.driver.drive(baseRequest);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await pending).toEqual({ outcome: 'transient', failureClass: 'provider-transient', reason: 'relogin-drive-deadline' });
      expect(f.browser.close).toHaveBeenCalled();
      expect(f.seatLease.release).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('stays on the closed table for passkey enrollment drives', async () => {
    const f = fixture([{ snapshot: snap('unknown'), observation: obs([{ n: 1, text: 'Next' }]) }], () => 'click:1');
    await f.driver.drive({ ...baseRequest, intent: 'enroll' });
    expect(f.navigate).not.toHaveBeenCalled();
  });
});

describe('resolveReloginNavigation', () => {
  it('follows the development-agent gate when omitted and lets an explicit value win both ways', async () => {
    const { resolveReloginNavigation } = await import('../../src/core/SubscriptionReloginRuntime.js');
    expect(resolveReloginNavigation(undefined, { developmentAgent: true })).toBe('agent');
    expect(resolveReloginNavigation(undefined, {})).toBe('closed');
    expect(resolveReloginNavigation('closed', { developmentAgent: true })).toBe('closed');
    expect(resolveReloginNavigation('agent', {})).toBe('agent');
  });
});

describe('Cloudflare hold that never clears under automation (live 2026-09-24)', () => {
  function driverWith(snapshots: ReloginBrowserSnapshot[], warmUp: boolean) {
    let index = 0;
    const browser: ReloginBrowserPort = {
      open: vi.fn(async () => {}),
      snapshot: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]),
      chooseExpectedAccount: vi.fn(async () => {}), fillPublic: vi.fn(async () => {}), fillSecret: vi.fn(async () => {}),
      click: vi.fn(async () => {}), readPasteCode: vi.fn(async () => 'returned-code'),
      wait: vi.fn(async () => {}), close: vi.fn(async () => {}),
      ...(warmUp ? { warmUpPlain: vi.fn(async () => {}) } : {}),
    };
    const driver = new AnthropicReloginBrowserDriver({ browser, seatLease: { acquire: () => ({ acquired: true }), release: vi.fn() },
      resolveSecret: async () => null, supervise: async ({ allowedActions }) => allowedActions[0]!, interstitialMaxMs: 3_000 });
    return { browser, driver };
  }

  it('runs one plain warm-up, reopens the sign-in link, and continues once the hold is gone', async () => {
    const f = driverWith([snap('interstitial'), snap('interstitial'), snap('paste-code')], true);
    expect(await f.driver.drive(baseRequest)).toEqual({ outcome: 'approved', pasteCode: 'returned-code' });
    expect(f.browser.warmUpPlain).toHaveBeenCalledOnce();
    expect(f.browser.warmUpPlain).toHaveBeenCalledWith(baseRequest.verificationUrl, 45_000);
    expect(f.browser.open).toHaveBeenCalledTimes(2);
  });

  it('warms up at most once per drive, then ends the drive as transient', async () => {
    const f = driverWith([snap('interstitial')], true);
    expect(await f.driver.drive(baseRequest)).toEqual({ outcome: 'transient', failureClass: 'provider-transient' });
    expect(f.browser.warmUpPlain).toHaveBeenCalledOnce();
  });

  it('without a warm-up capability keeps the old bounded behaviour', async () => {
    const f = driverWith([snap('interstitial')], false);
    expect(await f.driver.drive(baseRequest)).toEqual({ outcome: 'transient', failureClass: 'provider-transient' });
    expect(f.browser.open).toHaveBeenCalledOnce();
  });
});

describe('consent click that never goes through (live 2026-09-24: invisible hCaptcha behind Authorize)', () => {
  it('hands the sign-in to the operator instead of retrying once the page stays on authorize past the window', async () => {
    let t = 1_000;
    const pages = [snap('authorize', { requestedScopes: ['user:profile'] })];
    const browser: ReloginBrowserPort = {
      open: vi.fn(async () => {}), snapshot: vi.fn(async () => pages[0]),
      chooseExpectedAccount: vi.fn(async () => {}), fillPublic: vi.fn(async () => {}), fillSecret: vi.fn(async () => {}),
      click: vi.fn(async () => {}), readPasteCode: vi.fn(async () => null),
      wait: vi.fn(async (ms: number) => { t += ms; }), close: vi.fn(async () => {}),
      observeControls: vi.fn(async () => obs([{ n: 1, text: 'Authorize' }])),
      clickControl: vi.fn(async () => {}),
    };
    const navigate = vi.fn(async (input: AgentNavigationInput) => input.offered.includes('click:1') && !(browser.clickControl as ReturnType<typeof vi.fn>).mock.calls.length ? 'click:1' : 'wait');
    const driver = new AnthropicReloginBrowserDriver({ browser, navigate, navigation: 'agent', now: () => t,
      seatLease: { acquire: () => ({ acquired: true }), release: vi.fn() }, resolveSecret: async () => null,
      supervise: async () => { throw new Error('unused'); }, maxSteps: 40 });
    expect(await driver.drive(baseRequest)).toEqual({ outcome: 'operator-only', failureClass: 'captcha' });
    expect(browser.clickControl).toHaveBeenCalledOnce();
  });

  it('offers the backup-code fill ONLY on Google\'s own backup-code field, never on a generic code box', () => {
    const req = { ...baseRequest, loginMethod: 'password' as const, secretRefs: { password: 'pw', backupCode: 'codes' } };
    expect(buildAgentOffer(snap('unknown'), obs([], ['backup-code']), req, []).offered).toContain('fill-backup-code');
    expect(buildAgentOffer(snap('unknown'), obs([], ['code']), req, []).offered).not.toContain('fill-backup-code');
    const noCodes = { ...req, secretRefs: { password: 'pw' } };
    expect(buildAgentOffer(snap('unknown'), obs([], ['backup-code']), noCodes, []).offered).not.toContain('fill-backup-code');
  });
});
