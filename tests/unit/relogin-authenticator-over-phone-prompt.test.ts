/**
 * Authenticator over a phone prompt (docs/specs/relogin-authenticator-over-phone-prompt.md).
 * Google's 2-Step Verification step often offers a phone prompt first. With an authenticator
 * saved, the sign-in helper chooses "Try another way" and the authenticator code instead of
 * stopping; without one, the old phone-tap wording is byte-for-byte unchanged. The risk-check
 * hard line (CAPTCHA, SMS, "verify it's you") is never loosened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SubscriptionReloginHelper, classifyAuthenticatorHeading, parseHelperBody, renderHelperPrompt, type ReloginHelperSeat } from '../../src/core/SubscriptionReloginHelper.js';
import { SubscriptionReloginStore } from '../../src/core/SubscriptionReloginStore.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { validClaudePasteBackCode } from '../../src/core/ClaudePasteBackController.js';
import { helperHasAuthenticator, helperAuthenticatorMode, resolveAuthenticatorOverPhone } from '../../src/core/SubscriptionReloginRuntime.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT as CONTENT } from '../../src/data/builtinSkillContent.js';

const VALID = 'a'.repeat(40) + '#' + 'b'.repeat(40);
const G = 'https://accounts.google.com';
const SEAT = { accountId: 'helper', configHome: '/tmp/helper', framework: 'claude-code' } as unknown as ReloginHelperSeat;
function input(extra: Record<string, unknown> = {}) {
  return {
    episode: { id: 'ep-9' } as never,
    artifact: { kind: 'paste-code' } as never,
    verificationUrl: 'https://claude.ai/oauth/authorize?x=1',
    expectedEmail: 'person@example.com',
    provider: 'anthropic' as const,
    profileDir: '/tmp/p1',
    vaultBindingNames: ['google_password_person', 'google_totp_person'],
    token: 'TOKEN', port: 4042, seat: SEAT,
    ...extra,
  };
}

describe('helperHasAuthenticator', () => {
  it('is true only for password+totp with a bound authenticator entry', () => {
    expect(helperHasAuthenticator('password+totp', { totp: 'google_totp_person' })).toBe(true);
    expect(helperHasAuthenticator('password+totp', {})).toBe(false);
    expect(helperHasAuthenticator('password+totp', { totp: '' })).toBe(false);
    expect(helperHasAuthenticator('password', { totp: 'google_totp_person' })).toBe(false);
    expect(helperHasAuthenticator('google-passkey', { totp: 'x' })).toBe(false);
    expect(helperHasAuthenticator(undefined, { totp: 'x' })).toBe(false);
  });
});

describe('the authenticatorOverPhone setting', () => {
  it('omitted ⇒ shadow on a development agent, off on the fleet; an explicit value wins', () => {
    expect(resolveAuthenticatorOverPhone(undefined, { developmentAgent: true })).toBe('shadow');
    expect(resolveAuthenticatorOverPhone(undefined, { developmentAgent: false })).toBe('off');
    expect(resolveAuthenticatorOverPhone(undefined, undefined)).toBe('off');
    expect(resolveAuthenticatorOverPhone(true, { developmentAgent: false })).toBe('on');
    expect(resolveAuthenticatorOverPhone('shadow', { developmentAgent: false })).toBe('shadow');
    expect(resolveAuthenticatorOverPhone(false, { developmentAgent: true })).toBe('off');
  });
  it('applies only to a qualifying account', () => {
    const refs = { totp: 'google_totp_person' };
    expect(helperAuthenticatorMode('on', 'password+totp', refs)).toBe('on');
    expect(helperAuthenticatorMode('shadow', 'password+totp', refs)).toBe('shadow');
    expect(helperAuthenticatorMode('on', 'password', refs)).toBe('off');
    expect(helperAuthenticatorMode('shadow', 'password+totp', {})).toBe('off');
    expect(helperAuthenticatorMode(undefined, 'password+totp', refs)).toBe('off');
    expect(helperAuthenticatorMode('off', 'password+totp', refs)).toBe('off');
  });
});

describe('renderHelperPrompt — shadow mode', () => {
  it('reads and reports the heading, never clicks or enters a code, and keeps the old tap ask and hard line', () => {
    const text = renderHelperPrompt(input({ authenticatorMode: 'shadow' }));
    expect(text).toContain('Observation only, for this account');
    expect(text).toContain('{"notify":"authenticator","result":"shadow-would-use","heading":"<the heading text>","origin":"<the page origin>"}');
    expect(text).toContain('(or "shadow-would-stop")');
    expect(text).toContain('Do not click "Try another way" and do not enter any code.');
    expect(text).toContain('If a phone tap or "Is it you?" prompt appears, ask the operator once:');
    expect(text).toContain('2. Never solve or work around a CAPTCHA or a phone / "verify it\'s you" check; only ask for the phone tap above.');
    expect(text).not.toContain('This account has an authenticator code saved.');
  });
});

describe('renderHelperPrompt — 2-Step Verification phone prompt', () => {
  it('with an authenticator saved, tells the helper to choose Try another way and the authenticator code', () => {
    for (const browserDriver of [undefined, 'windows' as const]) {
      const text = renderHelperPrompt(input({ authenticatorMode: 'on', ...(browserDriver ? { browserDriver, profileDir: 'C:\\p1' } : {}) }));
      expect(text).toContain('This account has an authenticator code saved.');
      expect(text).toContain('a Google page whose heading reads');
      expect(text).toContain('"2-Step Verification", shown after the password');
      expect(text).toContain('Google Authenticator app');
      expect(text).toContain('{"notify":"authenticator","result":"intent","heading":"<the heading text>","origin":"<the page origin>"}');
      expect(text).toContain('{"notify":"authenticator","result":"code","heading":"<the heading text>","origin":"<the page origin>"}');
      expect(text).toContain('Go on only if the answer contains "proceed":true.');
      expect(text).toContain('Instar allows at most two codes');
      expect(text).toContain('Risk always wins');
      expect(text).toContain('"Google wants to make sure it\'s really you" is normal and is not a warning.');
      expect(text).toContain('If Google asks for the authenticator code directly, enter it as you always have; nothing below applies.');
      expect(text).toContain('stay on the phone prompt and ask the');
      expect(text).toContain('has no authenticator option, report the "phone-confirmation" hard line and stop.');
      expect(text).toContain('If you cannot read the heading, or cannot tell');
      expect(text).toContain(browserDriver === 'windows' ? 'the element with the Heading role at the top of the page in `ndrive.sh tree`' : 'the text of its h1 element, read with the same in-page script');
    }
  });

  it('keeps the risk-check hard line: CAPTCHA, SMS and "verify it\'s you" are still never worked around', () => {
    const text = renderHelperPrompt(input({ authenticatorMode: 'on' }));
    expect(text).toContain('Never solve or work around a CAPTCHA or a phone / "verify it\'s you" check.');
    expect(text).toContain('Any other page is NOT this step, even if it lists the authenticator code');
    expect(text).toContain('or a CAPTCHA, is Google\'s risk check');
    expect(text).toContain('Judge that by what the page is asking, not by matching those words.');
    expect(text).toContain('at most two codes');
    expect(text).toContain('Hard lines (these five, and only these five):');
    expect(text).toContain('{"notify":"hard-line","line":"captcha"}');
  });

  it('without an authenticator, the prompt is exactly the previous wording', () => {
    for (const extra of [{}, { authenticatorMode: 'off' }]) {
      const text = renderHelperPrompt(input(extra));
      expect(text).not.toContain('authenticator code saved');
      expect(text).not.toContain('Google Authenticator app');
      expect(text).toContain('If a phone tap or "Is it you?" prompt appears, ask the operator once:');
      expect(text).toContain('2. Never solve or work around a CAPTCHA or a phone / "verify it\'s you" check; only ask for the phone tap above.');
    }
    expect(renderHelperPrompt(input({}))).toBe(renderHelperPrompt(input({ authenticatorMode: 'off' })));
  });
});

describe('subscription-signin skill text', () => {
  it('adds only the agent-run line; the by-hand rules and the risk-check row are unchanged', () => {
    expect(CONTENT).toContain("- **Google's phone prompt in a repair:** if your prompt allows the authenticator code");
    expect(CONTENT).toContain('Where your prompt and this skill differ, your prompt wins.');
    expect(CONTENT).toContain('| Google asks for a phone tap, SMS, or "verify it\'s you" | Google\'s own risk check | Hand to the operator once; never try another method to get around it |');
    expect(CONTENT).not.toContain('a Google page headed **2-Step Verification**');
  });
});

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = "- **Google's phone prompt in a repair:**";

describe('migrateSubscriptionSigninAuthenticatorOverPhone', () => {
  let dir: string;
  const skillFile = () => path.join(dir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
  function run(): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    (m as unknown as Record<string, (r: MigrationResult) => void>).migrateSubscriptionSigninAuthenticatorOverPhone(result);
    return result;
  }
  function install(content: string) {
    fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
    fs.writeFileSync(skillFile(), content);
  }
  const oldInstalled = () => CONTENT.split('\n').filter((l) => !l.startsWith(MARKER)).join('\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-auth-phone-mig-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/relogin-authenticator-over-phone-prompt.test.ts:cleanup' });
  });

  it('brings an old installed copy to exactly the shipped content, then is idempotent', () => {
    install(oldInstalled());
    const first = run();
    expect(first.errors).toEqual([]);
    expect(first.upgraded.join(' ')).toContain('agent-run phone-prompt line');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(CONTENT);
    expect(run()).toEqual({ upgraded: [], skipped: [], errors: [] });
  });

  it('keeps local edits and keeps a CRLF copy CRLF', () => {
    install(oldInstalled().replace(/\n/g, '\r\n') + '\r\n<!-- my local note -->\r\n');
    run();
    const after = fs.readFileSync(skillFile(), 'utf8');
    expect(after).toContain('<!-- my local note -->');
    expect(after).toContain(MARKER);
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(run()).toEqual({ upgraded: [], skipped: [], errors: [] });
  });

  it('leaves a customised copy without the stock anchor untouched and says so', () => {
    install('---\nname: subscription-signin\n---\n# my own procedure\n');
    const result = run();
    expect(result.upgraded).toEqual([]);
    expect(result.skipped.join(' ')).toContain('customized');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe('---\nname: subscription-signin\n---\n# my own procedure\n');
  });

  it('does nothing when the skill is not installed', () => {
    expect(run()).toEqual({ upgraded: [], skipped: [], errors: [] });
  });
});

describe('authenticator-over-phone audit notice', () => {
  const tmp: string[] = [];
  afterEach(() => { for (const d of tmp.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/relogin-authenticator-over-phone-prompt.test.ts:notice-cleanup' }); });

  it('parses only the exact one-key shape', () => {
    for (const result of ['intent', 'code', 'accepted', 'rejected', 'no-option', 'shadow-would-use', 'shadow-would-stop'] as const) {
      expect(parseHelperBody({ notify: 'authenticator', result, heading: '2-Step Verification', origin: G }))
        .toEqual({ kind: 'authenticator', result, heading: '2-Step Verification', origin: G });
    }
    expect(parseHelperBody({ notify: 'authenticator', result: 'accepted', heading: 'x' })).toBeNull();
    expect(parseHelperBody({ notify: 'authenticator', result: 'maybe', heading: 'x', origin: G })).toBeNull();
    expect(parseHelperBody({ notify: 'authenticator', result: 'accepted', heading: 1, origin: G })).toBeNull();
    expect(parseHelperBody({ notify: 'authenticator', result: 'accepted', heading: 'x'.repeat(201), origin: G })).toBeNull();
    expect(parseHelperBody({ notify: 'authenticator', result: 'accepted', heading: 'x', origin: 7 })).toBeNull();
    expect(parseHelperBody({ notify: 'authenticator', result: 'accepted', heading: 'x', origin: G, extra: 1 })).toBeNull();
    expect(parseHelperBody({ notify: 'authenticator-over-phone' })).toBeNull();
  });

  it('classifies the heading the helper read: exact 2-Step Verification only', () => {
    expect(classifyAuthenticatorHeading('2-Step Verification')).toBe('2sv');
    expect(classifyAuthenticatorHeading('  2-step   verification ')).toBe('2sv');
    expect(classifyAuthenticatorHeading('2\u2011Step Verification')).toBe('2sv');
    expect(classifyAuthenticatorHeading('2 Step Verification')).toBe('other');
    expect(classifyAuthenticatorHeading('2\u2010Step Verification')).toBe('2sv');
    expect(classifyAuthenticatorHeading("Verify it's you")).toBe('other');
    expect(classifyAuthenticatorHeading('2-Step Verification required: verify it is you')).toBe('other');
    expect(classifyAuthenticatorHeading('')).toBe('unknown');
    expect(classifyAuthenticatorHeading('   ')).toBe('unknown');
    expect(classifyAuthenticatorHeading('2-Step Veri\u00adfication')).toBe('2sv');
    expect(classifyAuthenticatorHeading('2\u200b-Step Verification')).toBe('2sv');
    expect(classifyAuthenticatorHeading('2\u2212Step Verification')).toBe('2sv');
  });

  it('the prompt asks for the notice only when an authenticator is saved', () => {
    expect(renderHelperPrompt(input({ authenticatorMode: 'on' }))).toContain('{"notify":"authenticator","result":"accepted","heading":"<the heading text>","origin":"<the page origin>"}');
    expect(renderHelperPrompt(input({}))).not.toContain('"notify":"authenticator"');
  });

  async function liveHelper(mode: 'on' | 'shadow' | 'off', latch: () => 'open' | 'awaiting-review' | 'review-failed' = () => 'open', seatFramework = 'claude-code', priorCodes = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-notice-')); tmp.push(dir);
    let alive = true; let prompt = '';
    const note = vi.fn();
    const queuePhoneTap = vi.fn();
    const helper = new SubscriptionReloginHelper({
      lease: new PlaywrightSeatLease({ filePath: path.join(dir, 'lease.json') }), hasCapacity: () => true,
      pickSeat: async () => ({ ...SEAT, framework: seatFramework }), spawn: async (i: { prompt: string }) => { prompt = i.prompt; return 'proj-relogin-ep-9'; },
      isAlive: () => alive, kill: () => { alive = false; }, listHelpers: () => [], credentialReady: async () => false,
      queuePhoneTap, noteAuthenticator: note, authenticatorLatch: latch, authenticatorCodesGranted: () => priorCodes, validateCode: validClaudePasteBackCode, serverPort: 4042,
      pollMs: 10, startGraceMs: 0, exitSettleMs: 0,
    } as never);
    const ep = { id: 'ep-9', sourceEpisodeId: 1, accountId: 'broken', machineId: 'm1', mode: 'unattended', state: 'browser-driving',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'p1', framework: 'claude-code', provider: 'anthropic', attemptCount: 1,
      reissueCount: 0, approvedAt: null, approvalExpiresAt: null, startedAt: null, finishedAt: null, nextAttemptAt: null,
      failureClass: null, version: 3, createdAt: '', updatedAt: '', loginMethod: 'password+totp' };
    const drive = helper.drive({ episode: ep as never, artifact: { attemptId: 'l', kind: 'url-code-paste', expiresAt: new Date(Date.now() + 1_800_000).toISOString(), reissueCount: 0 } as never,
      verificationUrl: 'https://claude.ai/oauth/authorize?x=1', expectedEmail: 'person@example.com', provider: 'anthropic',
      profileDir: '/p', vaultBindingNames: ['google_password_person', 'google_totp_person'], authenticatorMode: mode }, new AbortController().signal);
    await vi.waitFor(() => expect(prompt).toContain('X-Relogin-Helper-Token'));
    const token = /X-Relogin-Helper-Token: ([A-Za-z0-9_-]+)/.exec(prompt)![1]!;
    return { helper, note, queuePhoneTap, token, drive, prompt: () => prompt };
  }
  const H = '2-Step Verification';
  const ask = (h: Awaited<ReturnType<typeof liveHelper>>, result: string, heading = H, origin = G) =>
    h.helper.submit('ep-9', h.token, { notify: 'authenticator', result, heading, origin });

  it('the server is the authority: proceed only in on mode, only for the 2-Step Verification heading, at most two codes', async () => {
    const h = await liveHelper('on');
    expect(h.helper.submit('ep-9', 'wrong', { notify: 'authenticator', result: 'intent', heading: H, origin: G }).status).toBe(403);
    expect(ask(h, 'intent', H, 'https://accounts.google.com.evil.example').body).toMatchObject({ proceed: false, reason: 'origin-not-google' });
    expect(ask(h, 'intent', "Verify it's you").body).toMatchObject({ proceed: false, reason: 'heading-not-2sv' });
    expect(ask(h, 'intent').body).toMatchObject({ proceed: true });
    expect(ask(h, 'code', "Verify it's you").body).toMatchObject({ proceed: false, reason: 'heading-not-2sv' });
    expect(ask(h, 'code').body).toMatchObject({ proceed: true });
    expect(ask(h, 'code').body).toMatchObject({ proceed: true });
    expect(ask(h, 'code').body).toMatchObject({ proceed: false, reason: 'code-limit' });
    expect(h.note.mock.calls.map((c) => c[1])).toEqual([
      'intent-refused-origin-not-google', 'intent-refused-heading-not-2sv', 'intent-heading-2sv', 'code-refused-heading-not-2sv',
      'code-1-heading-2sv', 'code-2-heading-2sv', 'code-refused-code-limit']);
    expect(h.queuePhoneTap).not.toHaveBeenCalled();
    expect(h.helper.isDriving('ep-9')).toBe(true); // requests never settle the drive
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('the supervision latch refuses a new use until earlier ones are reviewed; re-asking within the granted attempt is fine', async () => {
    for (const latch of ['awaiting-review', 'review-failed'] as const) {
      const h = await liveHelper('on', () => latch);
      expect(ask(h, 'intent').body).toMatchObject({ proceed: false, reason: latch });
      expect(ask(h, 'code').body).toMatchObject({ proceed: false, reason: 'no-intent' });
      h.helper.submit('ep-9', h.token, { code: VALID });
      await h.drive;
    }
    let state: 'open' | 'awaiting-review' = 'open';
    const h = await liveHelper('on', () => state);
    expect(ask(h, 'intent').body).toMatchObject({ proceed: true });
    state = 'awaiting-review'; // this attempt's own grant now makes the machine wait for review
    expect(ask(h, 'intent').body).toMatchObject({ proceed: true });
    expect(ask(h, 'code').body).toMatchObject({ proceed: true });
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('a non-Claude-Code helper seat never gets the step: old prompt, every request refused', async () => {
    const h = await liveHelper('on', () => 'open', 'codex-cli');
    expect(h.prompt()).not.toContain('This account has an authenticator code saved.');
    expect(ask(h, 'intent').body).toMatchObject({ proceed: false, reason: 'not-enabled' });
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('codes granted before a restart still count: the limit survives a resumed attempt', async () => {
    const h = await liveHelper('on', () => 'open', 'claude-code', 2);
    expect(ask(h, 'intent').body).toMatchObject({ proceed: true });
    expect(ask(h, 'code').body).toMatchObject({ proceed: false, reason: 'code-limit' });
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('reports a live drive so the review route can refuse while any helper runs', async () => {
    const h = await liveHelper('on');
    expect(h.helper.isAnyDriving()).toBe(true);
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
    expect(h.helper.isAnyDriving()).toBe(false);
  });

  it('a helper that survives a failed kill still counts as driving until it is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-unreaped-')); tmp.push(dir);
    let alive = true; let prompt = '';
    const helper = new SubscriptionReloginHelper({
      lease: new PlaywrightSeatLease({ filePath: path.join(dir, 'lease.json') }), hasCapacity: () => true,
      pickSeat: async () => SEAT, spawn: async (i: { prompt: string }) => { prompt = i.prompt; return 'proj-relogin-ep-9'; },
      isAlive: () => alive, kill: () => { throw new Error('kill failed'); }, listHelpers: () => [], credentialReady: async () => false,
      queuePhoneTap: vi.fn(), validateCode: validClaudePasteBackCode, serverPort: 4042, pollMs: 10, startGraceMs: 0, exitSettleMs: 0,
    } as never);
    const ep = { id: 'ep-9', sourceEpisodeId: 1, accountId: 'broken', machineId: 'm1', mode: 'unattended', state: 'browser-driving',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'p1', framework: 'claude-code', provider: 'anthropic', attemptCount: 1,
      reissueCount: 0, approvedAt: null, approvalExpiresAt: null, startedAt: null, finishedAt: null, nextAttemptAt: null,
      failureClass: null, version: 3, createdAt: '', updatedAt: '', loginMethod: 'password+totp' };
    const drive = helper.drive({ episode: ep as never, artifact: { attemptId: 'l', kind: 'url-code-paste', expiresAt: new Date(Date.now() + 1_800_000).toISOString(), reissueCount: 0 } as never,
      verificationUrl: 'https://claude.ai/oauth/authorize?x=1', expectedEmail: 'person@example.com', provider: 'anthropic',
      profileDir: '/p', vaultBindingNames: [], authenticatorMode: 'on' }, new AbortController().signal);
    await vi.waitFor(() => expect(prompt).toContain('X-Relogin-Helper-Token'));
    const token = /X-Relogin-Helper-Token: ([A-Za-z0-9_-]+)/.exec(prompt)![1]!;
    helper.submit('ep-9', token, { code: VALID });
    await drive;
    expect(helper.isDriving('ep-9')).toBe(false);
    expect(helper.isAnyDriving()).toBe(true); // the session is still alive after the failed kill
    alive = false;
    expect(helper.isAnyDriving()).toBe(false);
  });

  it('a fail recorded mid-drive stops further codes in an already granted drive', async () => {
    let state: 'open' | 'review-failed' = 'open';
    const h = await liveHelper('on', () => state);
    expect(ask(h, 'intent').body).toMatchObject({ proceed: true });
    expect(ask(h, 'code').body).toMatchObject({ proceed: true });
    state = 'review-failed';
    expect(ask(h, 'code').body).toMatchObject({ proceed: false, reason: 'review-failed' });
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('a code request without a granted intent is refused', async () => {
    const h = await liveHelper('on');
    expect(ask(h, 'code').body).toMatchObject({ proceed: false, reason: 'no-intent' });
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('the cap never drops a label that blocks a slow retry', async () => {
    const h = await liveHelper('on');
    for (const r of ['accepted', 'no-option', 'shadow-would-use', 'shadow-would-stop']) {
      for (const hd of [H, 'x', '']) ask(h, r, hd);
    }
    expect(h.note.mock.calls.length).toBe(12);
    ask(h, 'rejected');
    expect(h.note.mock.calls.map((c) => c[1])).toContain('rejected-heading-2sv');
    expect(ask(h, 'intent').body).toMatchObject({ proceed: true });
    expect(h.note.mock.calls.map((c) => c[1])).toContain('intent-heading-2sv'); // the grant record is never dropped
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('refuses every request outside on mode (shadow and off) and records the reports', async () => {
    for (const mode of ['shadow', 'off'] as const) {
      const h = await liveHelper(mode);
      expect(ask(h, 'intent').body).toMatchObject({ proceed: false, reason: 'not-enabled' });
      expect(ask(h, 'code').body).toMatchObject({ proceed: false, reason: 'not-enabled' });
      expect(ask(h, 'shadow-would-use').body).toEqual({ accepted: true, notice: 'authenticator' });
      expect(h.note.mock.calls.map((c) => c[1])).toEqual(['intent-refused-not-enabled', 'code-refused-not-enabled', 'shadow-would-use-heading-2sv']);
      h.helper.submit('ep-9', h.token, { code: VALID });
      await h.drive;
    }
  });

  it('reports dedupe on result plus heading class', async () => {
    const h = await liveHelper('on');
    ask(h, 'accepted'); ask(h, 'accepted'); ask(h, 'accepted', "Verify it's you");
    expect(h.note.mock.calls.map((c) => c[1])).toEqual(['accepted-heading-2sv', 'accepted-heading-other']);
    for (let i = 0; i < 30; i++) ask(h, 'accepted', `x${i}`);
    expect(h.note.mock.calls.length).toBeLessThanOrEqual(12);
    h.helper.submit('ep-9', h.token, { code: VALID });
    await h.drive;
  });

  it('the store records reports as plain audit, but any granted, rejected or refused code blocks a slow retry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-store-')); tmp.push(dir);
    let n = 0;
    const store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => `repair-${++n}` });
    const fresh = () => store.suggest({ sourceEpisodeId: 7 + n, accountId: `acct-${n}`, machineId: 'machine-1', mode: 'unattended',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    const plain = fresh();
    for (const label of ['intent-heading-2sv', 'accepted-heading-2sv', 'shadow-would-use-heading-2sv']) {
      store.recordAuthenticatorEvent(plain.id, label);
    }
    expect(store.listEvents(plain.id).map((e) => e.eventClass)).toContain('helper-authenticator-accepted-heading-2sv');
    expect(store.challengedSinceAdmission(plain.id)).toBe(false);
    for (const label of ['rejected-heading-2sv', 'code-refused-code-limit', 'code-1-heading-2sv', 'code-2-heading-2sv']) {
      const ep = fresh();
      store.recordAuthenticatorEvent(ep.id, label);
      expect(store.challengedSinceAdmission(ep.id)).toBe(true);
    }
    store.close();
  });

  it('supervision: one use per granted drive, each reviewed before the next, a fail closes for good', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-sup-')); tmp.push(dir);
    let n = 0;
    const store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => `sup-${++n}` });
    const fresh = () => store.suggest({ sourceEpisodeId: 100 + n, accountId: `acct-${n}`, machineId: 'machine-1', mode: 'unattended',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'open', grants: 0, passes: 0, unreviewed: 0, supervisedUses: 3 });
    const plain = fresh();
    store.cancel(plain.id);
    expect(() => store.recordAuthenticatorReview(plain.id, 'pass')).toThrow('authenticator-review-not-applicable');
    const live = fresh();
    store.approve(live.id, { inputDigest: live.inputDigest }); // a running repair, not suggested
    store.recordAuthenticatorUse(live.id, 'drive-1');
    store.recordAuthenticatorUse(live.id, 'drive-1'); // idempotent per drive
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'awaiting-review', grants: 1, unreviewed: 1 });
    expect(store.authenticatorSupervision('drive-1').state).toBe('open'); // the asking drive's own use does not block it
    expect(() => store.recordAuthenticatorReview(live.id, 'pass')).toThrow('authenticator-review-drive-live');
    store.cancel(live.id);
    store.recordAuthenticatorReview(live.id, 'pass');
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'open', passes: 1, unreviewed: 0 });
    // A second drive on the SAME repair (a resume or a retry) is a new use that needs its own review.
    store.recordAuthenticatorUse(live.id, 'drive-2');
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'awaiting-review', grants: 2, unreviewed: 1 });
    store.recordAuthenticatorReview(live.id, 'pass'); // goes to the oldest unreviewed use: no deadlock
    expect(() => store.recordAuthenticatorReview(live.id, 'pass')).toThrow('authenticator-review-already-recorded');
    const third = fresh();
    store.recordAuthenticatorUse(third.id, 'drive-3');
    store.cancel(third.id);
    store.recordAuthenticatorReview(third.id, 'pass');
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'open', passes: 3 });
    const later = fresh();
    store.recordAuthenticatorUse(later.id, 'drive-4');
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'open', grants: 4, unreviewed: 1 }); // past supervision
    // The off switch: a fail can be recorded over an earlier pass, once.
    store.recordAuthenticatorReview(third.id, 'fail');
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'review-failed', passes: 2, fails: 1 });
    expect(() => store.recordAuthenticatorReview(third.id, 'fail')).toThrow('authenticator-review-already-recorded');
    store.close();
  });

  it('an inconclusive review lets the next use go ahead without counting as a pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-inc-')); tmp.push(dir);
    const store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => 'inc-1' });
    const ep = store.suggest({ sourceEpisodeId: 400, accountId: 'acct-i', machineId: 'machine-1', mode: 'unattended',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    store.recordAuthenticatorUse(ep.id, 'drive-i');
    store.cancel(ep.id);
    expect(store.authenticatorSupervision().state).toBe('awaiting-review');
    store.recordAuthenticatorReview(ep.id, 'inconclusive');
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'open', passes: 0 });
    expect(() => store.recordAuthenticatorReview(ep.id, 'pass')).toThrow('authenticator-review-already-recorded');
    store.recordAuthenticatorReview(ep.id, 'fail');
    expect(store.authenticatorSupervision().state).toBe('review-failed');
    store.close();
  });

  it('a fail is accepted at any time, even for a running repair or one never granted the step', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-fail-')); tmp.push(dir);
    let n = 0;
    const store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => `fail-${++n}` });
    const running = store.suggest({ sourceEpisodeId: 500, accountId: 'acct-f', machineId: 'machine-1', mode: 'unattended',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    expect(() => store.recordAuthenticatorReview(running.id, 'pass')).toThrow('authenticator-review-not-applicable');
    store.recordAuthenticatorReview(running.id, 'fail'); // no use, not finished: still closes the step
    expect(store.authenticatorSupervision()).toMatchObject({ state: 'review-failed', fails: 1 });
    expect(() => store.recordAuthenticatorReview(running.id, 'fail')).toThrow('authenticator-review-already-recorded');
    store.close();
  });

  it('a no-option report blocks a slow retry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-noopt-')); tmp.push(dir);
    const store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => 'noopt-1' });
    const ep = store.suggest({ sourceEpisodeId: 600, accountId: 'acct-n', machineId: 'machine-1', mode: 'unattended',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    store.recordAuthenticatorEvent(ep.id, 'no-option-heading-2sv');
    expect(store.challengedSinceAdmission(ep.id)).toBe(true);
    store.close();
  });

  it('counts codes granted since the latest admission only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-auth-codes-')); tmp.push(dir);
    const store = new SubscriptionReloginStore({ stateDir: dir, idFactory: () => 'codes-1' });
    const ep = store.suggest({ sourceEpisodeId: 300, accountId: 'acct-c', machineId: 'machine-1', mode: 'unattended',
      inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'profile-1', framework: 'claude-code', provider: 'anthropic' });
    expect(store.authenticatorCodesGranted(ep.id)).toBe(0);
    store.recordAuthenticatorEvent(ep.id, 'code-1-heading-2sv');
    store.recordAuthenticatorEvent(ep.id, 'intent-heading-2sv');
    expect(store.authenticatorCodesGranted(ep.id)).toBe(1);
    store.approve(ep.id, { inputDigest: ep.inputDigest }); // a new approval starts a fresh count
    expect(store.authenticatorCodesGranted(ep.id)).toBe(0);
    store.close();
  });

});
