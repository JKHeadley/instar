// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * QuotaPoller's device-limit additions (spec codex-device-limit-tripwire §2 A′, §3, §6): the
 * afterCodexRead hook on every live read, the CodexReadGate (single-flight per home, cap 2,
 * priority), requestCodexCheck's 10-minute floor, the benched-account backoff in pollAll, the
 * restore hold, and codexLoginStatusWithText.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, CODEX_CHECK_FLOOR_MS } from '../../src/core/QuotaPoller.js';
import { CodexDeviceLimitTripwire } from '../../src/core/CodexDeviceLimitTripwire.js';
import type { CodexLiveRead } from '../../src/providers/adapters/openai-codex/observability/codexLiveRateLimitReader.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const liveSnapshot = () => ({
  source: 'codex-app-server' as const, rolloutPath: '', threadId: null,
  capturedAt: '2026-10-31T12:00:00.000Z', model: null, planType: 'pro', rateLimitReachedType: null,
  primary: { usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: 1793500000,
    resetsAtIso: '2026-11-01T12:00:00.000Z', resetsInSeconds: 1 },
  secondary: null,
});
const rolloutSnapshot = () => ({ ...liveSnapshot(), source: 'codex-rollout' as const, rolloutPath: '/r.jsonl', threadId: 't' });
const OK: CodexLiveRead = { kind: 'ok', snapshot: liveSnapshot() };
const codex = (id: string) => ({ id, nickname: id, email: `${id}@example.test`, provider: 'openai' as const,
  framework: 'codex-cli' as const, configHome: `/home/x/.codex-${id}` });

function fakeTripwire(overrides: Record<string, unknown> = {}) {
  return {
    afterCodexRead: vi.fn(),
    afterLoginStatusText: vi.fn(),
    skipScheduledRead: vi.fn(() => false),
    holdsRestore: vi.fn(() => false),
    tick: vi.fn(),
    ...overrides,
  };
}

/** A reader whose reads the test resolves by hand. */
function deferredReader() {
  const pending: Array<{ home: string; resolve: (r: CodexLiveRead) => void }> = [];
  const reader = vi.fn((opts?: { codexHome?: string }) => new Promise<CodexLiveRead>((resolve) => {
    pending.push({ home: opts?.codexHome ?? '', resolve });
  }));
  return { reader, pending };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('QuotaPoller device-limit hooks', () => {
  let dir: string;
  let pool: SubscriptionPool;
  let clock = NOW;
  beforeEach(() => { clock = NOW; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-dl-')); pool = new SubscriptionPool({ stateDir: dir }); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'quota-poller-device-limit cleanup' }); });

  function poller(reader: (o?: { codexHome?: string }) => Promise<CodexLiveRead>, extra: Record<string, unknown> = {}) {
    return new QuotaPoller({
      pool, now: () => clock,
      codexLiveUsageReaderDetailed: reader,
      codexUsageReader: async () => rolloutSnapshot(),
      ...extra,
    } as never);
  }

  it('every live read hands kind, refusal and scheduled to the tripwire', async () => {
    pool.addFixture(codex('a'));
    const refusal = { stage: 'read' as const, text: 'device limit reached' };
    let next: CodexLiveRead = OK;
    const p = poller(async () => next);
    const tw = fakeTripwire();
    p.setDeviceLimitTripwire(tw as never);
    await p.pollAll();
    expect(tw.afterCodexRead).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }), { kind: 'ok', scheduled: true });
    next = { kind: 'auth-failed', refusal };
    await p.requestCodexCheck('a', { confirmation: true });
    expect(tw.afterCodexRead).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }), { kind: 'auth-failed', refusal, scheduled: false });
    expect(tw.afterCodexRead).toHaveBeenCalledTimes(2);
  });

  it('a rollout-file fallback is not a clean read: the hook sees the live kind, and the check is not "working"', async () => {
    pool.addFixture(codex('a'));
    const refusal = { stage: 'read' as const, text: 'nope' };
    const p = poller(async () => ({ kind: 'unavailable', refusal }));
    const tw = fakeTripwire();
    p.setDeviceLimitTripwire(tw as never);
    const working = await p.requestCodexCheck('a', { confirmation: true });
    expect(working).toBe(false);
    expect(tw.afterCodexRead).toHaveBeenCalledWith(expect.anything(), { kind: 'unavailable', refusal, scheduled: false });
    expect(pool.get('a')!.lastQuota?.source).toBe('codex-rollout');
  });

  it('requestCodexCheck resolves true only for a live app-server read', async () => {
    pool.addFixture(codex('a'));
    const p = poller(async () => OK);
    expect(await p.requestCodexCheck('a', { confirmation: true })).toBe(true);
    expect(await p.requestCodexCheck('missing', { confirmation: true })).toBe(false);
  });

  it('single-flight per home: two concurrent reads of one home ⇒ one reader call', async () => {
    pool.addFixture(codex('a'));
    const { reader, pending } = deferredReader();
    const p = poller(reader);
    const r1 = p.requestCodexCheck('a', { confirmation: true });
    const r2 = p.requestCodexCheck('a', { confirmation: true });
    await settle();
    expect(reader).toHaveBeenCalledTimes(1);
    pending[0].resolve(OK);
    expect(await Promise.all([r1, r2])).toEqual([true, true]);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('caps concurrent live reads at 2 and starts confirmation reads ahead of trigger reads', async () => {
    for (const id of ['a', 'b', 'c', 'd']) pool.addFixture(codex(id));
    const { reader, pending } = deferredReader();
    const p = poller(reader);
    const ra = p.requestCodexCheck('a', { confirmation: true });
    const rb = p.requestCodexCheck('b', { confirmation: true });
    await settle();
    const rc = p.requestCodexCheck('c'); // trigger, queued first
    await settle();
    const rd = p.requestCodexCheck('d', { confirmation: true }); // confirmation, queued second
    await settle();
    expect(reader).toHaveBeenCalledTimes(2);
    pending[0].resolve(OK);
    await settle();
    expect(reader).toHaveBeenCalledTimes(3);
    expect(pending[2].home).toBe('/home/x/.codex-d');
    pending[1].resolve(OK);
    await settle();
    expect(pending[3].home).toBe('/home/x/.codex-c');
    pending[2].resolve(OK); pending[3].resolve(OK);
    expect(await Promise.all([ra, rb, rc, rd])).toEqual([true, true, true, true]);
  });

  it('a trigger check honours the 10-minute floor; a confirmation bypasses it', async () => {
    pool.addFixture(codex('a'));
    const reader = vi.fn(async () => OK);
    const p = poller(reader);
    await p.requestCodexCheck('a');
    expect(reader).toHaveBeenCalledTimes(1);
    clock += CODEX_CHECK_FLOOR_MS - 1;
    expect(await p.requestCodexCheck('a')).toBe(false);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(await p.requestCodexCheck('a', { confirmation: true })).toBe(true);
    expect(reader).toHaveBeenCalledTimes(2);
    clock += CODEX_CHECK_FLOOR_MS;
    expect(await p.requestCodexCheck('a')).toBe(true);
    expect(reader).toHaveBeenCalledTimes(3);
  });

  it('the scheduled pass also counts toward the floor', async () => {
    pool.addFixture(codex('a'));
    const reader = vi.fn(async () => OK);
    const p = poller(reader);
    await p.pollAll();
    expect(await p.requestCodexCheck('a')).toBe(false);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('requestCodexCheck refuses non-Codex and disabled accounts', async () => {
    pool.addFixture(codex('a'));
    pool.update('a', { status: 'disabled' });
    const reader = vi.fn(async () => OK);
    const p = poller(reader);
    expect(await p.requestCodexCheck('a', { confirmation: true })).toBe(false);
    expect(reader).not.toHaveBeenCalled();
  });

  it('pollAll skips an account the tripwire backs off, and runs tick() once per pass', async () => {
    pool.addFixture(codex('a'));
    pool.addFixture(codex('b'));
    const reader = vi.fn(async () => OK);
    const p = poller(reader);
    const tw = fakeTripwire({ skipScheduledRead: vi.fn((acct: { id: string }) => acct.id === 'a') });
    p.setDeviceLimitTripwire(tw as never);
    const r = await p.pollAll();
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0]).toMatchObject({ codexHome: '/home/x/.codex-b' });
    expect(r).toEqual({ polled: 1, failed: 0 });
    expect(tw.tick).toHaveBeenCalledTimes(1);
  });

  it('a throwing tick() does not fail the pass', async () => {
    pool.addFixture(codex('a'));
    const p = poller(async () => OK);
    p.setDeviceLimitTripwire(fakeTripwire({ tick: vi.fn(() => { throw new Error('boom'); }) }) as never);
    await expect(p.pollAll()).resolves.toEqual({ polled: 1, failed: 0 });
  });

  it('pollAll respects deviceLimitNextReadAt with the real tripwire, then reads once it passes', async () => {
    pool.addFixture(codex('a'));
    pool.addFixture(codex('b'));
    pool.update('a', { status: 'needs-reauth', statusCause: 'codex-device-limit',
      deviceLimitNextReadAt: new Date(NOW + 60 * 60_000).toISOString() });
    const reader = vi.fn(async () => OK);
    const p = poller(reader);
    p.setDeviceLimitTripwire(realTripwire(pool, p, () => clock));
    await p.pollAll();
    expect(reader.mock.calls.map((c) => c[0]!.codexHome)).toEqual(['/home/x/.codex-b']);
    clock += 60 * 60_000;
    await p.pollAll();
    expect(reader.mock.calls.map((c) => c[0]!.codexHome)).toContain('/home/x/.codex-a');
  });

  it('restore hold: one clean read in pollOne does not restore a benched account (an ordinary needs-reauth is restored)', async () => {
    pool.addFixture(codex('a'));
    pool.addFixture(codex('b'));
    pool.update('a', { status: 'needs-reauth', statusCause: 'codex-device-limit',
      deviceLimitNextReadAt: new Date(NOW - 1).toISOString() });
    pool.update('b', { status: 'needs-reauth' });
    const p = poller(async () => OK);
    p.setDeviceLimitTripwire(realTripwire(pool, p, () => clock));
    await p.pollAll();
    expect(pool.get('a')!.status).toBe('needs-reauth');
    expect(pool.get('a')!.statusCause).toBe('codex-device-limit');
    expect(pool.get('b')!.status).toBe('active');
  });

  it('codexLoginStatusWithText replaces codexLoginStatus; its text reaches the tripwire when not signed-in', async () => {
    pool.addFixture(codex('a'));
    const plain = vi.fn(async () => 'signed-out' as const);
    let verdict: 'signed-out' | 'signed-in' = 'signed-out';
    const withText = vi.fn(async () => ({ verdict, text: 'Logged out: too many devices' }));
    const p = poller(async () => ({ kind: 'auth-failed' }), { codexLoginStatus: plain, codexLoginStatusWithText: withText });
    const tw = fakeTripwire();
    p.setDeviceLimitTripwire(tw as never);
    await p.pollAll();
    expect(withText).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    expect(tw.afterLoginStatusText).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'Logged out: too many devices');
    verdict = 'signed-in';
    clock += 15 * 60_000;
    await p.pollAll();
    expect(withText).toHaveBeenCalledTimes(2);
    expect(tw.afterLoginStatusText).toHaveBeenCalledTimes(1);
  });
  it('regression: two queued reads of one home while the gate is full share ONE read', async () => {
    pool.addFixture(codex('a')); pool.addFixture(codex('b')); pool.addFixture(codex('c'));
    const { reader, pending } = deferredReader();
    const p = poller(reader);
    p.setDeviceLimitTripwire(fakeTripwire() as never);
    const ra = p.requestCodexCheck('a', { confirmation: true });
    const rb = p.requestCodexCheck('b', { confirmation: true });
    await settle();
    const c1 = p.requestCodexCheck('c', { confirmation: true });
    const c2 = p.requestCodexCheck('c', { confirmation: true });
    await settle();
    expect(reader).toHaveBeenCalledTimes(2); // a and b hold the two slots; c is queued once
    pending.shift()!.resolve(OK); await settle();
    pending.shift()!.resolve(OK); await settle();
    expect(reader.mock.calls.filter((c) => (c[0] as { codexHome?: string })?.codexHome?.endsWith('-c')).length).toBe(1);
    while (pending.length) { pending.shift()!.resolve(OK); await settle(); }
    await Promise.all([ra, rb, c1, c2]);
  });

  it('regression: a trigger read the gate drops is not a read (no floor, no signal reset, no snapshot)', async () => {
    pool.addFixture(codex('a')); pool.addFixture(codex('b')); pool.addFixture(codex('c'));
    const { reader, pending } = deferredReader();
    const p = poller(reader);
    const tw = fakeTripwire();
    p.setDeviceLimitTripwire(tw as never);
    const ra = p.requestCodexCheck('a', { confirmation: true });
    const rb = p.requestCodexCheck('b', { confirmation: true });
    await settle();
    const dropped = p.requestCodexCheck('c'); // trigger, queued behind two running reads
    await settle();
    clock += CODEX_CHECK_FLOOR_MS + 1; // waits past its own floor
    pending.shift()!.resolve(OK); await settle(); // frees a slot ⇒ the queued trigger is dropped
    expect(await dropped).toBe(false);
    expect(tw.afterCodexRead.mock.calls.some((c) => (c[0] as { id: string }).id === 'c')).toBe(false);
    expect(pool.get('c')?.lastQuota ?? null).toBeNull();
    // The floor did not start: the next trigger check for c actually reads.
    pending.shift()!.resolve(OK); await settle();
    const again = p.requestCodexCheck('c');
    await settle();
    expect(reader.mock.calls.some((c) => (c[0] as { codexHome?: string })?.codexHome?.endsWith('-c'))).toBe(true);
    while (pending.length) { pending.shift()!.resolve(OK); await settle(); }
    await Promise.all([ra, rb, again]);
  });
  it('regression: callers sharing one in-flight read hand it to the tripwire ONCE', async () => {
    pool.addFixture(codex('a'));
    const { reader, pending } = deferredReader();
    const p = poller(reader);
    const tw = fakeTripwire();
    p.setDeviceLimitTripwire(tw as never);
    const r1 = p.requestCodexCheck('a', { confirmation: true });
    const r2 = p.requestCodexCheck('a', { confirmation: true });
    await settle();
    expect(reader).toHaveBeenCalledTimes(1);
    pending.shift()!.resolve(OK); await settle();
    await Promise.all([r1, r2]);
    expect(tw.afterCodexRead).toHaveBeenCalledTimes(1);
  });
});

function realTripwire(pool: SubscriptionPool, p: QuotaPoller, now: () => number): CodexDeviceLimitTripwire {
  return new CodexDeviceLimitTripwire({
    pool, judge: null, machineId: 'm1',
    config: () => ({ enabled: true, ignoreAccounts: [] }),
    requestRead: (id, o) => { void p.requestCodexCheck(id, o); },
    ledger: { benched: () => {}, released: () => {} },
    settleRepairs: () => {}, moveSessions: () => {}, notice: () => {}, log: () => {},
    now, setTimer: () => ({}),
  });
}
