// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: the unreachable-helper breaker and its growing backoff (docs/specs/local-verify-borrowed-unit-slices.md,
 * F): skipped after 3 bad runs in a row, the wait doubling from 30 min to 8 h, reset on the first good
 * answer, the degradation reported once; and the rebuildable state file (breakers + last 50 runs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { BORROWED_BREAKER, BorrowedHelpersStore, freshBreaker, helperSkipped, noteHelperOutcome } from '../../../src/localVerify/borrowedState.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'borrowedState.test.ts' }); });
const MIN = 60_000;

describe('breaker', () => {
  it('opens after 3 bad runs, doubles its wait from 30 min to an 8 h cap, reports once, and resets on a good answer', () => {
    const b = freshBreaker();
    let t = 0;
    expect(noteHelperOutcome(b, 'bad', t)).toEqual({ opened: false, reportNow: false, recovered: false });
    noteHelperOutcome(b, 'bad', t);
    expect(noteHelperOutcome(b, 'bad', t)).toEqual({ opened: true, reportNow: true, recovered: false });
    expect(b.skipUntil).toBe(30 * MIN);
    expect(helperSkipped(b, 29 * MIN)).toBe(true);
    expect(helperSkipped(b, 30 * MIN)).toBe(false);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      t = b.skipUntil!;
      const r = noteHelperOutcome(b, 'bad', t); // the probe after the wait fails again
      expect(r.reportNow).toBe(false); // reported once, not on every probe
      waits.push(b.skipUntil! - t);
    }
    expect(waits).toEqual([60, 120, 240, 480, 480, 480].map((m) => m * MIN));
    expect(BORROWED_BREAKER.maxWaitMs).toBe(480 * MIN);
    const g = noteHelperOutcome(b, 'good', t);
    expect(g.recovered).toBe(true);
    expect(b).toEqual(freshBreaker());
  });
});

describe('BorrowedHelpersStore', () => {
  it('keeps each helper\'s breaker and last 50 runs, and rebuilds from an unreadable file', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvbstate-')));
    dirs.push(dir);
    const s = new BorrowedHelpersStore(dir);
    for (let i = 0; i < 60; i++) s.addRun('m_laptop', { at: i, counted: true, slicesSent: 1, done: 1, agree: 1, disagree: 0, helperMs: 1, localMs: 1, prepMs: 1, vitestStartMs: 1 });
    noteHelperOutcome(s.get('m_laptop').breaker, 'bad', 0);
    s.save();
    const again = new BorrowedHelpersStore(dir);
    expect(again.get('m_laptop').runs.length).toBe(50);
    expect(again.get('m_laptop').runs[0].at).toBe(10);
    expect(again.get('m_laptop').breaker.consecutiveBad).toBe(1);
    fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'borrowed-helpers.json'), '{not json');
    expect(new BorrowedHelpersStore(dir).get('m_laptop')).toEqual({ breaker: freshBreaker(), runs: [] });
  });
});
