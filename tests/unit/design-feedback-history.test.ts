import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectFeedbackHistory } from '../../src/designGate/feedbackHistory.js';
import { designStandardForEntries } from '../fixtures/designStandardForEntries.js';
// Only DF-0001 is passed below, so the standard keeps only its rules and changelog rows.
const standard = designStandardForEntries(fs.readFileSync('docs/DESIGN-STANDARD.md', 'utf8'), ['DF-0001']);
const path = 'docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md';
const markdown = fs.readFileSync(path, 'utf8');
const snapshot = () => ({ standard, entries: [{ path, markdown }] });
const run = (base = snapshot(), head = snapshot()) => inspectFeedbackHistory({ base, head });
describe('feedback changelog and history observations', () => {
 it('accepts the unchanged real entry and expands its existing parity range exactly', () => {
  const r = run(); expect(r.errors).toEqual([]); expect(r.mergeAuthority).toBe(false);
  expect(r.changelog[0].ruleIds).toHaveLength(22);
 });
 it('detects an omitted changelog rule even when all entry links are otherwise valid', () => {
  const head = snapshot(); head.standard = head.standard.replace('Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2,', 'Added DS-LAYOUT-3, DS-DATA-1,');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-rules-mismatch', entryId: 'DF-0001' }));
 });
 it('detects an extra unrelated rule in the changelog row', () => {
  const head = snapshot(); head.standard = head.standard.replace('Added DS-LAYOUT-3,', 'Added DS-A11Y-1, DS-LAYOUT-3,');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-rules-mismatch' }));
 });
 it('detects duplicate rows instead of taking whichever appeared last', () => {
  const head = snapshot(); const row = standard.split('\n').find(line => line.startsWith('| 2026-11-21 | Added'))!;
  head.standard = standard.replace(row, row + '\n' + row);
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-entry-duplicate' }));
 });
 it('requires a changelog row when the entry added or sharpened rules', () => {
  const head = snapshot(); head.standard = head.standard.replace(/^\| 2026-11-21 \| Added.*\n?/m, '');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-entry-missing' }));
 });
 it('never silently drops a base entry when both head links and the document disappear', () => {
  const head = snapshot(); head.entries = []; head.standard = head.standard.replace(/\s*\*\*Earned from\*\*:\s*DF-0001\.?/g, '');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'entry-history-removed', entryId: 'DF-0001' }));
 });
 it('preserves each base rules-table row independently of head provenance edits', () => {
  const head = snapshot(); head.entries[0].markdown = markdown.replace(/^\| DS-DATA-2 \|.*\n/m, '');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'entry-rule-history-removed', ruleId: 'DS-DATA-2' }));
 });
 it('refuses reversed or unknown ranges without allocating an unbounded sequence', () => {
  for (const range of ['DS-PARITY-1 to DS-PARITY-999999999', 'DS-PARITY-5 to DS-PARITY-1', 'DS-PARITY-1 to DS-DATA-5']) {
   const head = snapshot(); head.standard = head.standard.replace('DS-PARITY-1 to DS-PARITY-5', range);
   expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-range-invalid' }));
  }
 });
 it('does not count a changelog table hidden inside a fenced example', () => {
  const head = snapshot(); head.standard = head.standard.replace('## Changelog\n', '## Changelog\n\n```text\n') + '\n```\n';
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-entry-missing' }));
 });
 it('does not count a hidden comment as an actual changed-rule citation', () => {
  const head = snapshot(); head.standard = head.standard.replace('Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2,', 'Added DS-LAYOUT-3, DS-DATA-1, <!-- DS-DATA-2 -->,');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-rules-mismatch' }));
 });
 it('does not assign a row to an entry named only in a hidden source comment', () => {
  const head = snapshot(); head.standard = head.standard.replace('| DF-0001 |', '| <!-- DF-0001 --> |');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-entry-missing' }));
 });

 it('uses the visible changelog heading instead of treating a hidden comment as part of its name', () => {
  const head = snapshot(); head.standard = standard.replace('## Changelog', '## Changelog <!-- harmless annotation -->');
  expect(run(snapshot(), head).errors).toEqual([]);
 });

 it('does not normalize unknown padded or fractional range endpoints into issued rule IDs', () => {
  for (const range of ['DS-PARITY-0001 to DS-PARITY-0005', 'DS-PARITY-1 to DS-PARITY-5.5']) {
   const head = snapshot(); head.standard = standard.replace('DS-PARITY-1 to DS-PARITY-5', range);
   expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-range-invalid' }));
  }
 });
 it('does not accept a fractional standalone identifier by matching its issued prefix', () => {
  const head = snapshot(); head.standard = standard.replace('Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2,', 'Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2.5,');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-rule-id-invalid' }));
 });

 it('preserves an actually issued padded identifier domain rather than banning or canonicalizing it', () => {
  const rename = (text: string) => text.replace(/DS-PARITY-([1-5])\b/g, (_id, number: string) => 'DS-PARITY-' + number.padStart(4, '0'));
  const own = { standard: rename(standard), entries: [{ path, markdown: rename(markdown) }] };
  expect(run(own, own).errors).toEqual([]);
 });

 it('does not accept a malformed standalone suffix by matching its issued prefix', () => {
  const head = snapshot(); head.standard = standard.replace('Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2,', 'Added DS-LAYOUT-3, DS-DATA-1, DS-DATA-2-typo,');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-rule-id-invalid' }));
 });

 it('does not impose a positive-number rule on a zero identifier that actually exists in the supplied domain', () => {
  const rename = (text: string) => text.replace(/DS-PARITY-([1-5])\b/g, (_id, number: string) => 'DS-PARITY-' + (Number(number) - 1));
  const own = { standard: rename(standard), entries: [{ path, markdown: rename(markdown) }] };
  expect(run(own, own).errors).toEqual([]);
 });

 it('does not accept a malformed entry cause by matching its known entry prefix', () => {
  const head = snapshot(); head.standard = standard.replace('| DF-0001 |', '| DF-0001-typo |');
  expect(run(snapshot(), head).errors).toContainEqual(expect.objectContaining({ code: 'changelog-source-id-invalid' }));
 });

 it('accepts the exact known entry filename as a cause without accepting unknown suffixes', () => {
  const head = snapshot(); head.standard = standard.replace('| DF-0001 |', '| ' + path + ' |');
  expect(run(snapshot(), head).errors).toEqual([]);
 });

});
