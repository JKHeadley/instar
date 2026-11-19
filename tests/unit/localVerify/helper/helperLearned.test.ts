// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: a helper's learned exclude list (docs/specs/local-verify-borrowed-unit-slices.md, D) — in after
 * two paired differences from two runs (one in the dry run), re-trial on version, content or every
 * 10th run, out when a re-trial agrees, the eligible-file cap, the incompatibility line, persistence.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { HelperLearnedStore } from '../../../../src/localVerify/helper/learnedList.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperLearned.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvlearn-'))); dirs.push(d); return d; };
const F = 'tests/unit/a.test.ts';
const ctx = (run: string, o: Partial<{ helperVersion: string; blob: string | null; eligibleCount: number; runMachine: string }> = {}) => ({ runMachine: 'm_studio', runAttemptId: run, helperVersion: 'v1', blob: 'b1', eligibleCount: 100, ...o });

describe('HelperLearnedStore', () => {
  it('a paired difference becomes an entry only on the second run; the same run twice does not count', () => {
    const s = new HelperLearnedStore(tmp());
    expect(s.observe({ file: F, kind: 'differ', source: 'paired' }, ctx('r1'))).toBe('candidate');
    expect(s.observe({ file: F, kind: 'differ', source: 'paired' }, ctx('r1'))).toBe('candidate');
    expect(s.files().has(F)).toBe(false);
    expect(s.observe({ file: F, kind: 'differ', source: 'paired' }, ctx('r2'))).toBe('added');
    expect(s.entries()[0]).toMatchObject({ file: F, runMachine: 'm_studio', runs: ['r1', 'r2'], source: 'paired' });
  });

  it('a dry-run difference adds from one observation, tagged dry-run', () => {
    const s = new HelperLearnedStore(tmp());
    expect(s.observe({ file: F, kind: 'differ', source: 'dry-run' }, ctx('r1'))).toBe('added');
    expect(s.entries()[0].source).toBe('dry-run');
  });

  it('re-trial is due on a version change, a content change, or every 10th run; an agreeing re-trial removes the entry', () => {
    const s = new HelperLearnedStore(tmp());
    s.observe({ file: F, kind: 'differ', source: 'dry-run' }, ctx('r0'));
    const e = s.entries()[0];
    expect(s.retrialDue(e, { helperVersion: 'v1', currentBlob: 'b1' })).toBe(false);
    expect(s.retrialDue(e, { helperVersion: 'v2', currentBlob: 'b1' })).toBe(true);
    expect(s.retrialDue(e, { helperVersion: 'v1', currentBlob: 'b2' })).toBe(true);
    for (let i = 1; i <= 10; i++) s.noteRun(`run-${i}`);
    s.noteRun('run-10'); // a run counts once
    expect(s.runsSeen()).toBe(10);
    expect(s.retrialDue(s.entries()[0], { helperVersion: 'v1', currentBlob: 'b1' })).toBe(true);
    // A re-trial that still differs keeps the entry and moves its trial marker on.
    expect(s.observe({ file: F, kind: 'differ', source: 'paired' }, ctx('r11'))).toBe('noop');
    expect(s.retrialDue(s.entries()[0], { helperVersion: 'v1', currentBlob: 'b1' })).toBe(false);
    expect(s.observe({ file: F, kind: 'agree', source: 'paired' }, ctx('r12'))).toBe('removed');
    expect(s.files().size).toBe(0);
  });

  it('is capped at the eligible-file count, and reports incompatible over a quarter of eligible files', () => {
    const s = new HelperLearnedStore(tmp());
    for (let i = 0; i < 3; i++) s.observe({ file: `tests/unit/f${i}.test.ts`, kind: 'differ', source: 'dry-run' }, ctx('r', { eligibleCount: 3 }));
    expect(s.observe({ file: 'tests/unit/f9.test.ts', kind: 'differ', source: 'dry-run' }, ctx('r', { eligibleCount: 3 }))).toBe('capped');
    expect(s.incompatible(12)).toBe(false);
    expect(s.incompatible(11)).toBe(true);
  });

  it('persists across restarts and clears on uninstall', () => {
    const dir = tmp();
    new HelperLearnedStore(dir).observe({ file: F, kind: 'differ', source: 'dry-run' }, ctx('r1'));
    const again = new HelperLearnedStore(dir);
    expect(again.files().has(F)).toBe(true);
    again.clear();
    expect(new HelperLearnedStore(dir).files().size).toBe(0);
  });
});
