// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  decideAutonomousStartStatus,
  findStuckPreparingRuns,
  PreparingRunWatchdog,
  PREPARING_NOTICE_AFTER_BOUND_MS,
  PREPARING_NOTICE_AFTER_MS,
  PREPARING_NOTICE_MAX_ATTEMPTS,
  renderPreparingNotice,
  telegramTopicNotifier,
} from '../../src/core/AutonomousStartAdmission.js';

const NOW = Date.parse('2026-11-02T02:00:00.000Z');
const enforcing = { enabled: true, dryRun: false, state: null };
const openLedger = { windowId: 'w-open', state: 'active_start', windowCeilingAt: new Date(NOW + 3_600_000).toISOString() };

describe('decideAutonomousStartStatus', () => {
  it('starts active on Echo when liveness enforces but no window is open (the 2026-11-01 incident)', () => {
    const closed = { windowId: 'w32', state: 'closed_failed', windowCeilingAt: '2026-09-08T11:45:56.904Z', recurrenceFrozenAt: '2026-09-08T11:45:56.904Z' };
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '9210', liveness: enforcing, windowLedger: closed, nowMs: NOW }))
      .toEqual({ initialStatus: 'active', reason: 'no-open-window' });
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '9210', liveness: enforcing, windowLedger: null, nowMs: NOW }).initialStatus).toBe('active');
  });

  it('prepares only while an open window has a slot this run can actually bind', () => {
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '36966', liveness: enforcing, windowLedger: openLedger, nowMs: NOW }))
      .toEqual({ initialStatus: 'preparing', reason: 'open-window-awaits-liveness' });
    const finishedEarlierWindow = { ...enforcing, state: { topicId: 1, windowId: 'w-previous', status: 'stalled' } };
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '36966', liveness: finishedEarlierWindow, windowLedger: openLedger, nowMs: NOW }).initialStatus).toBe('preparing');
  });

  it('starts active when the slot is live (any topic, including this one) or this window already finished', () => {
    const heldOther = { ...enforcing, state: { topicId: 1, windowId: 'w-open', status: 'active' } };
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '36966', liveness: heldOther, windowLedger: openLedger, nowMs: NOW }))
      .toEqual({ initialStatus: 'active', reason: 'liveness-slot-held' });
    const heldSameTopic = { ...enforcing, state: { topicId: 36966, windowId: 'w-open', status: 'preparing' } };
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '36966', liveness: heldSameTopic, windowLedger: openLedger, nowMs: NOW }).initialStatus).toBe('active');
    const sameWindowFailed = { ...enforcing, state: { topicId: 36966, windowId: 'w-open', status: 'failed' } };
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '36966', liveness: sameWindowFailed, windowLedger: openLedger, nowMs: NOW }))
      .toEqual({ initialStatus: 'active', reason: 'liveness-window-already-finished' });
  });

  it('starts active past the window ceiling, when dark, in dry-run, or off Echo', () => {
    const expired = { windowId: 'w-old', state: 'active_start', windowCeilingAt: new Date(NOW - 1).toISOString() };
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '1', liveness: enforcing, windowLedger: expired, nowMs: NOW }).initialStatus).toBe('active');
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '1', liveness: null, windowLedger: openLedger, nowMs: NOW }).initialStatus).toBe('active');
    expect(decideAutonomousStartStatus({ projectName: 'echo', topicId: '1', liveness: { ...enforcing, dryRun: true }, windowLedger: openLedger, nowMs: NOW }).initialStatus).toBe('active');
    expect(decideAutonomousStartStatus({ projectName: 'luna', topicId: '1', liveness: enforcing, windowLedger: openLedger, nowMs: NOW }).initialStatus).toBe('active');
  });
});

describe('preparing-run watchdog', () => {
  let dir: string;
  let store: AutonomousRunStore;
  const register = (topicId: string, at: number, initialStatus: 'preparing' | 'active' = 'preparing') => {
    const result = store.register({
      topicId, condition: 'c', workDir: dir, startedAt: new Date(at).toISOString(), endAt: new Date(at + 86_400_000).toISOString(),
      scopeAccretion: { enabled: true, breakerK: 3 }, baseRoots: [], maxDurationMs: 172_800_000, initialStatus,
    }, at);
    if (!result.ok) throw new Error('register failed');
    return result.runId;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'start-admission-'));
    store = new AutonomousRunStore(dir);
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'start-admission-test.cleanup' }); });

  it('picks preparing runs past the threshold, not fresh, active, or bound-and-young ones', () => {
    const stuck = register('1', NOW - PREPARING_NOTICE_AFTER_MS);
    register('2', NOW - PREPARING_NOTICE_AFTER_MS + 1_000);
    register('3', NOW - 60 * 60_000, 'active');
    const bound = register('4', NOW - 10 * 60_000);
    const boundAt = new Date(NOW).toISOString(); // bound late: the allowance runs from here, not from registration
    const found = findStuckPreparingRuns(store.listOpen(NOW), { nowMs: NOW, boundRun: { topicId: '4', runId: bound, boundAt } });
    expect(found.map(run => run.runId)).toEqual([stuck]);
    const later = NOW + PREPARING_NOTICE_AFTER_BOUND_MS - 60_000;
    expect(findStuckPreparingRuns(store.listOpen(later), { nowMs: later, boundRun: { topicId: '4', runId: bound, boundAt } }).map(run => run.topicId).sort()).toEqual(['1', '2']);
    const lateBound = NOW + PREPARING_NOTICE_AFTER_BOUND_MS;
    expect(findStuckPreparingRuns(store.listOpen(lateBound), { nowMs: lateBound, boundRun: { topicId: '4', runId: bound, boundAt } }).map(run => run.topicId).sort()).toEqual(['1', '2', '4']);
  });

  it('tells the run topic once, in plain words, and retries a failed send', async () => {
    const runId = register('9210', NOW - 20 * 60_000);
    const sent: Array<{ topicId: string; text: string }> = [];
    let deliver = false;
    const watchdog = new PreparingRunWatchdog({
      store, now: () => NOW,
      notify: async (topicId, text) => { if (!deliver) return false; sent.push({ topicId, text }); return true; },
    });
    expect(await watchdog.tick()).toEqual([]);
    expect(store.getByPair('9210', runId)?.preparingNoticeAt).toBeUndefined();
    deliver = true;
    expect(await watchdog.tick()).toEqual([runId]);
    expect(await watchdog.tick()).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe('9210');
    expect(sent[0].text).toContain('did not start');
    expect(sent[0].text).toContain('20 minutes ago');
    expect(store.getByPair('9210', runId)?.preparingNoticeAt).toBe(new Date(NOW).toISOString());
  });

  it('gives up on a run after the attempt cap when delivery keeps failing', async () => {
    const runId = register('7', NOW - 20 * 60_000);
    let calls = 0;
    const watchdog = new PreparingRunWatchdog({ store, now: () => NOW, notify: async () => { calls++; throw new Error('telegram down'); } });
    for (let i = 0; i < PREPARING_NOTICE_MAX_ATTEMPTS + 3; i++) await watchdog.tick();
    expect(calls).toBe(PREPARING_NOTICE_MAX_ATTEMPTS);
    expect(store.getByPair('7', runId)?.preparingNoticeAttempts).toBe(PREPARING_NOTICE_MAX_ATTEMPTS);
    expect(store.getByPair('7', runId)?.preparingNoticeAt).toBeUndefined();
  });

  it('does not tell a run promoted since the scan that it never started', async () => {
    const runId = register('8', NOW - 20 * 60_000);
    let calls = 0;
    const racing = {
      listOpen: (now: number) => store.listOpen(now),
      update: (topicId: string, id: string, mutate: Parameters<AutonomousRunStore['update']>[2]) => {
        store.update(topicId, id, (rec) => { rec.status = 'active'; });
        return store.update(topicId, id, mutate);
      },
    };
    const watchdog = new PreparingRunWatchdog({ store: racing, now: () => NOW, notify: async () => { calls++; return true; } });
    expect(await watchdog.tick()).toEqual([]);
    expect(calls).toBe(0);
    expect(store.getByPair('8', runId)?.preparingNoticeAttempts).toBeUndefined();
  });

  it('marks the notice before sending, so a busy lock afterwards cannot cause a second copy', async () => {
    const runId = register('10', NOW - 20 * 60_000);
    let calls = 0;
    let updates = 0;
    const flaky = {
      listOpen: (now: number) => store.listOpen(now),
      update: (topicId: string, id: string, mutate: Parameters<AutonomousRunStore['update']>[2]) => {
        updates++;
        if (updates > 1) throw new Error('standing-drive-mutation-busy');
        return store.update(topicId, id, mutate);
      },
    };
    const watchdog = new PreparingRunWatchdog({ store: flaky, now: () => NOW, notify: async () => { calls++; return true; } });
    expect(await watchdog.tick()).toEqual([runId]);
    expect(await watchdog.tick()).toEqual([]);
    expect(calls).toBe(1);
  });

  it('ignores expired runs', async () => {
    register('5', NOW - 2 * 86_400_000);
    const watchdog = new PreparingRunWatchdog({ store, now: () => NOW, notify: async () => true });
    expect(await watchdog.tick()).toEqual([]);
  });

  it('renders a notice naming the run', () => {
    const runId = register('6', NOW - 60_000);
    const text = renderPreparingNotice(store.getByPair('6', runId)!, NOW);
    expect(text).toContain('1 minute ago');
    expect(text).toContain(runId);
  });
});

describe('telegramTopicNotifier', () => {
  it('sends to a numeric topic and reports sent', async () => {
    const sent: Array<[number, string]> = [];
    const notify = telegramTopicNotifier(async (topic, text) => { sent.push([topic, text]); });
    expect(await notify('42', 'hi')).toBe(true);
    expect(sent).toEqual([[42, 'hi']]);
  });

  it('reports not sent for a non-numeric topic and never calls send', async () => {
    let calls = 0;
    const notify = telegramTopicNotifier(async () => { calls++; });
    expect(await notify('slack:abc', 'hi')).toBe(false);
    expect(calls).toBe(0);
  });

  it('propagates a send failure so the watchdog counts the attempt', async () => {
    const notify = telegramTopicNotifier(async () => { throw new Error('telegram down'); });
    await expect(notify('42', 'hi')).rejects.toThrow('telegram down');
  });
});
