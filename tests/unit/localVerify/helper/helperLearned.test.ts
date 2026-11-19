// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1: a helper's learned exclude list and its "compared on" record
 * (docs/specs/local-verify-borrowed-slices-count.md, D). Each joining rule on both sides of its
 * boundary: a helper failure needs two comparisons in a row from two verifies; a same-tree digest
 * difference with both sides passing joins at once; a confirmed wrong pass joins at once. A file
 * leaves when a trial agrees. Trials are due on a content change, on a change of the helper's
 * RUNNER VERSION, and otherwise every 10th verify. The compared-on record belongs to one sandbox
 * image and one runner version.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { HelperLearnedStore, type ObserveCtx } from '../../../../src/localVerify/helper/learnedList.js';
import { HelperComparedStore, comparedDigest } from '../../../../src/localVerify/helper/comparedFiles.js';
import type { LearnedObservationKind } from '../../../../src/localVerify/helper/helperProtocol.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperLearned.test.ts' }); });
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvlearn-'))); dirs.push(d); return d; };
const F = 'tests/integration/recovery-installer.test.ts';
const G = 'tests/unit/alpha.test.ts';
const TREE = 'a1'.repeat(20);
const ctx = (run: string, o: Partial<ObserveCtx> = {}): ObserveCtx => ({ runMachine: 'm_studio', runAttemptId: run, treeHash: TREE, runnerVersion: 'hr1:one', blob: 'b1', ...o });
const obs = (kind: LearnedObservationKind, file = F) => ({ file, kind });

describe('HelperLearnedStore — joining', () => {
  it('the helper failing where the run machine passed joins only on the second comparison in a row, from another verify', () => {
    const s = new HelperLearnedStore(tmp());
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r1'))).toBe('candidate');
    // The same verify reporting it again is still one comparison.
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r1'))).toBe('candidate');
    expect(s.files().has(F)).toBe(false);
    expect(s.candidates()).toEqual([F]);
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r2'))).toBe('added');
    expect(s.entries()[0]).toMatchObject({ file: F, runMachine: 'm_studio', reason: 'helper-failed-local-passed', runs: ['r1', 'r2'], treeHash: TREE, runnerVersion: 'hr1:one', blob: 'b1' });
    expect(s.candidates()).toEqual([]);
  });

  it('"in a row": an agreeing comparison between two helper failures starts the count over', () => {
    const s = new HelperLearnedStore(tmp());
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r1'))).toBe('candidate');
    expect(s.observe(obs('agree'), ctx('r2'))).toBe('noop');
    expect(s.candidates()).toEqual([]);
    // fail, agree, fail: not two in a row.
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r3'))).toBe('candidate');
    expect(s.files().has(F)).toBe(false);
    // fail, fail: two in a row.
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r4'))).toBe('added');
  });

  it('a same-tree digest difference with both sides passing joins at once', () => {
    const s = new HelperLearnedStore(tmp());
    expect(s.observe(obs('digest-differs-both-pass'), ctx('r1'))).toBe('added');
    expect(s.entries()[0]).toMatchObject({ reason: 'digest-differs-both-pass', runs: ['r1'] });
  });

  it('a confirmed wrong pass joins at once', () => {
    const s = new HelperLearnedStore(tmp());
    expect(s.observe(obs('confirmed-wrong-pass'), ctx('r1'))).toBe('added');
    expect(s.entries()[0]).toMatchObject({ reason: 'confirmed-wrong-pass', runs: ['r1'] });
    // Another file is untouched by it.
    expect(s.files()).toEqual(new Set([F]));
  });

  it('a helper failure reported by another run machine does not complete a first one (one helper serves one run machine)', () => {
    const s = new HelperLearnedStore(tmp());
    s.observe(obs('helper-failed-local-passed'), ctx('r1', { runMachine: 'm_studio' }));
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r2', { runMachine: 'm_m5' }))).toBe('candidate');
    expect(s.files().has(F)).toBe(false);
  });
});

describe('HelperLearnedStore — leaving and trials', () => {
  it('a listed file leaves when a later trial agrees; a trial that still differs keeps it and moves its trial markers on', () => {
    const s = new HelperLearnedStore(tmp());
    s.observe(obs('confirmed-wrong-pass'), ctx('r0'));
    for (let i = 1; i <= 10; i++) s.noteRun(`run-${i}`);
    expect(s.retrialDue(s.entries()[0], { runnerVersion: 'hr1:one', currentBlob: 'b1' })).toBe(true);
    expect(s.observe(obs('helper-failed-local-passed'), ctx('r11'))).toBe('noop');
    expect(s.files().has(F)).toBe(true);
    expect(s.retrialDue(s.entries()[0], { runnerVersion: 'hr1:one', currentBlob: 'b1' })).toBe(false);
    expect(s.observe(obs('agree'), ctx('r12'))).toBe('removed');
    expect(s.files().size).toBe(0);
  });

  it('a trial is due when the file\'s content changed, and not while it is the same', () => {
    const s = new HelperLearnedStore(tmp());
    s.observe(obs('digest-differs-both-pass'), ctx('r0', { blob: 'b1' }));
    const e = s.entries()[0];
    expect(s.retrialDue(e, { runnerVersion: 'hr1:one', currentBlob: 'b1' })).toBe(false);
    expect(s.retrialDue(e, { runnerVersion: 'hr1:one', currentBlob: 'b2' })).toBe(true);
    // An unknown content hash cannot show a change.
    expect(s.retrialDue(e, { runnerVersion: 'hr1:one', currentBlob: null })).toBe(false);
  });

  it('a trial is due when the helper\'s runner version changed; Instar\'s release number is not part of the rule', () => {
    const s = new HelperLearnedStore(tmp());
    s.observe(obs('digest-differs-both-pass'), ctx('r0', { runnerVersion: 'hr1:one' }));
    const e = s.entries()[0];
    expect(s.retrialDue(e, { runnerVersion: 'hr1:one', currentBlob: 'b1' })).toBe(false);
    expect(s.retrialDue(e, { runnerVersion: 'hr1:two', currentBlob: 'b1' })).toBe(true);
    // After a trial on the new version that still differs, it is no longer due for that version.
    s.observe(obs('helper-failed-local-passed'), ctx('r1', { runnerVersion: 'hr1:two' }));
    expect(s.retrialDue(s.entries()[0], { runnerVersion: 'hr1:two', currentBlob: 'b1' })).toBe(false);
    expect(Object.keys(s.entries()[0])).not.toContain('helperVersion');
  });

  it('otherwise a trial is due on the 10th verify: not on the 9th, and a verify counts once', () => {
    const s = new HelperLearnedStore(tmp());
    s.observe(obs('digest-differs-both-pass'), ctx('r0'));
    for (let i = 1; i <= 9; i++) s.noteRun(`run-${i}`);
    s.noteRun('run-9');
    expect(s.runsSeen()).toBe(9);
    expect(s.retrialDue(s.entries()[0], { runnerVersion: 'hr1:one', currentBlob: 'b1' })).toBe(false);
    s.noteRun('run-10');
    expect(s.retrialDue(s.entries()[0], { runnerVersion: 'hr1:one', currentBlob: 'b1' })).toBe(true);
  });
});

describe('HelperLearnedStore — the file', () => {
  it('persists across restarts and clears on uninstall', () => {
    const dir = tmp();
    const first = new HelperLearnedStore(dir);
    first.observe(obs('confirmed-wrong-pass'), ctx('r1'));
    first.observe(obs('helper-failed-local-passed', G), ctx('r1'));
    const again = new HelperLearnedStore(dir);
    expect(again.files()).toEqual(new Set([F]));
    // The waiting first failure survives the restart too: the second in a row completes it.
    expect(again.observe(obs('helper-failed-local-passed', G), ctx('r2'))).toBe('added');
    again.clear();
    expect(new HelperLearnedStore(dir).files().size).toBe(0);
  });

  it('a file written under the first design\'s rules (version 1) is not read: its entries were added under other rules', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'helper-learned.json'), JSON.stringify({ v: 1, entries: [{ file: F, runMachine: 'm_studio', runs: ['r1'], source: 'dry-run', addedAt: 'x', helperVersion: '1.3.1903', blob: null, lastTrialRun: 0 }], candidates: [], runsSeen: 4, recentRuns: [] }));
    const s = new HelperLearnedStore(dir);
    expect(s.files().size).toBe(0);
    expect(s.runsSeen()).toBe(0);
  });
});

describe('HelperComparedStore — the files a helper has been compared on', () => {
  const KEY = { imageDigest: 'sha256:image-one', settingsHash: 'settings-one', runnerVersion: 'hr1:one' };

  it('records files per lane, counts only new ones, and reports a count and a digest per lane', () => {
    const dir = tmp();
    const s = new HelperComparedStore(dir);
    expect(s.summary(KEY).integration).toEqual({ count: 0, digest: comparedDigest([]) });
    expect(s.note(KEY, 'integration', [F, 'tests/integration/b.test.ts'])).toBe(2);
    expect(s.note(KEY, 'integration', [F])).toBe(0);
    expect(s.note(KEY, 'unit', [G])).toBe(1);
    expect(s.files(KEY, 'integration')).toEqual(['tests/integration/b.test.ts', F].sort());
    expect(s.summary(KEY)).toEqual({
      unit: { count: 1, digest: comparedDigest([G]) },
      integration: { count: 2, digest: comparedDigest([F, 'tests/integration/b.test.ts']) },
      e2e: { count: 0, digest: comparedDigest([]) },
    });
    // The digest is of the set: order does not matter, content does.
    expect(comparedDigest([F, G])).toBe(comparedDigest([G, F]));
    expect(comparedDigest([F])).not.toBe(comparedDigest([G]));
    // It survives a restart.
    expect(new HelperComparedStore(dir).files(KEY, 'unit')).toEqual([G]);
  });

  it('belongs to one image and one runner version: read under another it is empty, and written under another it starts over', () => {
    const dir = tmp();
    const s = new HelperComparedStore(dir);
    s.note(KEY, 'integration', [F]);
    // The same key reads it.
    expect(s.files(KEY, 'integration')).toEqual([F]);
    for (const other of [{ ...KEY, runnerVersion: 'hr1:two' }, { ...KEY, imageDigest: 'sha256:image-two' }, { ...KEY, settingsHash: 'settings-two' }]) {
      expect(s.files(other, 'integration'), JSON.stringify(other)).toEqual([]);
      expect(s.summary(other).integration.count).toBe(0);
    }
    // No image the helper can name: nothing counts as compared.
    expect(s.files(null, 'integration')).toEqual([]);
    // A comparison on the new runner version starts the record over: the old file is new again.
    const next = { ...KEY, runnerVersion: 'hr1:two' };
    expect(s.note(next, 'unit', [G])).toBe(1);
    expect(s.files(next, 'integration')).toEqual([]);
    expect(new HelperComparedStore(dir).files(KEY, 'integration')).toEqual([]);
  });

  it('keeps only test-file paths, and an unreadable or missing file means nothing was compared', () => {
    const dir = tmp();
    const s = new HelperComparedStore(dir);
    expect(s.note(KEY, 'unit', ['../etc/passwd', 'src/x.ts', G])).toBe(1);
    expect(s.files(KEY, 'unit')).toEqual([G]);
    fs.writeFileSync(path.join(dir, 'state', 'local-verify', 'helper-compared.json'), 'not json');
    expect(new HelperComparedStore(dir).files(KEY, 'unit')).toEqual([]);
    s.clear();
    expect(fs.existsSync(path.join(dir, 'state', 'local-verify', 'helper-compared.json'))).toBe(false);
    expect(new HelperComparedStore(dir).summary(KEY).unit.count).toBe(0);
  });
});
