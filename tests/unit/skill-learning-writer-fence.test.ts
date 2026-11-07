/**
 * WriterFence — Tier 1 (Testing Integrity Standard).
 *
 * Spec: docs/specs/skill-learning-sentinel.md "Multi-machine posture → Single writer", §3.5 step 2;
 * integration map deviations (u)/(v). Every branch of the fence: no coordinator (sole writer),
 * not-holder, local media (LocalLeaseStore / no repo / no remote), unknown remote treated as present,
 * pull ok / failed / no manager, stale epoch, lease moved during the pull, the 24 h unreachable
 * counter and the 3-in-a-row degradation row (exactly one per streak).
 */
import { describe, it, expect, vi } from 'vitest';
import { WriterFence, UNREACHABLE_STREAK_FOR_DEGRADATION, type WriterFenceDeps } from '../../src/monitoring/skillLearning/WriterFence.js';

function makeDeps(over: Partial<WriterFenceDeps> = {}): WriterFenceDeps & { degradation: { report: ReturnType<typeof vi.fn> } } {
  return {
    hasCoordinator: () => true,
    holdsLease: () => true,
    currentEpoch: () => 7,
    leaseMediumLocal: () => false,
    pullRebase: () => true,
    hasRemote: () => true,
    isGitRepo: () => true,
    degradation: { report: vi.fn() },
    ...over,
  } as WriterFenceDeps & { degradation: { report: ReturnType<typeof vi.fn> } };
}

describe('WriterFence', () => {
  it('no coordinator (non-mesh agent) → sole writer: ok, epoch 0, fence local, nothing pulled', () => {
    const pull = vi.fn(() => true);
    const f = new WriterFence(makeDeps({ hasCoordinator: () => false, pullRebase: pull }));
    expect(f.acquireFence()).toEqual({ ok: true, epoch: 0, fence: 'local' });
    expect(f.peekEpoch()).toBe(0);
    expect(f.medium()).toBe('local');
    expect(pull).not.toHaveBeenCalled();
  });

  it('a coordinator that says we do not hold the lease → not-holder, before any pull', () => {
    const pull = vi.fn(() => true);
    const f = new WriterFence(makeDeps({ holdsLease: () => false, pullRebase: pull }));
    const r = f.acquireFence();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-holder');
    expect(pull).not.toHaveBeenCalled();
  });

  it('LocalLeaseStore selected → fence local with the locally read epoch, no pull', () => {
    const pull = vi.fn(() => true);
    const f = new WriterFence(makeDeps({ leaseMediumLocal: () => true, pullRebase: pull }));
    expect(f.acquireFence()).toEqual({ ok: true, epoch: 7, fence: 'local' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('not a git repo → fence local, no pull', () => {
    const pull = vi.fn(() => true);
    const f = new WriterFence(makeDeps({ isGitRepo: () => false, pullRebase: pull }));
    expect(f.acquireFence()).toEqual({ ok: true, epoch: 7, fence: 'local' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('a provably empty remote list (hasRemote false) → fence local, no pull', () => {
    const pull = vi.fn(() => true);
    const f = new WriterFence(makeDeps({ hasRemote: () => false, pullRebase: pull }));
    expect(f.acquireFence()).toEqual({ ok: true, epoch: 7, fence: 'local' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('an UNKNOWN remote (hasRemote null) is treated as present: the pull runs and the fence is git', () => {
    const pull = vi.fn(() => true);
    const f = new WriterFence(makeDeps({ hasRemote: () => null, pullRebase: pull }));
    expect(f.medium()).toBe('git');
    expect(f.acquireFence()).toEqual({ ok: true, epoch: 7, fence: 'git' });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('git with a remote: pull ok → epoch re-read AFTER the pull, fence git', () => {
    let epoch = 7;
    const pull = vi.fn(() => { epoch = 8; return true; });
    const f = new WriterFence(makeDeps({ currentEpoch: () => epoch, pullRebase: pull }));
    expect(f.peekEpoch()).toBe(7);
    expect(f.acquireFence()).toEqual({ ok: true, epoch: 8, fence: 'git' });
  });

  it('a stale epoch (prepared at N, store reads N+1 after the pull) → aborted', () => {
    let epoch = 7;
    const f = new WriterFence(makeDeps({ currentEpoch: () => epoch, pullRebase: () => { epoch = 8; return true; } }));
    const r = f.acquireFence({ expectedEpoch: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('aborted');
    // The same expectedEpoch matching the post-pull read is fine.
    expect(f.acquireFence({ expectedEpoch: 8 })).toEqual({ ok: true, epoch: 8, fence: 'git' });
  });

  it('the lease moved during the pull → not-holder', () => {
    let holds = true;
    const f = new WriterFence(makeDeps({ holdsLease: () => holds, pullRebase: () => { holds = false; return true; } }));
    const r = f.acquireFence();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-holder');
  });

  it('pull failed → aborted-unreachable, counted in the 24 h window; 3 in a row → exactly ONE degradation per streak', () => {
    let t = 1_000_000;
    const deps = makeDeps({ pullRebase: () => false, now: () => t });
    const f = new WriterFence(deps);
    for (let i = 1; i <= UNREACHABLE_STREAK_FOR_DEGRADATION + 1; i++) {
      const r = f.acquireFence();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('aborted-unreachable');
      expect(f.abortedUnreachable24h()).toBe(i);
      expect(f.consecutiveUnreachable()).toBe(i);
      expect(deps.degradation.report).toHaveBeenCalledTimes(i >= UNREACHABLE_STREAK_FOR_DEGRADATION ? 1 : 0);
    }
    expect(deps.degradation.report.mock.calls[0][0]).toMatchObject({ feature: 'monitoring.skillLearning.writerFence' });
    // Two unreachables, a success, then two more: no new row (the streak reset).
    deps.pullRebase = () => true;
    expect(f.acquireFence().ok).toBe(true);
    expect(f.consecutiveUnreachable()).toBe(0);
    deps.pullRebase = () => false;
    f.acquireFence(); f.acquireFence();
    expect(deps.degradation.report).toHaveBeenCalledTimes(1);
    f.acquireFence();
    expect(deps.degradation.report).toHaveBeenCalledTimes(2); // a NEW streak of 3 → a second row
    // The 24 h window forgets old aborts.
    t += 25 * 60 * 60 * 1000;
    expect(f.abortedUnreachable24h()).toBe(0);
  });

  it('no git-sync manager on a git-with-remote machine (pullRebase null) → aborted-unreachable (nothing can pull)', () => {
    const f = new WriterFence(makeDeps({ pullRebase: () => null }));
    const r = f.acquireFence();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('aborted-unreachable');
    expect(f.abortedUnreachable24h()).toBe(1);
  });

  it('a throwing probe reads as the conservative side (holdsLease throws → not-holder; hasRemote throws → unknown → git medium)', () => {
    const f1 = new WriterFence(makeDeps({ holdsLease: () => { throw new Error('store unreadable'); } }));
    const r1 = f1.acquireFence();
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('not-holder');
    const f2 = new WriterFence(makeDeps({ hasRemote: () => { throw new Error('git unreadable'); } }));
    expect(f2.medium()).toBe('git');
  });
});
