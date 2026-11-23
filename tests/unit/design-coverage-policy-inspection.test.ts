import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesignStandard } from '../../src/designGate/standardParser.js';
import { DESIGN_STRUCTURAL_ROWS } from '../../src/designGate/modes.js';
import { inspectDesignCoveragePolicy } from '../../src/designGate/coveragePolicyInspection.js';
const rules = parseDesignStandard(fs.readFileSync('docs/DESIGN-STANDARD.md', 'utf8')).rules;
const earned = rules.find(r => r.id === 'DS-DATA-2')!;
const checks = [{ id: 'columns', ruleIds: [earned.id], surfaces: earned.surfaces }, { id: 'replacement', ruleIds: [earned.id], surfaces: earned.surfaces }];
function policy() {
 return { rules: structuredClone(rules), modes: { version: 1, modes: { ...Object.fromEntries(DESIGN_STRUCTURAL_ROWS.map(id => [id, 'block'])), columns: 'block', replacement: 'report' } },
 coverage: { version: 1, rows: rules.flatMap(rule => rule.surfaces.map(surface => ({ ruleId: rule.id, surface, kind: 'staged', trackedBy: 'CMT-2169', reason: 'Synthetic test coverage not implemented.', ...(rule.checkKind === 'review' ? { evidenceKind: 'synthetic-screen-capture' } : {}) }))) } };
}
const inspect = (base = policy(), head = policy()) => inspectDesignCoveragePolicy({ base, head, checks, trackedCommitments: new Set(['CMT-2169']) });
function enable(p: ReturnType<typeof policy>) {
 const at = p.coverage.rows.findIndex(row => row.ruleId === earned.id && row.surface === 'Web');
 p.coverage.rows[at] = { ruleId: earned.id, surface: 'Web', kind: 'check', checker: 'columns' } as any;
 return p;
}
describe('complete coverage and modes form observations only', () => {
 it('accepts an explicit complete staged domain without calling it execution proof', () => {
  expect(inspect()).toMatchObject({ status: 'structurally-valid', mergeAuthority: false, executionEvidence: false, changes: [] });
 });
 it('reports a missing surface instead of comparing partial policy', () => {
  const head = policy(); head.coverage.rows.pop(); expect(inspect(policy(), head).status).toBe('invalid-policy');
 });
 it('requires a real declared tracked commitment rather than any well-shaped invented identifier', () => {
  const head = policy(); head.coverage.rows[0].trackedBy = 'CMT-999999';
  expect(inspect(policy(), head).errors).toContainEqual(expect.objectContaining({ side: 'head', code: 'coverage-tracker-unknown' }));
 });
 it('does not compare malformed modes or unknown checkers', () => {
  const head = enable(policy()); (head.modes.modes as Record<string, string>)['standard-weakened'] = 'report';
  expect(inspect(policy(), head).status).toBe('invalid-policy');
 });
 it('reports checked coverage becoming staged for BASE-earned rules', () => {
  expect(inspect(enable(policy()), policy()).changes).toContainEqual({ ruleId: earned.id, kind: 'coverage-staged', surface: 'Web', checker: 'columns' });
 });
 it('compares the effective mode even when head changes checker identity', () => {
  const head = enable(policy()); (head.coverage.rows.find(row => row.ruleId === earned.id && row.surface === 'Web') as any).checker = 'replacement';
  expect(inspect(enable(policy()), head).changes).toContainEqual(expect.objectContaining({ kind: 'mode-report', beforeChecker: 'columns', afterChecker: 'replacement' }));
 });
 it('keeps BASE provenance even when head erases it', () => {
  const head = policy(); head.rules.find(r => r.id === earned.id)!.earnedFrom = [];
  expect(inspect(enable(policy()), head).changes).toContainEqual(expect.objectContaining({ kind: 'coverage-staged', ruleId: earned.id }));
 });
 it('does not invent a reduction when a reporting checker becomes blocking', () => {
  const base = enable(policy()); base.modes.modes.columns = 'report';
  expect(inspect(base, enable(policy())).changes).toEqual([]);
 });
 it('rejects missing review evidence kind on a staged row', () => {
  const head = policy(); delete head.coverage.rows.find(row => row.evidenceKind)!.evidenceKind;
  expect(inspect(policy(), head).errors).toContainEqual(expect.objectContaining({ code: 'coverage-evidence-kind-missing' }));
 });
 it('rejects a malformed executing-code capability catalog without throwing', () => {
  expect(inspectDesignCoveragePolicy({ base: policy(), head: policy(), checks: [{ id: 'broken' } as any], trackedCommitments: new Set() }).status).toBe('invalid-policy');
 });
});
