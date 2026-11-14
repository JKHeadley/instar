// safe-git-allow: test builds a local git repo in a tmp dir.
/** The adoption lint on both sides (docs/specs/ecosystem-idea-pipeline.md §8), against a real git repo for ancestry and staleness. */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEvidence, diffChangesDefault, lintSpecs, parseSpecFrontmatter } from '../../../scripts/lint-ecosystem-adoption.mjs';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/ecosystem/adoption-lint.test.ts' }); });

function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-lint-')); dirs.push(d);
  const sh = (...a: string[]) => execFileSync('git', a, { cwd: d, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  sh('init', '-q');
  const commit = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true }); fs.writeFileSync(path.join(d, file), text); sh('add', '.'); sh('commit', '-qm', file); return sh('rev-parse', 'HEAD'); };
  const git = {
    isAncestor: (c: string) => { try { sh('merge-base', '--is-ancestor', c, 'HEAD'); return true; } catch { return false; } },
    isAncestorOf: (a: string, b: string) => { try { sh('merge-base', '--is-ancestor', a, b); return true; } catch { return false; } },
    changedSince: (c: string, paths: string[]) => (paths.length ? sh('diff', '--name-only', c, 'HEAD', '--', ...paths).split('\n').filter(Boolean) : []),
  };
  return { commit, git };
}

const spec = { 'ecosystem-idea': 'idea-1', 'effect-class': 'reduces-capability', 'ecosystem-record-hash': 'h1', 'ecosystem-flags': ['sessions.lean.enabled'], 'ecosystem-paths': ['src/lean.ts'] };
const trial = (planCommit: string, testedCommit: string, over: object = {}) => ({
  idea: 'idea-1', 'record-hash': 'h1', kind: 'trial', result: 'pass', planCommit, testedCommit, rolloutScope: 'fleet', margin: 0.05, marginReviewedBy: 'codex-cli',
  measures: ['rules retained'], blind: true, positiveControl: { caught: true }, attemptBudget: 2, attempts: [{ result: 'pass' }], ...over,
});
const NOW = Date.parse('2026-11-02T00:00:00Z');

describe('checkEvidence', () => {
  it('passes a well-formed trial whose plan precedes its results', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    expect(checkEvidence({ spec, proof: trial(plan, tested), nowMs: NOW, git })).toEqual([]);
  });
  it('refuses no report at all, a failed result, and an unproven one', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    expect(checkEvidence({ spec, proof: null, nowMs: NOW, git })[0]).toMatch(/no docs\/proofs/);
    expect(checkEvidence({ spec, proof: trial(plan, tested, { result: 'fail' }), nowMs: NOW, git }).join()).toMatch(/result is fail/);
    expect(checkEvidence({ spec, proof: trial(plan, tested, { result: 'unproven' }), nowMs: NOW, git }).join()).toMatch(/result is unproven/);
  });
  it('an old passing report is refused against changed code', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    commit('src/lean.ts', 'changed code');
    expect(checkEvidence({ spec, proof: trial(plan, tested), nowMs: NOW, git }).join()).toMatch(/code changed since/);
  });
  it('empty paths cannot pass: nothing would show the evidence still covers the code', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    expect(checkEvidence({ spec: { ...spec, 'ecosystem-paths': [] }, proof: trial(plan, tested), nowMs: NOW, git }).join()).toMatch(/ecosystem-paths is empty/);
  });
  it('a change elsewhere does not stale it', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    commit('src/other.ts', 'x');
    expect(checkEvidence({ spec, proof: trial(plan, tested), nowMs: NOW, git })).toEqual([]);
  });
  it('refuses a plan written after the results', () => {
    const { commit, git } = repo();
    const tested = commit('src/lean.ts', 'code');
    const plan = commit('plan.md', 'plan');
    expect(checkEvidence({ spec, proof: trial(plan, tested), nowMs: NOW, git }).join()).toMatch(/plan commit does not precede/);
  });
  it('refuses a scope narrower than a default change, an unblind trial, and a missed control', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    expect(checkEvidence({ spec, proof: trial(plan, tested, { rolloutScope: 'one-dev-agent' }), nowMs: NOW, git }).join()).toMatch(/rolloutScope/);
    expect(checkEvidence({ spec, proof: trial(plan, tested, { blind: false }), nowMs: NOW, git }).join()).toMatch(/not blind/);
    expect(checkEvidence({ spec, proof: trial(plan, tested, { positiveControl: { caught: false } }), nowMs: NOW, git }).join()).toMatch(/positive control/);
  });
  it('a pass after a failure needs a confirmatory run, and attempts stay inside the budget', () => {
    const { commit, git } = repo();
    const plan = commit('plan.md', 'plan');
    const tested = commit('src/lean.ts', 'code');
    const retried = [{ result: 'fail' }, { result: 'pass' }];
    expect(checkEvidence({ spec, proof: trial(plan, tested, { attempts: retried }), nowMs: NOW, git }).join()).toMatch(/confirmatory/);
    expect(checkEvidence({ spec, proof: trial(plan, tested, { attempts: [{ result: 'fail' }, { result: 'pass', confirmatory: true }] }), nowMs: NOW, git })).toEqual([]);
    expect(checkEvidence({ spec, proof: trial(plan, tested, { attemptBudget: 1, attempts: retried }), nowMs: NOW, git }).join()).toMatch(/budget/);
  });
  it('a reduction cannot pass on a measure alone; a behaviour change can', () => {
    const { commit, git } = repo();
    const tested = commit('src/lean.ts', 'code');
    const measure = { idea: 'idea-1', 'record-hash': 'h1', kind: 'measure', result: 'pass', testedCommit: tested, rolloutScope: 'fleet', measure: 'm', baseline: 1, outcome: 1 };
    expect(checkEvidence({ spec, proof: measure, nowMs: NOW, git }).join()).toMatch(/needs a trial/);
    expect(checkEvidence({ spec: { ...spec, 'effect-class': 'behaviour-changing' }, proof: measure, nowMs: NOW, git })).toEqual([]);
  });
  it('an exception works until it expires', () => {
    const { git } = repo();
    const ex = { idea: 'idea-1', 'record-hash': 'h1', kind: 'exception', pinRef: 'p', scope: 's', rollback: 'r', reviewAt: '2027-01-01', expiresAt: '2026-12-01' };
    expect(checkEvidence({ spec, proof: ex, nowMs: NOW, git })).toEqual([]);
    expect(checkEvidence({ spec, proof: { ...ex, expiresAt: '2026-10-01' }, nowMs: NOW, git }).join()).toMatch(/expired/);
    expect(checkEvidence({ spec, proof: { ...ex, 'record-hash': 'other' }, nowMs: NOW, git }).join()).toMatch(/record-hash/);
  });
});

describe('lintSpecs', () => {
  const { git } = { git: { isAncestor: () => true, isAncestorOf: () => true, changedSince: () => [] } };
  it('ignores an untagged spec, and a tagged one whose default did not change', () => {
    expect(lintSpecs({ specs: [{ title: 'x' }], diffByFlag: () => true, readProof: () => null, nowMs: NOW, git })).toEqual([]);
    expect(lintSpecs({ specs: [spec], diffByFlag: () => false, readProof: () => null, nowMs: NOW, git })).toEqual([]);
  });
  it('refuses a default change with no report', () => {
    expect(lintSpecs({ specs: [spec], diffByFlag: () => true, readProof: () => null, nowMs: NOW, git }).join()).toMatch(/no docs\/proofs/);
  });
  it('a flagless reduction fails unless it carries an exception', () => {
    const flagless = { ...spec, 'ecosystem-flags': [] };
    expect(lintSpecs({ specs: [flagless], diffByFlag: () => false, readProof: () => null, nowMs: NOW, git }).join()).toMatch(/must name a flag/);
    const ex = { idea: 'idea-1', 'record-hash': 'h1', kind: 'exception', pinRef: 'p', scope: 's', rollback: 'r', reviewAt: '2027-01-01', expiresAt: '2026-12-01' };
    expect(lintSpecs({ specs: [flagless], diffByFlag: () => false, readProof: () => ex, nowMs: NOW, git })).toEqual([]);
  });
  it('a flagless additive idea has nothing to watch', () => {
    expect(lintSpecs({ specs: [{ ...spec, 'effect-class': 'additive-dark', 'ecosystem-flags': [] }], diffByFlag: () => true, readProof: () => null, nowMs: NOW, git })).toEqual([]);
  });
});

describe('diffChangesDefault', () => {
  it('sees a default flip under the right parent, and leaves others alone', () => {
    const hit = '@@ -1,4 +1,4 @@\n     lean: {\n-      enabled: false,\n+      enabled: true,\n     },\n';
    expect(diffChangesDefault(hit, 'sessions.lean.enabled')).toBe(true);
    const other = '@@ -1,4 +1,4 @@\n     other: {\n-      enabled: false,\n+      enabled: true,\n     },\n';
    expect(diffChangesDefault(other, 'sessions.lean.enabled')).toBe(false);
  });
  it('sees a dev-gate entry removed', () => {
    expect(diffChangesDefault("@@ -1 +1 @@\n-    configPath: 'sessions.lean.enabled',\n", 'sessions.lean.enabled')).toBe(true);
  });
});

describe('parseSpecFrontmatter', () => {
  it('reads scalars and both list forms', () => {
    const p = parseSpecFrontmatter('---\necosystem-idea: "idea-1"\necosystem-flags: [a.b, c.d]\necosystem-paths:\n  - src/x.ts\n---\nbody');
    expect(p).toMatchObject({ 'ecosystem-idea': 'idea-1', 'ecosystem-flags': ['a.b', 'c.d'], 'ecosystem-paths': ['src/x.ts'] });
    expect(parseSpecFrontmatter('no frontmatter')).toBeNull();
  });
});
