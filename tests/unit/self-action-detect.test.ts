/**
 * self-action-detect.test.ts — the shared self-action detector (Part E1/E6).
 * Emitting-position true positives; comment/prose lines do NOT match; the
 * controller-shape scope predicate; the fail-open on empty diff; and the pure
 * gate-decision helper (selfActionDeclarationVerdict) both precommit call sites
 * exercise.
 */

import { describe, it, expect } from 'vitest';
import {
  SELF_ACTION_EMIT,
  SELF_ACTION_VERB_TOKENS,
  addedDiffIntroducesSelfAction,
  isSelfActionControllerFile,
  selfActionControllerMarkerId,
  selfActionDeclarationVerdict,
} from '../../scripts/lib/self-action-detect.mjs';

describe('SELF_ACTION_EMIT + verb tokens', () => {
  it('matches a call emit and a method emit', () => {
    expect(SELF_ACTION_EMIT.test('this.swap(acct)')).toBe(true);
    expect(SELF_ACTION_EMIT.test('spawnSession(id)')).toBe(true);
    expect(SELF_ACTION_EMIT.test('respawn(id)')).toBe(true);
    expect(SELF_ACTION_EMIT.test('reaper.reap(session)')).toBe(true);
    expect(SELF_ACTION_EMIT.test('notify(topic)')).toBe(true);
  });
  it('does not match a bare noun in prose', () => {
    expect(SELF_ACTION_EMIT.test('we will swap accounts later')).toBe(false);
    expect(SELF_ACTION_EMIT.test('the retry policy')).toBe(false);
  });
  it('exposes a non-empty token set', () => {
    expect(SELF_ACTION_VERB_TOKENS.length).toBeGreaterThan(5);
    expect(SELF_ACTION_VERB_TOKENS).toContain('swap');
    expect(SELF_ACTION_VERB_TOKENS).toContain('kill');
  });
});

describe('addedDiffIntroducesSelfAction', () => {
  it('true when an added line calls a self-action verb', () => {
    expect(addedDiffIntroducesSelfAction('const x = 1;\nthis.swap(target);')).toBe(true);
  });
  it('false for a comment / prose mention only', () => {
    expect(addedDiffIntroducesSelfAction('// this will swap accounts\n * respawn note')).toBe(false);
    expect(addedDiffIntroducesSelfAction('A paragraph about restart and retry policy.')).toBe(false);
  });
  it('false for an import line that only names a symbol', () => {
    expect(addedDiffIntroducesSelfAction("import { swap } from './x';")).toBe(false);
  });
  it('fail-open: empty / blank text → false', () => {
    expect(addedDiffIntroducesSelfAction('')).toBe(false);
    expect(addedDiffIntroducesSelfAction('   \n  ')).toBe(false);
    // @ts-expect-error — non-string tolerated (fail-open)
    expect(addedDiffIntroducesSelfAction(undefined)).toBe(false);
  });
});

describe('isSelfActionControllerFile', () => {
  it('true for a src/ controller-shape filename', () => {
    expect(isSelfActionControllerFile('src/monitoring/FooSentinel.ts')).toBe(true);
    expect(isSelfActionControllerFile('src/core/AccountReaper.ts')).toBe(true);
    expect(isSelfActionControllerFile('src/x/QuotaManager.ts')).toBe(true);
  });
  it('false for a non-controller src/ file', () => {
    expect(isSelfActionControllerFile('src/core/types.ts')).toBe(false);
    expect(isSelfActionControllerFile('src/monitoring/FooSentinel.test.ts')).toBe(false);
  });
  it('false outside src/', () => {
    expect(isSelfActionControllerFile('scripts/FooMonitor.ts')).toBe(false);
  });
  it('true for ANY file carrying the marker', () => {
    expect(isSelfActionControllerFile('src/x/thing.ts', '/* @self-action-controller: my-id */')).toBe(true);
  });
  it('parses the marker id', () => {
    expect(selfActionControllerMarkerId('/* @self-action-controller: swap-monitor */')).toBe('swap-monitor');
    expect(selfActionControllerMarkerId('no marker here')).toBe(null);
  });
});

describe('selfActionDeclarationVerdict (the pre-commit gate decision)', () => {
  const srcDiff = 'this.swap(target);';
  it('not required when no self-action emit (fail-open)', () => {
    const v = selfActionDeclarationVerdict({ addedDiffText: '', inScopeFiles: ['src/x.ts'], classClosure: null });
    expect(v.required).toBe(false);
    expect(v.satisfied).toBe(true);
  });
  it('not required when no src/ file touched (false-positive-safe)', () => {
    const v = selfActionDeclarationVerdict({ addedDiffText: srcDiff, inScopeFiles: ['docs/x.md'], classClosure: null });
    expect(v.required).toBe(false);
  });
  it('required + UNsatisfied when a self-action src/ change carries no declaration', () => {
    const v = selfActionDeclarationVerdict({ addedDiffText: srcDiff, inScopeFiles: ['src/monitoring/X.ts'], classClosure: null });
    expect(v.required).toBe(true);
    expect(v.satisfied).toBe(false);
  });
  it('satisfied by a real guard declaration', () => {
    const v = selfActionDeclarationVerdict({
      addedDiffText: srcDiff,
      inScopeFiles: ['src/monitoring/X.ts'],
      classClosure: { defectClass: 'unbounded-self-action', closure: 'guard' },
    });
    expect(v.satisfied).toBe(true);
  });
  it('satisfied by a gap declaration', () => {
    const v = selfActionDeclarationVerdict({
      addedDiffText: srcDiff,
      inScopeFiles: ['src/monitoring/X.ts'],
      classClosure: { defectClass: 'unbounded-self-action', closure: 'gap', gapItem: 'ACT-1' },
    });
    expect(v.satisfied).toBe(true);
  });
  it('satisfied by an explicit negative declaration (closure n/a + reason)', () => {
    const v = selfActionDeclarationVerdict({
      addedDiffText: srcDiff,
      inScopeFiles: ['src/monitoring/X.ts'],
      classClosure: { defectClass: 'unbounded-self-action', closure: 'n/a', reason: 'one-shot user-driven action' },
    });
    expect(v.satisfied).toBe(true);
  });
  it('NOT satisfied by a negative declaration with no reason', () => {
    const v = selfActionDeclarationVerdict({
      addedDiffText: srcDiff,
      inScopeFiles: ['src/monitoring/X.ts'],
      classClosure: { defectClass: 'unbounded-self-action', closure: 'n/a' },
    });
    expect(v.satisfied).toBe(false);
  });
  it('NOT satisfied by a declaration for a DIFFERENT class', () => {
    const v = selfActionDeclarationVerdict({
      addedDiffText: srcDiff,
      inScopeFiles: ['src/monitoring/X.ts'],
      classClosure: { defectClass: 'injection-credulity', closure: 'guard' },
    });
    expect(v.satisfied).toBe(false);
  });
});
