/**
 * Tier-1 tests for the main-red hold decisions (src/localVerify/mainRedHold.ts, CMT-1033):
 * what counts as a repair candidate, when the hold is active, and the plain hold text.
 * Modelled on the 2026-10-26 incident: main red on tests/unit/no-silent-fallbacks.test.ts,
 * the two real repairs touched src/ files and named the check in their text.
 */

import { describe, expect, it } from 'vitest';
import {
  MAIN_RED_HOLD_LIMITS, decideMainRedHold, failingFileNames, holdReasonText, isRevertText, lintScriptFromReason, mainFailureFromRunDetail, prMatchText, repairVerdict,
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

describe('a failing lint step holds like a failing file (2026-11-15: main failed lint-framework-name-ratchet, 21 doomed PR runs)', () => {
  const LINT = 'scripts/lint-framework-name-ratchet.mjs';
  const REASON = `lint-failed:node ${LINT}`;

  it('lintScriptFromReason reads the repo script, with or without arguments; every other shape is null', () => {
    expect(lintScriptFromReason(REASON)).toBe(LINT);
    expect(lintScriptFromReason('lint-failed:node scripts/lint-deferral-carrier-resolvable.mjs --staged --enforce')).toBe('scripts/lint-deferral-carrier-resolvable.mjs');
    expect(lintScriptFromReason('lint-failed:node scripts/lint-state-registry.js')).toBe('scripts/lint-state-registry.js');
    for (const other of [
      'lint-failed:node node_modules/typescript-native/bin/tsc --noEmit', // the type check names no repo script
      'lint-failed:node scripts/../outside.mjs',
      'lint-failed:node scripts/lint-a-name-cut-off-by-the-80-character-limit-of-the-reason-te',
      'build-failed:node scripts/build.mjs',
      'lint-failed:sh -c node scripts/x.mjs',
      'file-failed:tests/unit/x.test.ts:1',
      '', null, 7,
    ]) expect(lintScriptFromReason(other)).toBeNull();
  });

  it('mainFailureFromRunDetail adds the script after the failing test files, once, under the cap', () => {
    const d = mainFailureFromRunDetail(RED, { reasons: [REASON, REASON], failures: [] }, 'now');
    expect(d.files).toEqual([LINT]);
    expect(d.messages[LINT]).toBe(`the lint step ${LINT} failed`);
    const both = mainFailureFromRunDetail(RED, { reasons: [`file-failed:${FILE}:1`, REASON], failures: [{ file: FILE }] }, 'now');
    expect(both.files).toEqual([FILE, LINT]);
    const full = mainFailureFromRunDetail(RED, { reasons: [REASON], failures: Array.from({ length: 50 }, (_, i) => ({ file: `tests/unit/f${i}.test.ts` })) }, 'now');
    expect(full.files).toHaveLength(MAIN_RED_HOLD_LIMITS.maxFiles);
    expect(full.files).not.toContain(LINT);
    expect(mainFailureFromRunDetail(RED, { reasons: ['lint-failed:node node_modules/typescript-native/bin/tsc --noEmit'] }, 'now').files).toEqual([]);
  });

  it('the incident: the repair that names the script runs; changes that neither touch nor name it are held', () => {
    const f = mainFailureFromRunDetail(RED, { reasons: [REASON], failures: [] }, '2026-11-15T00:55:45.289Z');
    const repair = { pr: 3182, files: ['src/core/EnrollmentWizard.ts'], text: prMatchText('fix(enrollment): name the Claude engine once so main passes the framework-id ratchet', 'Main fails `node scripts/lint-framework-name-ratchet.mjs` (1135 -> 1136)') };
    const touches = { pr: 3072, files: [LINT, 'src/core/frameworkFacts.ts'], text: prMatchText('feat: h3 builder', '') };
    const byStem = { pr: 3103, files: ['src/server/routes.ts'], text: prMatchText('fix: baseline split for lint-framework-name-ratchet', '') };
    const unrelated = { pr: 3135, files: ['src/core/FeedbackExecutor.ts'], text: prMatchText('fix(feedback): executor PRs survive restarts', '') };
    const unknown = { pr: 3161, files: null, text: prMatchText('feat(conversations): pin whole conversations', '') };
    const d = decideMainRedHold({ enabled: true, health: { state: 'main-red', redHead: RED }, failure: f, queue: [repair, touches, byStem, unrelated, unknown] });
    expect(d).toMatchObject({ active: true, failingFiles: [LINT] });
    if (!d.active) throw new Error('unreachable');
    expect(d.repairPrs).toEqual([
      { pr: 3182, by: 'names-file', file: LINT },
      { pr: 3072, by: 'touches-file', file: LINT },
      { pr: 3103, by: 'names-file', file: LINT },
    ]);
    expect(d.heldPrs).toEqual([{ pr: 3135, reason: 'no-overlap' }, { pr: 3161, reason: 'files-unknown' }]);
    expect(holdReasonText(d)).toContain(LINT);
  });

  it('a lint failure of an unreadable shape still holds nothing (failing-files-unknown), as before', () => {
    const f = mainFailureFromRunDetail(RED, { reasons: ['lint-failed:node node_modules/typescript-native/bin/tsc --noEmit'], failures: [] }, 'now');
    expect(decideMainRedHold({ enabled: true, health: { state: 'main-red', redHead: RED }, failure: f, queue: [] })).toEqual({ active: false, reason: 'failing-files-unknown' });
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

  it('a revert is a candidate: GitHub revert title or "Reverts owner/repo#N" body, even touching and naming no test file', () => {
    // The commonest repair undoes the breaking source change; holding it could keep main red with nothing able to clear it.
    expect(repairVerdict({ files: ['src/core/Foo.ts'], text: prMatchText('Revert "feat: add Foo"', 'Reverts JKHeadley/instar#2367') }, [FILE]))
      .toEqual({ candidate: true, by: 'reverts', file: FILE });
    expect(repairVerdict({ files: ['src/core/Foo.ts'], text: prMatchText('fix: back out Foo', 'Reverts JKHeadley/instar#2367\n\nbroke main') }, [FILE]).candidate).toBe(true);
    expect(repairVerdict({ files: null, text: prMatchText('Revert the Foo change', '') }, [FILE]).candidate).toBe(true);
    // Mentioning a revert elsewhere does not count, and "reverts" in prose is not the GitHub line.
    expect(isRevertText(prMatchText('feat: add undo; can revert later', 'this reverts nothing'))).toBe(false);
    expect(isRevertText(prMatchText('Reverting is hard', ''))).toBe(false);
    expect(repairVerdict({ files: ['src/core/Foo.ts'], text: prMatchText('feat: unrelated', '') }, [FILE])).toEqual({ candidate: false, reason: 'no-overlap' });
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
