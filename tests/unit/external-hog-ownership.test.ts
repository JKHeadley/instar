import { describe, it, expect } from 'vitest';
import { isInstarOwned, type ProcNode, type ProcTree, type OwnedRefs } from '../../src/monitoring/ExternalHogOwnership.js';

/**
 * ExternalHogOwnership — the instar-own exclusion ancestry walk (CMT-1901, §1). Excludes a
 * candidate whose ancestry reaches a start-time-verified instar-owned pid (tmux pane OR
 * own-root). INCLUDE-on-uncertainty (anti-evasion). Pure over a snapshot.
 */

function tree(...nodes: ProcNode[]): ProcTree {
  return new Map(nodes.map((n) => [n.pid, n]));
}
const owned = (entries: Array<[number, string]>): OwnedRefs => new Map(entries);
const HOPS = 30;

describe('isInstarOwned — excludes descendants of a verified instar-owned pid', () => {
  it('a direct child of an instar-owned (tmux-pane/server) pid is owned', () => {
    // 5000 (server root) → 5001 (vitest worker). 5001's ppid is 5000 which is owned.
    const t = tree(
      { pid: 5000, ppid: 1, startTime: 'A' },
      { pid: 5001, ppid: 5000, startTime: 'B' },
    );
    expect(isInstarOwned(5001, t, owned([[5000, 'A']]), HOPS)).toBe(true);
  });
  it('a deep descendant (grandchild) is owned via the walk', () => {
    const t = tree(
      { pid: 5000, ppid: 1, startTime: 'A' },
      { pid: 5001, ppid: 5000, startTime: 'B' },
      { pid: 5002, ppid: 5001, startTime: 'C' },
    );
    expect(isInstarOwned(5002, t, owned([[5000, 'A']]), HOPS)).toBe(true);
  });
  it('the owned pid ITSELF is owned (candidate == owned)', () => {
    const t = tree({ pid: 5000, ppid: 1, startTime: 'A' });
    expect(isInstarOwned(5000, t, owned([[5000, 'A']]), HOPS)).toBe(true);
  });
});

describe('isInstarOwned — a genuine orphan is NOT owned (killable, subject to the floor)', () => {
  it('a process reparented to launchd (ppid 1) with no instar ancestor is not owned', () => {
    const t = tree({ pid: 8000, ppid: 1, startTime: 'Z' });
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), HOPS)).toBe(false);
  });
  it('a chain that reaches init without an owned pid is not owned', () => {
    const t = tree(
      { pid: 8000, ppid: 8001, startTime: 'Z' },
      { pid: 8001, ppid: 1, startTime: 'Y' },
    );
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), HOPS)).toBe(false);
  });
});

describe('isInstarOwned — start-time defeats pid reuse (no false-exclude)', () => {
  it('a reused pid that equals an owned pid NUMBER but has a different start-time is NOT owned', () => {
    // 5000 is a known instar pid with expected start-time 'A', but the snapshot's pid 5000 has
    // start-time 'REUSED' — a different process reusing the number. Must NOT falsely exclude.
    const t = tree(
      { pid: 5000, ppid: 1, startTime: 'REUSED' },
      { pid: 8000, ppid: 5000, startTime: 'Z' },
    );
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), HOPS)).toBe(false);
  });
  it('a matching start-time DOES exclude (the genuine instar pid)', () => {
    const t = tree(
      { pid: 5000, ppid: 1, startTime: 'A' },
      { pid: 8000, ppid: 5000, startTime: 'Z' },
    );
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), HOPS)).toBe(true);
  });
});

describe('isInstarOwned — INCLUDE-on-uncertainty (anti-evasion) + bounds', () => {
  it('an unresolvable edge (a ppid not in the snapshot) → NOT owned (external hog cannot fake an ancestor)', () => {
    const t = tree({ pid: 8000, ppid: 9999, startTime: 'Z' }); // 9999 absent
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), HOPS)).toBe(false);
  });
  it('a cycle in the tree is cycle-guarded → NOT owned (no infinite loop)', () => {
    const t = tree(
      { pid: 8000, ppid: 8001, startTime: 'Z' },
      { pid: 8001, ppid: 8000, startTime: 'Y' },
    );
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), HOPS)).toBe(false);
  });
  it('the hop bound is respected (a chain longer than maxHops → NOT owned, bounded)', () => {
    // Build a 5-deep chain but allow only 2 hops; the owned root at the end is never reached.
    const t = tree(
      { pid: 1, ppid: 0, startTime: 'root' },
      { pid: 5000, ppid: 1, startTime: 'A' },
      { pid: 8003, ppid: 5000, startTime: 'D' },
      { pid: 8002, ppid: 8003, startTime: 'C' },
      { pid: 8001, ppid: 8002, startTime: 'B' },
      { pid: 8000, ppid: 8001, startTime: 'Z' },
    );
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), 2)).toBe(false); // too few hops
    expect(isInstarOwned(8000, t, owned([[5000, 'A']]), 30)).toBe(true); // enough hops → owned
  });
  it('invalid inputs (non-positive candidate, maxHops <= 0) → NOT owned', () => {
    const t = tree({ pid: 5000, ppid: 1, startTime: 'A' });
    expect(isInstarOwned(0, t, owned([[5000, 'A']]), HOPS)).toBe(false);
    expect(isInstarOwned(5000, t, owned([[5000, 'A']]), 0)).toBe(false);
  });
});
