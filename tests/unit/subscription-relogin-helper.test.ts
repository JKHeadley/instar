/**
 * The server side of skill-driven sign-in repair (spec skill-driven-signin-repair): the helper
 * seat, the per-episode token + code route, the lifetime cap, and the kill on every exit. The
 * helper session itself is a fake here — this module only arbitrates.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PlaywrightSeatLease } from '../../src/core/PlaywrightSeatLease.js';
import { SubscriptionReloginHelper, parseHelperBody, renderHelperPrompt, type ReloginHelperSeat } from '../../src/core/SubscriptionReloginHelper.js';
import { validClaudePasteBackCode } from '../../src/core/ClaudePasteBackController.js';
import type { SubscriptionReloginEpisode } from '../../src/core/SubscriptionReloginStore.js';
import type { ReloginArtifact } from '../../src/core/SubscriptionReloginOrchestrator.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-helper.test cleanup' }); });

const SEAT: ReloginHelperSeat = { accountId: 'helper-acct', framework: 'claude-code', configHome: '/home/x/.claude-helper' };
const VALID_CODE = 'a'.repeat(40) + '#' + 'b'.repeat(40);

function episode(id = 'ep-1', accountId = 'broken-acct'): SubscriptionReloginEpisode {
  return { id, sourceEpisodeId: 1, accountId, machineId: 'm1', mode: 'approval', state: 'browser-driving',
    inputDigest: `sha256:${'a'.repeat(64)}`, profileId: 'p1', framework: 'claude-code', provider: 'anthropic',
    attemptCount: 1, reissueCount: 0, approvedAt: null, approvalExpiresAt: null, startedAt: null, finishedAt: null,
    nextAttemptAt: null, failureClass: null, version: 3, createdAt: '', updatedAt: '', loginMethod: null };
}
function artifact(kind: ReloginArtifact['kind'] = 'url-code-paste', expiresInMs = 30 * 60_000): ReloginArtifact {
  return { attemptId: 'login-1', kind, userCode: kind === 'device-code' ? 'ABCD-1234' : undefined,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(), reissueCount: 0 };
}

function harness(overrides: Partial<ConstructorParameters<typeof SubscriptionReloginHelper>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-helper-')); dirs.push(dir);
  const lease = new PlaywrightSeatLease({ filePath: path.join(dir, 'lease.json') });
  let alive = true;
  let prompt = '';
  const spawn = vi.fn(async (input: { prompt: string; seat: ReloginHelperSeat }) => { prompt = input.prompt; return 'proj-relogin-ep-1'; });
  const kill = vi.fn(() => { alive = false; });
  const queuePhoneTap = vi.fn();
  const helper = new SubscriptionReloginHelper({
    lease, hasCapacity: () => true, pickSeat: async () => SEAT, spawn, isAlive: () => alive, kill,
    listHelpers: () => [], credentialReady: async () => false, queuePhoneTap,
    validateCode: validClaudePasteBackCode, serverPort: 4042,
    pollMs: 10, startGraceMs: 0, exitSettleMs: 0, ...overrides,
  });
  const token = () => /X-Relogin-Helper-Token: ([A-Za-z0-9_-]+)/.exec(prompt)?.[1] ?? '';
  return { helper, lease, spawn, kill, queuePhoneTap, token, setAlive: (v: boolean) => { alive = v; }, prompt: () => prompt };
}
const input = (kind: ReloginArtifact['kind'] = 'url-code-paste', expiresInMs?: number) => ({
  episode: episode(), artifact: artifact(kind, expiresInMs), verificationUrl: 'https://claude.ai/oauth/authorize?x=1',
  expectedEmail: 'person@example.com', provider: 'anthropic' as const, profileDir: '/profiles/person', vaultBindingNames: ['google_password_person'],
});
async function waitForSpawn(h: ReturnType<typeof harness>): Promise<void> { await vi.waitFor(() => expect(h.token()).not.toBe('')); }

describe('SubscriptionReloginHelper.preAttempt', () => {
  it('waits without consuming anything while another holder has the machine seat', async () => {
    const h = harness();
    h.lease.acquire('someone-else', 'other drive');
    expect(await h.helper.preAttempt(episode(), new AbortController().signal)).toEqual({ kind: 'wait', reason: 'helper-seat-lease-held' });
  });

  it('waits and releases the lease when session capacity is full', async () => {
    const h = harness({ hasCapacity: () => false });
    expect(await h.helper.preAttempt(episode(), new AbortController().signal)).toEqual({ kind: 'wait', reason: 'session-capacity-full' });
    expect(h.lease.acquire('next', 'x').acquired).toBe(true); // released
  });

  it('reports no-healthy-seat (and releases) when no other healthy account exists — never the repaired one', async () => {
    const none = harness({ pickSeat: async () => null });
    expect(await none.helper.preAttempt(episode(), new AbortController().signal)).toEqual({ kind: 'no-healthy-seat' });
    const self = harness({ pickSeat: async () => ({ ...SEAT, accountId: 'broken-acct' }) });
    expect(await self.helper.preAttempt(episode(), new AbortController().signal)).toEqual({ kind: 'no-healthy-seat' });
    expect(self.lease.acquire('next', 'x').acquired).toBe(true);
  });

  it('holds the lease on ok; releaseAttempt frees it', async () => {
    const h = harness();
    const ep = episode();
    expect(await h.helper.preAttempt(ep, new AbortController().signal)).toEqual({ kind: 'ok' });
    expect(h.lease.acquire('next', 'x').acquired).toBe(false);
    h.helper.releaseAttempt(ep);
    expect(h.lease.acquire('next', 'x').acquired).toBe(true);
  });
});

describe('SubscriptionReloginHelper.drive + submit', () => {
  it('Claude: spawns ONE pinned helper, accepts the code once via the token, kills it and releases the seat', async () => {
    const h = harness();
    const drive = h.helper.drive(input(), new AbortController().signal);
    await waitForSpawn(h);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0]![0]).toMatchObject({ name: 'relogin-ep-1', seat: SEAT });
    expect(h.prompt()).toContain('/subscription-signin skill, section 3');
    expect(h.prompt()).toContain('person@example.com');
    // Wrong token, wrong body shapes, wrong code shape: all refused without settling.
    expect(h.helper.submit('ep-1', 'wrong', { code: VALID_CODE }).status).toBe(403);
    expect(h.helper.submit('ep-1', h.token(), { code: VALID_CODE, extra: 1 }).status).toBe(400);
    expect(h.helper.submit('ep-1', h.token(), { code: 'https://evil.example/x' }).status).toBe(400);
    expect(h.helper.submit('ep-2', h.token(), { code: VALID_CODE }).status).toBe(409);
    expect(h.helper.submit('ep-1', h.token(), { code: VALID_CODE })).toEqual({ status: 202, body: { accepted: true } });
    expect(await drive).toEqual({ outcome: 'approved', pasteCode: VALID_CODE });
    expect(h.kill).toHaveBeenCalledWith('proj-relogin-ep-1');
    expect(h.lease.acquire('next', 'x').acquired).toBe(true);
    // The token dies with the drive.
    expect(h.helper.submit('ep-1', h.token(), { code: VALID_CODE }).status).toBe(409);
  });

  it('Codex device code: no code is posted — the wait resolves when the credential appears', async () => {
    let ready = false;
    const h = harness({ credentialReady: async () => ready });
    const drive = h.helper.drive(input('device-code'), new AbortController().signal);
    await waitForSpawn(h);
    expect(h.prompt()).toContain('ABCD-1234');
    ready = true;
    expect(await drive).toEqual({ outcome: 'approved' });
    expect(h.kill).toHaveBeenCalled();
  });

  it('a helper that exits without delivering is agent-sign-in-unfinished', async () => {
    const h = harness();
    const drive = h.helper.drive(input(), new AbortController().signal);
    await waitForSpawn(h);
    h.setAlive(false);
    expect(await drive).toMatchObject({ outcome: 'refused', failureClass: 'agent-sign-in-unfinished', reason: 'agent-helper-exited' });
  });

  it('the cap (min(15 min, login expiry − 60 s)) ends the wait as agent-sign-in-unfinished', async () => {
    const h = harness({ capMs: 1_000 });
    const result = await h.helper.drive(input(), new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'refused', failureClass: 'agent-sign-in-unfinished', reason: 'agent-helper-cap-reached' });
    expect(h.spawn.mock.calls[0]![0]).toMatchObject({ maxDurationMinutes: 1 });
    // A login expiring within 60 s never spawns a helper.
    const late = harness();
    expect(await late.helper.drive(input('url-code-paste', 30_000), new AbortController().signal))
      .toMatchObject({ outcome: 'transient', failureClass: 'artifact-expired' });
    expect(late.spawn).not.toHaveBeenCalled();
  });

  it('phone-tap queues the fixed notice and keeps waiting; macos-permission ends it as operator-only', async () => {
    const h = harness();
    const drive = h.helper.drive(input(), new AbortController().signal);
    await waitForSpawn(h);
    expect(h.helper.submit('ep-1', h.token(), { notify: 'phone-tap' }).status).toBe(202);
    expect(h.queuePhoneTap).toHaveBeenCalledWith('ep-1');
    expect(h.helper.isDriving('ep-1')).toBe(true);
    expect(h.helper.submit('ep-1', h.token(), { notify: 'macos-permission', permission: 'screen-recording' }).status).toBe(202);
    expect(await drive).toEqual({ outcome: 'operator-only', failureClass: 'automation-permission', reason: 'agent-permission-screen-recording' });
  });

  it('abort (cancel) throws AbortError and still kills the helper and releases the seat', async () => {
    const h = harness();
    const controller = new AbortController();
    const drive = h.helper.drive(input(), controller.signal);
    await waitForSpawn(h);
    controller.abort();
    await expect(drive).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.kill).toHaveBeenCalled();
    expect(h.lease.acquire('next', 'x').acquired).toBe(true);
  });

  it('a spawn refused after the capacity check is a transient seat-busy; a held seat is too', async () => {
    const h = harness({ spawn: async () => { throw new Error('Max sessions reached'); } });
    expect(await h.helper.drive(input(), new AbortController().signal))
      .toMatchObject({ outcome: 'transient', failureClass: 'seat-busy', reason: 'agent-helper-spawn-refused' });
    const busy = harness();
    busy.lease.acquire('other', 'other');
    expect(await busy.helper.drive(input(), new AbortController().signal))
      .toMatchObject({ outcome: 'transient', failureClass: 'seat-busy' });
  });

  it('a submission after the helper has exited gets 409', async () => {
    const h = harness({ startGraceMs: 60_000 });
    const drive = h.helper.drive(input(), new AbortController().signal);
    await waitForSpawn(h);
    h.setAlive(false);
    expect(h.helper.submit('ep-1', h.token(), { code: VALID_CODE }).status).toBe(409);
    h.setAlive(true);
    h.helper.submit('ep-1', h.token(), { code: VALID_CODE });
    await drive;
  });

  it('boot cleanup kills relogin-* sessions this process is not driving', () => {
    const kill = vi.fn();
    const h = harness({ kill, listHelpers: () => [
      { name: 'relogin-old-1', tmuxSession: 'p-relogin-old-1' }, { name: 'other-session', tmuxSession: 'p-other' },
    ] });
    expect(h.helper.killOrphans()).toBe(1);
    expect(kill).toHaveBeenCalledWith('p-relogin-old-1');
    h.helper.killOrphan('old-1');
    expect(kill).toHaveBeenCalledTimes(2);
  });
});

describe('parseHelperBody (strict tagged union)', () => {
  it('accepts exactly the three shapes', () => {
    expect(parseHelperBody({ code: 'x' })).toEqual({ kind: 'code', code: 'x' });
    expect(parseHelperBody({ notify: 'phone-tap' })).toEqual({ kind: 'phone-tap' });
    for (const permission of ['screen-recording', 'accessibility', 'automation']) {
      expect(parseHelperBody({ notify: 'macos-permission', permission })).toEqual({ kind: 'macos-permission', permission });
    }
  });
  it('refuses everything else', () => {
    for (const body of [null, [], 'code', {}, { code: 1 }, { code: '' }, { notify: 'other' }, { notify: 'phone-tap', x: 1 },
      { notify: 'macos-permission' }, { notify: 'macos-permission', permission: 'camera' }, { code: 'x', notify: 'phone-tap' },
      { code: 'x'.repeat(600) }]) {
      expect(parseHelperBody(body)).toBeNull();
    }
  });
});

describe('renderHelperPrompt', () => {
  it('is fixed server text naming section 3, the four hard lines, the focus check and the route — never a secret value', () => {
    const text = renderHelperPrompt({ ...input(), token: 'TOKEN123', port: 4042, seat: SEAT });
    expect(text).toContain('section 3');
    expect(text).toContain('http://127.0.0.1:4042/subscription-relogin/ep-1/code');
    expect(text).toContain('X-Relogin-Helper-Token: TOKEN123');
    expect(text).toContain('Never solve or work around a CAPTCHA');
    expect(text).toContain('Never touch a Chrome window you did not open');
    expect(text).toContain('document.activeElement');
    expect(text).toContain('google_password_person'); // a vault NAME
    expect(text).toContain('The CLI login is ALREADY started');
  });
});
