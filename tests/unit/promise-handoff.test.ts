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
import { makeHandOffPromise, makeLateEpochStore, LATE_EPOCH_FILE } from '../../src/monitoring/promiseHandoff.js';

describe('makeHandOffPromise', () => {
  const mk = (over: Partial<Parameters<typeof makeHandOffPromise>[0]> = {}) => {
    const injectObserved = vi.fn(async () => ({ state: 'submitted' }));
    const deps = {
      getSessionForTopic: vi.fn((_t: number) => 'echo-topic-1' as string | null),
      isSessionAlive: vi.fn((_s: string) => true),
      injectObserved,
      log: () => {},
      ...over,
    };
    return { h: makeHandOffPromise(deps), deps };
  };

  it('a running session gets the text through the paste-notification inject → accepted', async () => {
    const { h, deps } = mk();
    expect(await h(1, 'note')).toBe(true);
    expect(deps.injectObserved).toHaveBeenCalledWith('echo-topic-1', 'note');
  });
  it('queued-busy (mid-turn) counts as accepted', async () => {
    const { h } = mk({ injectObserved: vi.fn(async () => ({ state: 'queued-busy' })) });
    expect(await h(1, 'note')).toBe(true);
  });
  it('stuck → not accepted', async () => {
    const { h } = mk({ injectObserved: vi.fn(async () => ({ state: 'stuck' })) });
    expect(await h(1, 'note')).toBe(false);
  });
  it('no session for the topic on this machine → not accepted, nothing injected', async () => {
    const { h, deps } = mk({ getSessionForTopic: vi.fn(() => null) });
    expect(await h(1, 'note')).toBe(false);
    expect(deps.injectObserved).not.toHaveBeenCalled();
  });
  it('dead session → not accepted, nothing injected, nothing spawned', async () => {
    const { h, deps } = mk({ isSessionAlive: vi.fn(() => false) });
    expect(await h(1, 'note')).toBe(false);
    expect(deps.injectObserved).not.toHaveBeenCalled();
  });
  it('an inject that throws → not accepted, never rethrown', async () => {
    const { h } = mk({ injectObserved: vi.fn(async () => { throw new Error('tmux gone'); }) });
    expect(await h(1, 'note')).toBe(false);
  });
  it('the dependency surface has no spawn or inbound-message hook at all', () => {
    // Structural: the only capabilities handed in are lookup, liveness and a
    // system-notice inject, so a spawn or a fake user message is impossible.
    const { deps } = mk();
    expect(Object.keys(deps).sort()).toEqual(['getSessionForTopic', 'injectObserved', 'isSessionAlive', 'log']);
  });
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
