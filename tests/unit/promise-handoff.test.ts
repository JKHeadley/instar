/**
 * Tier 1 — the handoff to a running session and the backlog epoch.
 * Spec: docs/specs/overdue-promise-follow-through.md §3.2 "Window", §3.3.
 *
 * The handoff must only ever inject into a session that is already running:
 * never spawn, never touch the inbound user-message pipeline.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePickUp, isReleasablePromiseWork, makeLateEpochStore, LATE_EPOCH_FILE, type PromiseWorkRuntime } from '../../src/monitoring/promiseHandoff.js';
import type { PickupRequest } from '../../src/monitoring/promiseKeepingPass.js';

describe('makePickUp (§3.1 typed outcomes)', () => {
  const mk = (over: Partial<PromiseWorkRuntime> = {}) => {
    const rt: PromiseWorkRuntime = {
      getSessionForTopic: (t) => (t === 7 ? 'echo-topic-7' : null),
      isSessionAlive: (s) => s === 'echo-topic-7',
      injectObserved: vi.fn(async () => ({ state: 'submitted' })),
      holdsLease: () => true,
      resumeQueueOwns: () => false,
      capacity: () => ({ ok: true as const }),
      spawnPromiseWork: vi.fn(async () => 'echo-topic-9'),
      log: () => {},
      ...over,
    };
    return { p: makePickUp(rt), rt };
  };
  const req = (topicId: number, over: Partial<PickupRequest> = {}): PickupRequest => ({
    topicId, bootstrap: '[instar promise follow-through — CMT-1]', attemptId: 'a1', triggeredBy: 'promise-work:CMT-1:a1', mayStart: true, onSettled: vi.fn(), ...over,
  });

  it('a running session is notified through the paste inject, never a start', async () => {
    const { p, rt } = mk();
    expect(await p(req(7))).toEqual({ kind: 'notified' });
    expect(rt.spawnPromiseWork).not.toHaveBeenCalled();
  });
  it('an inject that throws or is refused is failed, never notified', async () => {
    expect(await mk({ injectObserved: async () => { throw new Error('x'); } }).p(req(7))).toMatchObject({ kind: 'failed' });
    expect(await mk({ injectObserved: async () => ({ state: 'refused' }) }).p(req(7))).toMatchObject({ kind: 'failed' });
  });
  it('no running session: the start is LAUNCHED and reported pending; it settles later', async () => {
    let resolveSpawn!: (v: string) => void;
    const spawn = vi.fn(() => new Promise<string>((r) => { resolveSpawn = r; }));
    const onSettled = vi.fn();
    const { p } = mk({ spawnPromiseWork: spawn });
    expect(await p(req(9, { onSettled }))).toEqual({ kind: 'pending' });
    expect(spawn).toHaveBeenCalledWith(9, '[instar promise follow-through — CMT-1]', 'promise-work:CMT-1:a1');
    expect(onSettled).not.toHaveBeenCalled();
    resolveSpawn('echo-topic-9');
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: 'started', session: 'echo-topic-9' }));
  });
  it('a spawn that rejects settles as failed', async () => {
    const onSettled = vi.fn();
    const { p } = mk({ spawnPromiseWork: async () => { throw new Error('boom'); } });
    await p(req(9, { onSettled }));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith({ kind: 'failed', error: 'boom' }));
  });
  it.each([
    ['not the lease holder', { holdsLease: () => false }, {}, 'not-holder'],
    ['resume queue owns it', { resumeQueueOwns: () => true }, {}, 'resume-queue-owns'],
    ['pass start budget spent', {}, { mayStart: false }, 'promise-limit'],
    ['no capacity', { capacity: () => ({ ok: false as const, reason: 'full' }) }, {}, 'capacity'],
  ] as const)('held: %s', async (_n, rtOver, reqOver, reason) => {
    const { p, rt } = mk(rtOver as Partial<PromiseWorkRuntime>);
    expect(await p(req(9, reqOver as Partial<PickupRequest>))).toEqual({ kind: 'held', reason });
    expect(rt.spawnPromiseWork).not.toHaveBeenCalled();
  });
  it('a live session idle since the first notice is stuck: a releasable promise-work one is released and replaced', async () => {
    const release = vi.fn(() => true);
    const { p, rt } = mk({
      sessionInfo: () => ({ idleSince: '2026-11-18T19:00:00.000Z', triggeredBy: 'promise-work:CMT-1:a0', startedAt: '2026-11-18T18:00:00.000Z', topicId: 7 }),
      isProtected: () => false,
      personWroteSince: () => false,
      release,
    });
    const out = await p(req(7, { stuckIfIdleSince: '2026-11-18T19:30:00.000Z' }));
    expect(release).toHaveBeenCalledWith('echo-topic-7');
    expect(out).toEqual({ kind: 'pending' });
    expect(rt.spawnPromiseWork).toHaveBeenCalled();
  });
  it('a stuck session the person wrote in is left alone and the attempt fails', async () => {
    const release = vi.fn(() => true);
    const { p } = mk({
      sessionInfo: () => ({ idleSince: '2026-11-18T19:00:00.000Z', triggeredBy: 'promise-work:CMT-1:a0', startedAt: '2026-11-18T18:00:00.000Z', topicId: 7 }),
      isProtected: () => false,
      personWroteSince: () => true,
      release,
    });
    expect(await p(req(7, { stuckIfIdleSince: '2026-11-18T19:30:00.000Z' }))).toEqual({ kind: 'failed', error: 'session-stuck' });
    expect(release).not.toHaveBeenCalled();
  });
  it('a session that went busy after the notice is not stuck', async () => {
    const { p } = mk({ sessionInfo: () => ({ idleSince: '2026-11-18T19:45:00.000Z' }) });
    expect(await p(req(7, { stuckIfIdleSince: '2026-11-18T19:30:00.000Z' }))).toEqual({ kind: 'notified' });
  });
});

describe('isReleasablePromiseWork (§3.6: any unknown → never ended)', () => {
  const base: PromiseWorkRuntime = {
    getSessionForTopic: () => null, isSessionAlive: () => false, injectObserved: async () => ({ state: 'submitted' }),
    holdsLease: () => true, resumeQueueOwns: () => false, capacity: () => ({ ok: true as const }), spawnPromiseWork: async () => '',
    sessionInfo: () => ({ triggeredBy: 'promise-work:CMT-1:a', startedAt: '2026-11-18T18:00:00.000Z', topicId: 7 }),
    isProtected: () => false,
    personWroteSince: () => false,
  };
  it('releasable when every clause is known and holds', () => expect(isReleasablePromiseWork(base, 's')).toBe(true));
  it('not a promise-work session', () => expect(isReleasablePromiseWork({ ...base, sessionInfo: () => ({ triggeredBy: 'scheduler:x', startedAt: 'x', topicId: 7 }) }, 's')).toBe(false));
  it('protected', () => expect(isReleasablePromiseWork({ ...base, isProtected: () => true }, 's')).toBe(false));
  it('the person wrote in it', () => expect(isReleasablePromiseWork({ ...base, personWroteSince: () => true }, 's')).toBe(false));
  it('unknown history', () => expect(isReleasablePromiseWork({ ...base, personWroteSince: () => null }, 's')).toBe(false));
  it('no protected-list reader', () => expect(isReleasablePromiseWork({ ...base, isProtected: undefined }, 's')).toBe(false));
});

describe('makeLateEpochStore', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'late-epoch-'));

  it('reads null before the first live pass', () => {
    expect(makeLateEpochStore(dir()).read()).toBeNull();
  });
  it('writeOnce persists, and a second write keeps the first value', () => {
    const d = dir();
    const s = makeLateEpochStore(d);
    expect(s.writeOnce(1000)).toBe(1000);
    expect(s.writeOnce(5000)).toBe(1000);
    expect(makeLateEpochStore(d).read()).toBe(1000);
    expect(fs.existsSync(path.join(d, 'state', LATE_EPOCH_FILE))).toBe(true);
  });
  it('a corrupt file reads as absent', () => {
    const d = dir();
    fs.mkdirSync(path.join(d, 'state'), { recursive: true });
    fs.writeFileSync(path.join(d, 'state', LATE_EPOCH_FILE), 'not json');
    expect(makeLateEpochStore(d).read()).toBeNull();
  });
});
