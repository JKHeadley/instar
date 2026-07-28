import { describe, it, expect, beforeEach } from 'vitest';
import {
  OrphanedWorkSentinel,
  type OrphanedWorkSentinelDeps,
  type OrphanedWorktreeInfo,
  type OrphanedWorkEvent,
} from '../../src/monitoring/OrphanedWorkSentinel.js';

/**
 * Unit coverage for the silent-uncommitted-death backstop. Every gate of the
 * classifier is exercised on BOTH sides (semantic-correctness standard), plus
 * the scan-pass behaviors: dedupe, preserve-gating, record/attention fan-out,
 * and the max-flags bound.
 */

const WT = (over: Partial<OrphanedWorktreeInfo> = {}): OrphanedWorktreeInfo => ({
  path: '/agents/echo/.worktrees/feature-x',
  branch: 'echo/feature-x',
  headSha: 'abc1234',
  ...over,
});

interface FakeState {
  worktrees: OrphanedWorktreeInfo[];
  inUse: Set<string>;
  dirty: Set<string>;
  lastActivity: Map<string, number | null>;
  sig: Map<string, string>;
  preserved: string[];
  recorded: OrphanedWorkEvent[];
  attention: OrphanedWorkEvent[];
  now: number;
}

function makeDeps(s: FakeState): OrphanedWorkSentinelDeps {
  return {
    listWorktrees: () => s.worktrees,
    hasUncommittedWork: (p) => s.dirty.has(p),
    workSignature: (p) => s.sig.get(p) ?? 'sig0',
    isInUse: (p) => s.inUse.has(p),
    lastActivityMs: (p) => (s.lastActivity.has(p) ? s.lastActivity.get(p)! : null),
    preserve: (info) => { s.preserved.push(info.path); },
    record: (e) => { s.recorded.push(e); },
    raiseAttention: (e) => { s.attention.push(e); },
    now: () => s.now,
  };
}

function freshState(): FakeState {
  return {
    worktrees: [],
    inUse: new Set(),
    dirty: new Set(),
    lastActivity: new Map(),
    sig: new Map(),
    preserved: [],
    recorded: [],
    attention: [],
    now: 10_000_000,
  };
}

describe('OrphanedWorkSentinel.evaluate — gate boundaries', () => {
  let s: FakeState;
  beforeEach(() => { s = freshState(); });

  it('SKIPS a worktree whose owner is alive (in use) even if dirty', () => {
    const wt = WT();
    s.inUse.add(wt.path);
    s.dirty.add(wt.path);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(sentinel.evaluate(wt)).toMatchObject({ verdict: 'skip', reason: 'owner-alive' });
  });

  it('SKIPS a clean worktree (no work stranded) when the owner is dead', () => {
    const wt = WT();
    // not in use, not dirty
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(sentinel.evaluate(wt)).toMatchObject({ verdict: 'skip', reason: 'clean' });
  });

  it('SKIPS dirty + owner-dead work that is still ACTIVELY being written (not settled)', () => {
    const wt = WT();
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 500); // 500ms ago, settleMs is 1000
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(sentinel.evaluate(wt)).toMatchObject({ verdict: 'skip', reason: 'active-recently' });
  });

  it('flags ORPHANED when dirty + owner-dead + settled long enough', () => {
    const wt = WT();
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 2000); // 2s ago, beyond settleMs 1000
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(sentinel.evaluate(wt)).toMatchObject({
      verdict: 'orphaned',
      reason: 'uncommitted-owner-dead-settled',
    });
  });

  it('flags ORPHANED when activity time is unknown (null) — cannot prove it is active', () => {
    const wt = WT();
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, null);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(sentinel.evaluate(wt)).toMatchObject({ verdict: 'orphaned' });
  });
});

describe('OrphanedWorkSentinel.scan — side effects', () => {
  let s: FakeState;
  beforeEach(() => { s = freshState(); });

  it('records + raises ONE attention item per orphaned worktree', async () => {
    const wt = WT();
    s.worktrees = [wt];
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 100_000);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    const result = await sentinel.scan();
    expect(result.flagged).toHaveLength(1);
    expect(s.recorded).toHaveLength(1);
    expect(s.attention).toHaveLength(1);
    expect(s.recorded[0]).toMatchObject({ path: wt.path, branch: wt.branch, preserved: false });
  });

  it('does NOT re-flag the same stranded state on a second pass (episode dedupe)', async () => {
    const wt = WT();
    s.worktrees = [wt];
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 100_000);
    s.sig.set(wt.path, 'sigA');
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    await sentinel.scan();
    await sentinel.scan();
    expect(s.attention).toHaveLength(1); // still just one
  });

  it('RE-flags when the work signature changes (new edits stranded)', async () => {
    const wt = WT();
    s.worktrees = [wt];
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 100_000);
    s.sig.set(wt.path, 'sigA');
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    await sentinel.scan();
    s.sig.set(wt.path, 'sigB'); // new stranded state
    await sentinel.scan();
    expect(s.attention).toHaveLength(2);
  });

  it('does NOT preserve by default; preserves only when preserveWork is on', async () => {
    const wt = WT();
    s.worktrees = [wt];
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 100_000);

    const off = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000, preserveWork: false });
    await off.scan();
    expect(s.preserved).toHaveLength(0);

    const s2 = freshState();
    s2.worktrees = [wt];
    s2.dirty.add(wt.path);
    s2.lastActivity.set(wt.path, s2.now - 100_000);
    const on = new OrphanedWorkSentinel(makeDeps(s2), { settleMs: 1000, preserveWork: true });
    const r = await on.scan();
    expect(s2.preserved).toEqual([wt.path]);
    expect(r.flagged[0].preserved).toBe(true);
  });

  it('honors maxFlagsPerPass (bounded blast radius)', async () => {
    for (let i = 0; i < 5; i++) {
      const p = `/agents/echo/.worktrees/wt-${i}`;
      s.worktrees.push(WT({ path: p, branch: `b-${i}` }));
      s.dirty.add(p);
      s.lastActivity.set(p, s.now - 100_000);
      s.sig.set(p, `sig-${i}`);
    }
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000, maxFlagsPerPass: 2 });
    const r = await sentinel.scan();
    expect(r.flagged).toHaveLength(2);
  });

  it('snapshot() classifies without taking action (read-only)', () => {
    const wt = WT();
    s.worktrees = [wt];
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 100_000);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000, enabled: true });
    const snap = sentinel.snapshot();
    expect(snap.orphanedCount).toBe(1);
    expect(snap.evaluations[0].verdict).toBe('orphaned');
    // No side effects from a snapshot.
    expect(s.recorded).toHaveLength(0);
    expect(s.attention).toHaveLength(0);
  });
});
