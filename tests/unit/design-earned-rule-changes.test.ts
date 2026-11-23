import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDesignStandard, type DesignRule } from '../../src/designGate/standardParser.js';
import { inspectEarnedRuleChanges } from '../../src/designGate/earnedRuleChanges.js';
const approved = parseDesignStandard(fs.readFileSync('docs/DESIGN-STANDARD.md', 'utf8')).rules;
const baseRule = approved.find(r => r.id === 'DS-DATA-2')!;
const rule = (change: Partial<DesignRule> = {}) => ({ ...structuredClone(baseRule), ...change });
const policy = (rules = [rule()], rows: any[] = [], modes: Record<string, 'block' | 'report'> = { alignment: 'block' }) => ({ rules, coverage: rows, modes });
const checked = (checker = 'alignment') => ({ ruleId: baseRule.id, surface: 'Web', kind: 'check' as const, checker });
describe('earned-rule change signals', () => {
 it('does not invent a change for the unchanged approved earned rule', () => {
  expect(baseRule.earnedFrom).toContain('DF-0001');
  expect(inspectEarnedRuleChanges(policy(), policy())).toEqual([]);
 });
 it('reports retirement even when the identifier stays issued elsewhere', () => {
  expect(inspectEarnedRuleChanges(policy(), policy([]))).toContainEqual({ ruleId: baseRule.id, kind: 'retired' });
 });
 it('reports each removed surface but not an added surface', () => {
  const small = rule({ surfaces: ['Web'] });
  expect(inspectEarnedRuleChanges(policy([small]), policy())).toEqual([]);
  const changes = inspectEarnedRuleChanges(policy(), policy([small]));
  expect(changes.filter(c => c.kind === 'surface-removed').map(c => c.surface)).toEqual(baseRule.surfaces.filter(s => s !== 'Web'));
 });
 it('reports conversion of an earned machine check to review', () => {
  expect(inspectEarnedRuleChanges(policy(), policy([rule({ checkKind: 'review', check: 'review. Compare visually.', measurement: null })])))
   .toContainEqual({ ruleId: baseRule.id, kind: 'machine-to-review' });
 });
 it('sends Rule, Check and at-a-glance wording independently to review without deciding their meaning', () => {
  for (const field of ['rule', 'check', 'measurement'] as const) {
   const next = rule({ [field]: String(baseRule[field]) + ' Changed wording.' });
   expect(inspectEarnedRuleChanges(policy(), policy([next]))).toContainEqual({ ruleId: baseRule.id, kind: 'wording-review', field, before: baseRule[field], after: next[field] });
  }
 });
 it('retains changed applicability wording even if the expanded surface set is identical', () => {
  const next = rule({ surfaceText: 'All surfaces that offer both modes.' });
  expect(inspectEarnedRuleChanges(policy(), policy([next]))).toContainEqual({ ruleId: baseRule.id, kind: 'wording-review', field: 'surfaceText', before: baseRule.surfaceText, after: next.surfaceText });
 });
 it('does not let a tolerance change escape merely because the Rule is unchanged', () => {
  const next = rule({ measurement: 'The tolerance is now 10 units.' });
  expect(inspectEarnedRuleChanges(policy(), policy([next]))).toContainEqual({ ruleId: baseRule.id, kind: 'wording-review', field: 'measurement', before: baseRule.measurement, after: next.measurement });
 });
 it('reports loss of an earned-from mark separately from rule wording', () => {
  expect(inspectEarnedRuleChanges(policy(), policy([rule({ earnedFrom: [] })]))).toContainEqual({ ruleId: baseRule.id, kind: 'provenance-removed', entryId: 'DF-0001' });
 });
 it('reports executable coverage becoming staged', () => {
  expect(inspectEarnedRuleChanges(policy([rule()], [checked()]), policy([rule()], [{ ruleId: baseRule.id, surface: 'Web', kind: 'staged' }])))
   .toContainEqual({ ruleId: baseRule.id, kind: 'coverage-staged', surface: 'Web', checker: 'alignment' });
 });
 it('reports an effective checker downgrade even when the head changes checker identity', () => {
  expect(inspectEarnedRuleChanges(policy([rule()], [checked()], { alignment: 'block' }), policy([rule()], [checked('replacement')], { alignment: 'block', replacement: 'report' })))
   .toContainEqual({ ruleId: baseRule.id, kind: 'mode-report', surface: 'Web', beforeChecker: 'alignment', afterChecker: 'replacement' });
 });
 it('does not mislabel already-reporting coverage or a strengthening as a reduction', () => {
  expect(inspectEarnedRuleChanges(policy([rule()], [checked()], { alignment: 'report' }), policy([rule()], [checked()], { alignment: 'block' }))).toEqual([]);
 });
 it('applies earned protection from BASE even if HEAD erases provenance, and ignores unearned wording changes', () => {
  const plain = rule({ earnedFrom: [] });
  expect(inspectEarnedRuleChanges(policy([plain]), policy([rule({ earnedFrom: [], rule: 'New wording.' })]))).toEqual([]);
  const changes = inspectEarnedRuleChanges(policy(), policy([rule({ earnedFrom: [], rule: 'New wording.' })]));
  expect(changes.some(c => c.kind === 'wording-review')).toBe(true);
 });
});
