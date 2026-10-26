/**
 * Tier-1 tests for the main-red hold decisions (src/localVerify/mainRedHold.ts, CMT-1033):
 * what counts as a repair candidate, when the hold is active, and the plain hold text.
 * Modelled on the 2026-10-26 incident: main red on tests/unit/no-silent-fallbacks.test.ts,
 * the two real repairs touched src/ files and named the check in their text.
 */

import { describe, expect, it } from 'vitest';
import {
  MAIN_RED_HOLD_LIMITS, decideMainRedHold, failingFileNames, holdReasonText, mainFailureFromRunDetail, prMatchText, repairVerdict,
} from '../../../src/localVerify/mainRedHold.js';

const RED = 'e'.repeat(40);
const FILE = 'tests/unit/no-silent-fallbacks.test.ts';
const failure = (files: string[] = [FILE], headSha = RED) => ({ headSha, files, reasons: [`file-failed:${FILE}:1`], messages: {}, recordedAt: '2026-10-26T14:10:44.738Z' });

describe('mainFailureFromRunDetail — the bounded detail kept for the hold', () => {
  it('keeps unique failing files, the first message line clipped, and the bounded reasons', () => {
    const d = mainFailureFromRunDetail(RED, {
      reasons: ['lane-failed:unit:1', `file-failed:${FILE}:1`],
      failures: [
        { file: FILE, message: 'no new silent fallbacks beyond tracked baseline: AssertionError: expected 495 to be less than or equal to 494\n    at /x/y.ts:1' },
        { file: FILE, message: 'dup' },
        { file: 'tests/unit/other.test.ts' },
      ],
    }, '2026-10-26T14:10:44.738Z');
    expect(d.files).toEqual([FILE, 'tests/unit/other.test.ts']);
    expect(d.messages[FILE]).toBe('no new silent fallbacks beyond tracked baseline: AssertionError: expected 495 to be less than or equal to 494');
    expect(d.reasons).toEqual(['lane-failed:unit:1', `file-failed:${FILE}:1`]);
    expect(d.headSha).toBe(RED);
  });

  it('caps files and reasons; a run with no failures keeps no files (⇒ no hold)', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ file: `tests/unit/f${i}.test.ts` }));
    const d = mainFailureFromRunDetail(RED, { reasons: Array.from({ length: 60 }, (_, i) => `r${i}`), failures: many }, 'now');
    expect(d.files).toHaveLength(MAIN_RED_HOLD_LIMITS.maxFiles);
    expect(d.reasons).toHaveLength(MAIN_RED_HOLD_LIMITS.maxReasons);
    expect(mainFailureFromRunDetail(RED, { reasons: ['dirty-tree'] }, 'now').files).toEqual([]);
    expect(mainFailureFromRunDetail(RED, undefined, 'now').files).toEqual([]);
  });
});

describe('failingFileNames — the names a PR may use for a failing file', () => {
  it('path, basename and stem (test suffix stripped); a short stem is not matched on its own', () => {
    expect(failingFileNames(FILE)).toEqual([FILE, 'no-silent-fallbacks.test.ts', 'no-silent-fallbacks']);
    expect(failingFileNames('tests/unit/app.test.ts')).toEqual(['tests/unit/app.test.ts', 'app.test.ts']);
    expect(failingFileNames('src/core/Config.ts')).toEqual(['src/core/config.ts', 'config.ts', 'config']);
  });
});

describe('repairVerdict — is this PR a candidate repair?', () => {
  it('touching the failing file wins; naming it (path, file name, or stem) in title/body counts; otherwise no-overlap', () => {
    expect(repairVerdict({ files: [FILE, 'src/x.ts'], text: '' }, [FILE])).toEqual({ candidate: true, by: 'touches-file', file: FILE });
    // PR 2372 (2026-10-26): touched src/server/routes.ts, title "fix(tests): main red on no-silent-fallbacks after #2367".
    expect(repairVerdict({ files: ['src/server/routes.ts'], text: prMatchText('fix(tests): main red on no-silent-fallbacks after #2367', 'adds a marker') }, [FILE]))
      .toEqual({ candidate: true, by: 'names-file', file: FILE });
    // PR 2373: touched src/core/machineLoadReport.ts, body names the test path.
    expect(repairVerdict({ files: ['src/core/machineLoadReport.ts'], text: prMatchText('fix(ratchet): main is over its own silent-fallback baseline', `\`${FILE}\` counts catch blocks`) }, [FILE]))
      .toEqual({ candidate: true, by: 'names-file', file: FILE });
    // PR 2363: an unrelated feature retirement.
    expect(repairVerdict({ files: ['src/core/Foo.ts', 'docs/specs/x.md'], text: prMatchText('chore(maturation): retire five staged features', 'Closes CMT-1004') }, [FILE]))
      .toEqual({ candidate: false, reason: 'no-overlap' });
  });

  it('an unreadable file list with no mention is files-unknown (held); with a mention it is still a candidate', () => {
    expect(repairVerdict({ files: null, text: 'chore: something else' }, [FILE])).toEqual({ candidate: false, reason: 'files-unknown' });
    expect(repairVerdict({ files: null, text: prMatchText('fix no-silent-fallbacks', null) }, [FILE])).toEqual({ candidate: true, by: 'names-file', file: FILE });
  });

  it('matching is case-insensitive and bounded to the first 8000 characters of title + body', () => {
    expect(repairVerdict({ files: [], text: prMatchText('Fix NO-SILENT-FALLBACKS ratchet', '') }, [FILE]).candidate).toBe(true);
    const late = 'x'.repeat(MAIN_RED_HOLD_LIMITS.textChars) + FILE;
    expect(repairVerdict({ files: [], text: prMatchText('t', late) }, [FILE]).candidate).toBe(false);
  });
});

describe('decideMainRedHold — when the hold is active and who waits', () => {
  const queue = [
    { pr: 2363, files: ['src/core/Foo.ts'], text: 'chore: retire features' },
    { pr: 0, kind: 'main' as const, files: null, text: '' },
    { pr: 2372, files: ['src/server/routes.ts'], text: 'fix(tests): main red on no-silent-fallbacks' },
    { pr: 2375, files: null, text: 'feat: something' },
  ];

  it('is inactive when disabled, healthy, an unknown-state suspect, or the failing files are unknown / for another head', () => {
    expect(decideMainRedHold({ enabled: false, health: { state: 'main-red', redHead: RED }, failure: failure(), queue })).toEqual({ active: false, reason: 'disabled' });
    expect(decideMainRedHold({ enabled: true, health: { state: 'healthy', redHead: null }, failure: failure(), queue })).toEqual({ active: false, reason: 'main-healthy' });
    expect(decideMainRedHold({ enabled: true, health: { state: 'main-suspect', redHead: null }, failure: failure(), queue })).toEqual({ active: false, reason: 'no-red-head' });
    expect(decideMainRedHold({ enabled: true, health: { state: 'main-red', redHead: RED }, failure: null, queue })).toEqual({ active: false, reason: 'failing-files-unknown' });
    expect(decideMainRedHold({ enabled: true, health: { state: 'main-red', redHead: RED }, failure: failure([]), queue })).toEqual({ active: false, reason: 'failing-files-unknown' });
    expect(decideMainRedHold({ enabled: true, health: { state: 'main-red', redHead: RED }, failure: failure([FILE], 'f'.repeat(40)), queue })).toEqual({ active: false, reason: 'failing-files-unknown' });
  });

  it('splits the queue into repair candidates and held PRs (a main entry is never held); suspect-after-failure holds like red', () => {
    for (const state of ['main-suspect', 'main-red'] as const) {
      const d = decideMainRedHold({ enabled: true, health: { state, redHead: RED }, failure: failure(), queue });
      expect(d).toEqual({
        active: true, state, redHead: RED, failingFiles: [FILE],
        repairPrs: [{ pr: 2372, by: 'names-file', file: FILE }],
        heldPrs: [{ pr: 2363, reason: 'no-overlap' }, { pr: 2375, reason: 'files-unknown' }],
      });
    }
  });

  it('holdReasonText names the files, the PR already fixing it (or that none is), and how to run first', () => {
    const d = decideMainRedHold({ enabled: true, health: { state: 'main-red', redHead: RED }, failure: failure(), queue });
    if (!d.active) throw new Error('expected active');
    const text = holdReasonText(d);
    expect(text).toContain(`main is red on ${FILE}`);
    expect(text).toContain('PR #2372 is already fixing it');
    expect(text).toContain('name the failing file in its title or body');
    const none = decideMainRedHold({ enabled: true, health: { state: 'main-suspect', redHead: RED }, failure: failure(), queue: [queue[0]] });
    if (!none.active) throw new Error('expected active');
    expect(holdReasonText(none)).toContain('main is failing (re-run pending)');
    expect(holdReasonText(none)).toContain('no queued PR is fixing it yet');
  });
});
