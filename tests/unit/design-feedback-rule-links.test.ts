import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectFeedbackRuleLinks } from '../../src/designGate/feedbackRuleLinks.js';
import { designStandardForEntries } from '../fixtures/designStandardForEntries.js';
// Only DF-0001 is passed below, so the standard keeps only the rules it (or no entry) earned.
const standard = designStandardForEntries(fs.readFileSync('docs/DESIGN-STANDARD.md', 'utf8'), ['DF-0001']);
const filename = 'docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md';
const markdown = fs.readFileSync(filename, 'utf8');
const entry = (text = markdown, path = filename) => ({ path, markdown: text });
const inspect = (entries = [entry()], text = standard) => inspectFeedbackRuleLinks({ standard: text, entries });
describe('feedback entry structure and reciprocal rule links', () => {
 it('reads all fifteen original problems and22earnedrule rows without treating metadata as approval proof', () => {
  const r = inspect(); expect(r.errors).toEqual([]); expect(r.mergeAuthority).toBe(false); expect(r.sourceVerification).toBe(false);
  expect(r.entries[0]).toMatchObject({ id: 'DF-0001', cardId: 'wc_ee8eeb00afe51011', problemCount: 15 });
  expect(r.entries[0].ruleIds).toHaveLength(22);
 });
 it('refuses duplicate entry numbers even with different filenames', () => {
  expect(inspect([entry(), entry(markdown, 'docs/design-feedback/DF-0001-duplicate.md')]).errors).toContainEqual(expect.objectContaining({ code: 'entry-number-duplicate' }));
 });
 it('rejects an image or arbitrary file in the public entry collection', () => {
  expect(inspect([entry(), entry('private pixels', 'docs/design-feedback/real-account.png')]).errors).toContainEqual(expect.objectContaining({ code: 'entry-path-invalid' }));
 });
 it('requires genuine-shaped card and source metadata without grandfathering the original entry', () => {
  const missing = markdown.replace(/^\| Card \|.*\n/m, '').replace(/^\| Source message \|.*\n/m, '');
  expect(inspect([entry(missing)]).errors.map(e => e.code)).toEqual(expect.arrayContaining(['entry-card-missing', 'entry-source-missing']));
 });
 it('does not accept metadata hidden after the real header or inside a code fence', () => {
  const missing = markdown.replace(/^\| Card \|.*\n/m, '');
  expect(inspect([entry(missing + '\n```\n| Card | `wc_ee8eeb00afe51011` |\n```\n')]).errors).toContainEqual(expect.objectContaining({ code: 'entry-card-missing' }));
 });
 it('rejects a private email while allowing invented example.com accounts', () => {
  expect(inspect([entry(markdown.replace('account-a@example.com', 'private@actual-company.test'))]).errors).toContainEqual(expect.objectContaining({ code: 'entry-email-not-synthetic' }));
 });
 it('rejects an earned provenance reference whose entry is absent', () => {
  expect(inspect([]).errors).toContainEqual(expect.objectContaining({ code: 'earned-entry-missing', ruleId: 'DS-DATA-2' }));
 });
 it('rejects a missing reciprocal rule table row', () => {
  expect(inspect([entry(markdown.replace(/^\| DS-DATA-2 \|.*\n/m, ''))]).errors).toContainEqual(expect.objectContaining({ code: 'entry-earned-rule-missing', ruleId: 'DS-DATA-2' }));
 });
 it('rejects a table rule whose standard provenance no longer names the entry', () => {
  const changed = standard.replace(/DF-0001/g, 'DF-9999');
  expect(inspect([entry()], changed).errors).toContainEqual(expect.objectContaining({ code: 'entry-rule-provenance-missing', ruleId: 'DS-DATA-2' }));
 });
 it('rejects a rule-table link to a nonexistent numbered problem', () => {
  expect(inspect([entry(markdown.replace('| DS-DATA-2 | Added | 1 |', '| DS-DATA-2 | Added | 999 |'))]).errors).toContainEqual(expect.objectContaining({ code: 'entry-problem-reference-invalid', ruleId: 'DS-DATA-2' }));
 });
 it('refuses a rule table link to an existing but unrelated diagnosis', () => {
  expect(inspect([entry(markdown.replace('| DS-DATA-2 | Added | 1 |', '| DS-DATA-2 | Added | 2 |'))]).errors).toContainEqual(expect.objectContaining({ code: 'entry-problem-rule-mismatch', ruleId: 'DS-DATA-2', problem: 2 }));
 });

 it('does not expose code-only metadata after an invalid closing fence with trailing text', () => {
  expect(inspect([entry('```\n```not-a-close\n' + markdown)]).errors).toContainEqual(expect.objectContaining({ code: 'entry-card-missing' }));
 });

 it('keeps literal comment syntax inside a closed code block from hiding the following real diagnosis', () => {
  const code = '```text\n<!-- literal example, not an HTML block\n```\n\n';
  expect(inspect([entry(markdown.replace('## Diagnosis', code + '## Diagnosis'))]).errors).toEqual([]);
 });

 it('does not treat nested fenced examples as actual diagnosis rule citations', () => {
  const start = markdown.indexOf('1. **"100%"'); const end = markdown.indexOf('\n2. **The bars', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const body = markdown.slice(start, end).replace(/DS-DATA-1|DS-DATA-2|DS-DELIGHT-6/g, 'removed-citation');
  const nested = '\n\n   ```text\n   DS-DATA-1 DS-DATA-2 DS-DELIGHT-6\n   ```\n';
  expect(inspect([entry(markdown.slice(0, start) + body + nested + markdown.slice(end))]).errors).toContainEqual(expect.objectContaining({ code: 'entry-problem-rule-missing', problem: 1 }));
 });

 it('does not echo arbitrary source-header prose in its structural report', () => {
  const secret = 'private-unpublished-source-prose';
  const changed = markdown.replace(/^(\| Source message \|).*$/m, '$1 ' + secret + ' |');
  const r = inspect([entry(changed)]);
  expect(r.entries[0].sourcePresent).toBe(true); expect(JSON.stringify(r)).not.toContain(secret);
 });

 it('does not accept a malformed diagnosis identifier by matching its issued prefix', () => {
  expect(inspect([entry(markdown.replace('**DS-DATA-2**', '**DS-DATA-2-typo**'))]).errors).toContainEqual(expect.objectContaining({ code: 'entry-problem-rule-id-invalid', problem: 1 }));
 });

});
