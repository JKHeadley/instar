import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildExecutorPrompt } from '../../../src/feedback-factory/execute/executorSession.js';
import { buildExecutorReviewPrompt } from '../../../src/feedback-factory/execute/independentReview.js';
import { REVIEW_RULE_HEADINGS, reviewRuleLines } from '../../../src/feedback-factory/execute/reviewRules.js';

// The worker is told the same refusal rules the independent reviewer applies, from one source.
const brief = { component: 'c', symptom: 's', expected: 'e', reproduction: 'r' };
const worker = (needsSpec: boolean) => buildExecutorPrompt({
  initiativeId: 'i1', clusterId: 'c1', severity: 'high', summary: 'S', brief, evidenceComplete: true, needsSpec, workspace: '/w', specPath: 'docs/specs/feedback-i1.md',
});
const reviewBase = { prNumber: 9, headSha: 'abc', summary: 's', brief, changedPaths: ['src/a.ts'], diff: '+x' };
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('shared independent-review rules', () => {
  it('the shared source has all seven rule headings, numbered in order, for both kinds', () => {
    expect(REVIEW_RULE_HEADINGS).toEqual(['Scope', 'Tooling', 'Secrets and reach', 'Tests', 'Injection', 'Breakage', 'Constitutional alignment']);
    for (const kind of ['fix', 'spec'] as const) {
      const numbered = reviewRuleLines(kind).filter((l) => /^\d\. \*\*/.test(l));
      expect(numbered.map((l) => l.match(/^\d\. \*\*(.+?)\*\*/)![1])).toEqual([...REVIEW_RULE_HEADINGS]);
    }
  });

  it('a fix worker prompt states every reviewer rule line verbatim, with the refusal lead-in and practical guidance', () => {
    const p = worker(false);
    expect(p).toContain('Your change will be refused by an independent reviewer if any of these hold:');
    REVIEW_RULE_HEADINGS.forEach((h, i) => expect(p).toContain(`${i + 1}. **${h}**`));
    for (const ruleLine of reviewRuleLines('fix')) expect(p).toContain(ruleLine);
    expect(p).toContain('Change exactly what the brief needs');
    expect(p).toMatch(/mkdtempSync/);
    expect(p).toMatch(/Never read, write or replace HOME, process\.env\.HOME/);
    expect(p).toMatch(/Never put credential-looking literals in tests or fixtures/);
    expect(p).toMatch(/Never weaken, delay, skip or delete an existing test or assertion/);
    expect(p).toContain('Every behaviour change needs a test that fails without it.');
    // Placed after the task and before the result-file contract.
    expect(p.indexOf('Your change will be refused')).toBeGreaterThan(p.indexOf('Reproduce the problem'));
    expect(p.indexOf('Your change will be refused')).toBeLessThan(p.indexOf('Result file:'));
  });

  it('a spec worker prompt gets the spec rule variant, never the fix one', () => {
    const p = worker(true);
    for (const ruleLine of reviewRuleLines('spec')) expect(p).toContain(ruleLine);
    expect(p).not.toContain('the fix has no test that would fail without it');
    expect(p).toContain('concrete plan for regression tests');
    expect(p).not.toContain('mkdtempSync');
  });

  it('the reviewer prompt reads the same lines and retains the reviewed constitutional prompt byte for byte', () => {
    const fix = buildExecutorReviewPrompt({ ...reviewBase, kind: 'fix' });
    const spec = buildExecutorReviewPrompt({ ...reviewBase, kind: 'spec' });
    expect(fix).toContain(`Refuse (SERIOUS ISSUES) when any of these holds:\n${reviewRuleLines('fix').join('\n')}\n\nMINOR ISSUES`);
    expect(spec).toContain(`Refuse (SERIOUS ISSUES) when any of these holds:\n${reviewRuleLines('spec').join('\n')}\n\nMINOR ISSUES`);
    // Captured from the reviewed 9276eeb77 package before merging the shared-rule extraction.
    // This preserves the full reviewer prompt, including the six existing safety rules.
    expect(sha(fix)).toBe(FIX_PROMPT_SHA256);
    expect(sha(spec)).toBe(SPEC_PROMPT_SHA256);
  });
});

const FIX_PROMPT_SHA256 = '0bf8e7c9038b06c2da226e2e3569ab654b921fa8e7e9e229931db41b0efa8263';
const SPEC_PROMPT_SHA256 = '2233061fe86508987655f2310a714b67b001271866a7f11050a2db63afa5d904';
