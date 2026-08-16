import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('SKIPS a worktree whose owner is alive (in use) even if dirty', async () => {
    const wt = WT();
    s.inUse.add(wt.path);
    s.dirty.add(wt.path);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(await sentinel.evaluate(wt)).toMatchObject({ verdict: 'skip', reason: 'owner-alive' });
  });

  it('SKIPS a clean worktree (no work stranded) when the owner is dead', async () => {
    const wt = WT();
    // not in use, not dirty
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(await sentinel.evaluate(wt)).toMatchObject({ verdict: 'skip', reason: 'clean' });
  });

  it('SKIPS dirty + owner-dead work that is still ACTIVELY being written (not settled)', async () => {
    const wt = WT();
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 500); // 500ms ago, settleMs is 1000
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(await sentinel.evaluate(wt)).toMatchObject({ verdict: 'skip', reason: 'active-recently' });
  });

  it('flags ORPHANED when dirty + owner-dead + settled long enough', async () => {
    const wt = WT();
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 2000); // 2s ago, beyond settleMs 1000
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(await sentinel.evaluate(wt)).toMatchObject({
      verdict: 'orphaned',
      reason: 'uncommitted-owner-dead-settled',
    });
  });

  it('flags ORPHANED when activity time is unknown (null) — cannot prove it is active', async () => {
    const wt = WT();
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, null);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000 });
    expect(await sentinel.evaluate(wt)).toMatchObject({ verdict: 'orphaned' });
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

  it('snapshot() classifies without taking action (read-only)', async () => {
    const wt = WT();
    s.worktrees = [wt];
    s.dirty.add(wt.path);
    s.lastActivity.set(wt.path, s.now - 100_000);
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { settleMs: 1000, enabled: true });
    const snap = await sentinel.snapshot();
    expect(snap.orphanedCount).toBe(1);
    expect(snap.evaluations[0].verdict).toBe('orphaned');
    // No side effects from a snapshot.
    expect(s.recorded).toHaveLength(0);
    expect(s.attention).toHaveLength(0);
  });
});

/**
 * OPPOSITE POLARITY — the round-2 regression this suite exists to pin.
 *
 * `isInUse` is shared with the reaper, and the two consumers read it in opposite
 * directions: for the reaper `true` means KEEP (safe); here it means SKIP — "do not flag
 * this as abandoned". Collapsing an undeterminable process scan to `true` is therefore
 * correct for a deleter and actively wrong for this detector: it skips EVERY worktree
 * whenever the scan fails, and reports `owner-alive`, asserting a live owner it never
 * observed. The route then renders `orphanedCount: 0` — "nothing stranded" — on the
 * surface whose entire job is not losing stranded work.
 */
describe('OrphanedWorkSentinel — undeterminable liveness must not read as "owner alive"', () => {
  const wt = { path: '/wt/a', branch: 'feat/a', headSha: 'sha1' };
  const deps = (isInUse: () => boolean | 'unknown') => ({
    listWorktrees: () => [wt],
    hasUncommittedWork: () => true,
    isInUse,
    workSignature: () => 'sig',
    lastActivityMs: () => 0,
    preserve: () => null,
    recordEvent: () => {},
    raiseAttention: () => {},
    now: () => 10_000_000,
  });

  it("an 'unknown' scan yields owner-liveness-unknown, NOT owner-alive", async () => {
    const s = new OrphanedWorkSentinel(deps(() => 'unknown') as never, { enabled: false });
    const snap = await s.snapshot();
    expect(snap.evaluations[0]?.reason).toBe('owner-liveness-unknown');
    expect(snap.evaluations[0]?.reason).not.toBe('owner-alive');
  });

  it("counts an undeterminable worktree so 0 orphaned can't read as 'nothing stranded'", async () => {
    const s = new OrphanedWorkSentinel(deps(() => 'unknown') as never, { enabled: false });
    const snap = await s.snapshot();
    expect(snap.orphanedCount).toBe(0);
    expect(snap.undeterminedCount).toBe(1); // the distinguishing signal
  });

  it('CONTROL: a genuinely live owner still reads owner-alive', async () => {
    const s = new OrphanedWorkSentinel(deps(() => true) as never, { enabled: false });
    const snap = await s.snapshot();
    expect(snap.evaluations[0]?.reason).toBe('owner-alive');
    expect(snap.undeterminedCount).toBe(0);
  });
});

/**
 * Tier 1 — ROUND FOUR: a non-settling signal must not wedge this sentinel either.
 *
 * WHY THIS EXISTS. Round three added wall-clock ceilings to the reaper because
 * `running` and `pendingSnapshot` clear in `finally` blocks, and a `finally` never
 * runs on a promise that never settles. This sentinel has the IDENTICAL structure
 * over the IDENTICAL injectable deps and got neither ceiling — all five round-four
 * reviewers found it independently, and the spec's parity table (seven rows) had no
 * row for the ceiling, so the one dimension where parity failed was the one the
 * table did not mention.
 *
 * The consequence is worse here than on the reaper: `snapshot()` never rejected, so
 * the route's last-resort catch never fired — the request would hang with NO
 * response and every later caller would join the same dead promise, while `running`
 * stayed true and the background scan stopped permanently. A detector whose only
 * job is not losing stranded work, silently finding nothing.
 *
 * DISCRIMINATING: remove either ceiling and these hang until the vitest timeout.
 */
describe('OrphanedWorkSentinel — a non-settling signal cannot wedge a pass', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const neverSettles = <T>(): Promise<T> => new Promise<T>(() => { /* deliberately never */ });

  const wedgedDeps = (): OrphanedWorkSentinelDeps => {
    const s = freshState();
    s.worktrees = [WT()];
    return { ...makeDeps(s), listWorktrees: () => neverSettles<OrphanedWorktreeInfo[]>() };
  };

  it('scan() SETTLES and clears `running`, so the background scan is not stopped forever', async () => {
    const sentinel = new OrphanedWorkSentinel(wedgedDeps(), { enabled: true });
    const first = sentinel.scan();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    const r1 = await first;
    expect(r1.flagged).toEqual([]);          // an honest empty pass, not a fabricated result
    // The load-bearing half: a LATER pass is not locked out by a stuck `running`.
    const second = sentinel.scan();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await second;
    expect(true).toBe(true);
  }, 20_000);

  it('snapshot() SETTLES and clears the in-flight marker, so the route cannot hang forever', async () => {
    const sentinel = new OrphanedWorkSentinel(wedgedDeps(), { enabled: false });
    const first = sentinel.snapshot();
    const firstRejects = expect(first).rejects.toThrow(/wall-clock bound/);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await firstRejects;

    const second = sentinel.snapshot();
    const secondRejects = expect(second).rejects.toThrow(/wall-clock bound/);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await secondRejects;
    expect(first).not.toBe(second);          // a FRESH pass, not the abandoned one
  }, 20_000);

  it('CONTROL: a normally-settling scan is untouched by the ceiling', async () => {
    const s = freshState();
    s.worktrees = [WT()];
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { enabled: true });
    const r = await sentinel.scan();
    expect(r.evaluations.length).toBe(1);
  });
});

/**
 * Tier 1 — ROUND SIX: passes cannot ACCUMULATE on the sentinel either.
 *
 * WHY THIS EXISTS. Round five gave the reaper's `reap()` two clocks — caller freed
 * at the ceiling, marker held until the work SETTLES — and left `snapshot()` and
 * this sentinel on the single clock. That was the FOURTH time in this change a
 * protection landed on the reaper's reap path and not its siblings, and it made the
 * spec's own cancellation claim ("abandoned-client cost is capped at ONE pass")
 * false: each ceiling expiry released the marker while the abandoned pass was still
 * running, so a persistent wedge accumulated live passes without bound. The external
 * reviewer found the contradiction between two of the author's own paragraphs.
 *
 * DISCRIMINATING: release the marker on the caller path and these fail — a second
 * pass starts while the first is still alive.
 */
describe('OrphanedWorkSentinel — abandoned passes cannot accumulate', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('scan(): a second pass during an abandoned one short-circuits instead of starting', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<OrphanedWorktreeInfo[]>((res) => { release = () => res([WT()]); });
    const s = freshState();
    s.worktrees = [WT()];
    let call = 0;
    const deps = { ...makeDeps(s), listWorktrees: () => (call++ === 0 ? gate : [WT()]) };
    const sentinel = new OrphanedWorkSentinel(deps, { enabled: true });

    const first = sentinel.scan();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    expect((await first).flagged).toEqual([]);

    // The abandoned pass is still alive: a second scan must NOT start one.
    const second = await sentinel.scan();
    expect(second.evaluations).toEqual([]);

    // Once the work settles the marker frees and scanning resumes normally.
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect((await sentinel.scan()).evaluations.length).toBe(1);
  }, 20_000);

  it('CONTROL: back-to-back healthy scans are unaffected', async () => {
    const s = freshState();
    s.worktrees = [WT()];
    const sentinel = new OrphanedWorkSentinel(makeDeps(s), { enabled: true });
    expect((await sentinel.scan()).evaluations.length).toBe(1);
    expect((await sentinel.scan()).evaluations.length).toBe(1);
  });
});
