import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectDesignPolicy } from '../../src/designGate/policyInspection.js';
const standard = fs.readFileSync('docs/DESIGN-STANDARD.md', 'utf8');
const lock = JSON.parse(fs.readFileSync('docs/design/rule-ids.lock.json', 'utf8'));
const registry = { version: 1, screens: [{ id: 'accounts', title: 'Accounts', mainQuestion: 'Which account has room?', surface: 'Web', route: '/accounts', sources: ['dashboard/accounts.js'], shared: [], capture: 'uncaptured', trackedBy: 'CMT-2169' }] };
const snapshot = () => ({ standard, lock: structuredClone(lock), registry: structuredClone(registry) });
const run = (base = snapshot(), head = snapshot(), changedPaths: string[] = []) => inspectDesignPolicy({ base, head, changedPaths, sourceText: {} });
describe('manual design policy signals', () => {
 it('reports its exact scope and does not represent unchanged structure as visual clearance', () => {
  const r = run(); expect(r.status).toBe('structurally-valid'); expect(r.mergeAuthority).toBe(false);
  expect(r.notEvaluated).toContain('rendering'); expect(r.notEvaluated).toContain('coverage-and-modes');
 });
 it('keeps base screen impact when the candidate removes its registration', () => {
  const head = snapshot(); head.registry.screens = [];
  const r = run(snapshot(), head, ['dashboard/accounts.js']);
  expect(r.classification.screens).toEqual(['accounts']); expect(r.classification.kind).toBe('ui');
 });
 it('reports an unregistered new screen', () => {
  const r = run(snapshot(), snapshot(), ['dashboard/new.html']);
  expect(r.status).toBe('findings'); expect(r.findings).toContainEqual(expect.objectContaining({ code: 'screen-unregistered', path: 'dashboard/new.html' }));
 });
 it('rejects removal from permanent issuance history', () => {
  const head = snapshot(); head.lock.ids = head.lock.ids.filter((id: string) => id !== 'DS-DATA-2');
  expect(run(snapshot(), head).findings).toContainEqual(expect.objectContaining({ side: 'head', code: 'rule-id-history-removed', ruleId: 'DS-DATA-2' }));
 });
 it('retains both wordings when an earned tolerance changes', () => {
  const head = snapshot(); head.standard = head.standard.replace('within 1 unit', 'within 10 units');
  const r = run(snapshot(), head);
  expect(r.status).toBe('review-required'); expect(r.earnedRuleChanges).toContainEqual(expect.objectContaining({ ruleId: 'DS-DATA-2', kind: 'wording-review' }));
 });
 it('fails structurally rather than throwing when candidate policy is malformed', () => {
  const head = { ...snapshot(), registry: { screens: 'invalid' } };
  expect(inspectDesignPolicy({ base: snapshot(), head, changedPaths: [], sourceText: {} }).status).toBe('invalid-policy');
 });
 it('does not allow erased provenance to hide earned wording changes', () => {
  const head = snapshot(); head.standard = head.standard.replace(/DF-0001/g, 'DF-9999').replace('within 1 unit', 'within 10 units');
  expect(run(snapshot(), head).earnedRuleChanges).toContainEqual(expect.objectContaining({ kind: 'provenance-removed', entryId: 'DF-0001' }));
 });
});
