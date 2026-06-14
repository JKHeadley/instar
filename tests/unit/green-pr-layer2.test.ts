/**
 * Tier-1 tests for the Layer-2 stop-gate helpers (green-pr-automerge §3.3).
 * computeGreenPrBlock: match/no-match, staleness, killSwitch/compaction suppression,
 * the three variants (mergeable / protected-paths / disarmed), and the round-6
 * invariant that NO variant contains a runnable merge command.
 * resolveBranchFromCwd: normal repo + linked-worktree gitdir file + fail-open.
 */

import { describe, it, expect } from 'vitest';
import { computeGreenPrBlock, resolveBranchFromCwd, type GreenPrSnapshotForBlock } from '../../src/server/stopGate.js';

const snap = (over: Partial<GreenPrSnapshotForBlock> = {}): GreenPrSnapshotForBlock => ({
  at: 1_000_000,
  entries: [{ pr: 42, headRefName: 'echo/feature', kind: 'mergeable' }],
  ...over,
});
const base = { tickIntervalMs: 600_000, now: 1_000_500, killSwitch: false, compactionInFlight: false, armed: true };

describe('computeGreenPrBlock', () => {
  it('blocks once when the branch matches a fresh armed mergeable candidate', () => {
    const b = computeGreenPrBlock({ ...base, snapshot: snap(), sessionBranch: 'echo/feature' });
    expect(b?.pr).toBe(42);
    expect(b?.variant).toBe('mergeable');
  });

  it('is silent when the branch does not match', () => {
    expect(computeGreenPrBlock({ ...base, snapshot: snap(), sessionBranch: 'echo/other' })).toBeNull();
  });

  it('is silent on a stale snapshot (> 2× tick)', () => {
    expect(computeGreenPrBlock({ ...base, now: 1_000_000 + 2 * 600_000 + 1, snapshot: snap(), sessionBranch: 'echo/feature' })).toBeNull();
  });

  it('is suppressed under killSwitch and under compaction', () => {
    expect(computeGreenPrBlock({ ...base, killSwitch: true, snapshot: snap(), sessionBranch: 'echo/feature' })).toBeNull();
    expect(computeGreenPrBlock({ ...base, compactionInFlight: true, snapshot: snap(), sessionBranch: 'echo/feature' })).toBeNull();
  });

  it('emits the do-not-merge (disarmed) variant when the watcher is not armed', () => {
    const b = computeGreenPrBlock({ ...base, armed: false, snapshot: snap(), sessionBranch: 'echo/feature' });
    expect(b?.variant).toBe('disarmed');
    expect(b?.message).toMatch(/do NOT merge/i);
  });

  it('routes a protected-paths candidate to the operator', () => {
    const b = computeGreenPrBlock({ ...base, snapshot: snap({ entries: [{ pr: 7, headRefName: 'echo/wf', kind: 'protected-paths' }] }), sessionBranch: 'echo/wf' });
    expect(b?.variant).toBe('protected-paths');
    expect(b?.message).toMatch(/operator/i);
  });

  it('NO variant contains a runnable safe-merge command (round-6)', () => {
    const variants = [
      computeGreenPrBlock({ ...base, snapshot: snap(), sessionBranch: 'echo/feature' }),
      computeGreenPrBlock({ ...base, armed: false, snapshot: snap(), sessionBranch: 'echo/feature' }),
      computeGreenPrBlock({ ...base, snapshot: snap({ entries: [{ pr: 7, headRefName: 'echo/wf', kind: 'protected-paths' }] }), sessionBranch: 'echo/wf' }),
    ];
    for (const v of variants) {
      expect(v).not.toBeNull();
      expect(v!.message).not.toMatch(/safe-merge/);
      expect(v!.message).not.toMatch(/--admin/);
    }
  });
});

describe('resolveBranchFromCwd', () => {
  const fsMap = (m: Record<string, string>) => ({
    read: (p: string) => { if (!(p in m)) throw new Error('ENOENT'); return m[p]; },
    exists: (p: string) => p in m,
  });

  it('reads a branch from a normal repo .git/HEAD', () => {
    const { read, exists } = fsMap({ '/repo/.git': 'dir', '/repo/.git/HEAD': 'ref: refs/heads/echo/feature\n' });
    // .git is a dir here; the helper reads .git content which is not a gitdir → falls to .git/HEAD
    expect(resolveBranchFromCwd('/repo', read, exists)).toBe('echo/feature');
  });

  it('follows a linked-worktree gitdir file to its HEAD', () => {
    const { read, exists } = fsMap({
      '/wt/.git': 'gitdir: /home/.worktrees/x/.git\n',
      '/home/.worktrees/x/.git/HEAD': 'ref: refs/heads/echo/wt-branch\n',
    });
    expect(resolveBranchFromCwd('/wt', read, exists)).toBe('echo/wt-branch');
  });

  it('fail-open returns null when .git is absent', () => {
    const { read, exists } = fsMap({});
    expect(resolveBranchFromCwd('/nope', read, exists)).toBeNull();
  });

  it('returns null for a detached HEAD (no ref line)', () => {
    const { read, exists } = fsMap({ '/repo/.git': 'dir', '/repo/.git/HEAD': 'abc123def\n' });
    expect(resolveBranchFromCwd('/repo', read, exists)).toBeNull();
  });
});
