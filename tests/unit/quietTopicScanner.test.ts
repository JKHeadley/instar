import { describe, it, expect } from 'vitest';
import { QuietTopicScanner, QUIET_MIN_IDLE_MS, QUIET_MAX_CHECKS, type RunningTopicSession } from '../../src/core/quietTopicScanner.js';

const NOW = 1_700_000_000_000;
const session = (k: string, idleMs: number | null): RunningTopicSession => ({ sessionKey: k, tmuxSession: `t-${k}`, lastActivityAt: idleMs === null ? null : NOW - idleMs });
const scanner = (list: RunningTopicSession[], state: (t: string) => 'working' | 'idle' | 'indeterminate' = () => 'idle') =>
  new QuietTopicScanner({ runningTopicSessions: () => list, movable: () => true, workState: async (t) => state(t), now: () => NOW });

describe('QuietTopicScanner', () => {
  it('a session idle for the full window is quiet; one just under it is between turns, not quiet', async () => {
    const s = scanner([session('1', QUIET_MIN_IDLE_MS), session('2', QUIET_MIN_IDLE_MS - 1)]);
    expect([...(await s.refresh())]).toEqual(['1']);
  });

  it('only a positive idle counts: working and indeterminate stay out', async () => {
    const s = scanner([session('1', 2 * QUIET_MIN_IDLE_MS), session('2', 2 * QUIET_MIN_IDLE_MS), session('3', 2 * QUIET_MIN_IDLE_MS)],
      (t) => (t === 't-1' ? 'working' : t === 't-2' ? 'indeterminate' : 'idle'));
    expect([...(await s.refresh())]).toEqual(['3']);
  });

  it('unknown activity is not quiet', async () => {
    expect((await scanner([session('1', null)]).refresh()).size).toBe(0);
  });

  it('a thrown work-state read leaves that topic out and keeps the rest', async () => {
    const s = new QuietTopicScanner({
      runningTopicSessions: () => [session('1', 3 * QUIET_MIN_IDLE_MS), session('2', 2 * QUIET_MIN_IDLE_MS)],
      movable: () => true,
      workState: async (t) => { if (t === 't-1') throw new Error('tmux gone'); return 'idle'; },
      now: () => NOW,
    });
    expect([...(await s.refresh())]).toEqual(['2']);
  });

  it('checks the longest-quiet sessions first and caps the reads', async () => {
    const reads: string[] = [];
    const list = Array.from({ length: 8 }, (_, i) => session(String(i), (i + 2) * QUIET_MIN_IDLE_MS));
    const s = new QuietTopicScanner({ runningTopicSessions: () => list, movable: () => true, workState: async (t) => { reads.push(t); return 'idle'; }, now: () => NOW });
    await s.refresh();
    expect(reads).toEqual(['t-7', 't-6', 't-5', 't-4', 't-3']);
    expect(reads.length).toBe(QUIET_MAX_CHECKS);
  });

  it('topics that can never move do not use up the cap, or shed would quietly stall', async () => {
    const list = Array.from({ length: 8 }, (_, i) => session(String(i), (i + 2) * QUIET_MIN_IDLE_MS));
    const s = new QuietTopicScanner({ runningTopicSessions: () => list, movable: (k) => Number(k) < 2, workState: async () => 'idle', now: () => NOW });
    expect([...(await s.refresh())].sort()).toEqual(['0', '1']);
  });

  it('an unreadable listing yields no candidates', async () => {
    const s = new QuietTopicScanner({ runningTopicSessions: () => { throw new Error('no'); }, movable: () => true, workState: async () => 'idle', now: () => NOW });
    expect((await s.refresh()).size).toBe(0);
  });
});
