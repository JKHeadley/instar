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
  it('the shared source has the six rule headings, numbered in order, for both kinds', () => {
    expect(REVIEW_RULE_HEADINGS).toEqual(['Scope', 'Tooling', 'Secrets and reach', 'Tests', 'Injection', 'Breakage']);
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

  it('the reviewer prompt reads the same lines, and its bytes are unchanged by the extraction', () => {
    const fix = buildExecutorReviewPrompt({ ...reviewBase, kind: 'fix' });
    const spec = buildExecutorReviewPrompt({ ...reviewBase, kind: 'spec' });
    expect(fix).toContain(`Refuse (SERIOUS ISSUES) when any of these holds:\n${reviewRuleLines('fix').join('\n')}\n\nMINOR ISSUES`);
    expect(spec).toContain(`Refuse (SERIOUS ISSUES) when any of these holds:\n${reviewRuleLines('spec').join('\n')}\n\nMINOR ISSUES`);
    // Pinned from the reviewer prompt as it was before the rules moved to reviewRules.ts.
    expect(sha(fix)).toBe(FIX_PROMPT_SHA256);
    expect(sha(spec)).toBe(SPEC_PROMPT_SHA256);
  });
});

const FIX_PROMPT_SHA256 = 'f2de9e1b8b2389f0c8a6eab1c45157bfb1dadc58251668dd5dd7ff72e38c7423';
const SPEC_PROMPT_SHA256 = '2c5c38a7e1e9b95fa98126afba8ff5e2c0156d130b1663be6d89454fa807ed8b';
