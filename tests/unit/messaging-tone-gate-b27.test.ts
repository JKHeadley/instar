/**
 * B27_SPEC_REVIEW_UNLINKED in the tone gate (docs/specs/spec-review-link-at-delivery.md §2, §6).
 *
 * The rule is judged by meaning, so these tests pin the STRUCTURE on both sides of every boundary:
 * registration and disposition, when the section renders, the prompt id, the per-call accepted
 * citations (B27 only where rendered; an override chain's left-out rules never), and the capture
 * ceiling for enrolled agents.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MessagingToneGate,
  TONE_GATE_PROMPT_TEMPLATE,
  TONE_GATE_PROMPT_ID,
  TONE_GATE_PROMPT_ID_B26_SUFFIX,
  TONE_GATE_PROMPT_ID_B27_SUFFIX,
  TONE_GATE_PROMPT_ID_CHAIN_SUFFIX,
  TONE_CANDIDATE_BODY_MAX_CHARS,
  B27_CAPTURE_MAX_CHARS,
  B27_SPEC_REVIEW_RULE,
  renderSpecReviewSection,
  renderAcknowledgedRulesSection,
  buildToneDecisionContext,
  VALID_RULES,
  RULE_CLASSES,
  RULE_DISPOSITIONS,
  ADVISORY_MIGRATION_EXEMPT_RULES,
  resolveRuleDisposition,
} from '../../src/core/MessagingToneGate.js';
import { CONTENT_FULL_KEY } from '../../src/core/JudgmentProvenanceLog.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const HANDOFF = 'Ready for your review: docs/specs/spec-review-link-at-delivery.md';
const SECTION = '=== B27 A SPEC HANDED OVER FOR REVIEW CARRIES A READABLE LINK ===';
const FACTS = { reference: 'docs/specs/spec-review-link-at-delivery.md', handoffWording: true, links: [] };

function capture(verdicts: Array<Record<string, unknown>> = [{ pass: true, rule: '', issue: '', suggestion: '' }]) {
  const prompts: string[] = [];
  const opts: Array<Record<string, any>> = [];
  let i = 0;
  const provider = {
    evaluate: vi.fn(async (prompt: string, o?: Record<string, any>) => {
      prompts.push(prompt); opts.push(o ?? {});
      const v = verdicts[Math.min(i, verdicts.length - 1)]; i++;
      return JSON.stringify(v);
    }),
  } as unknown as IntelligenceProvider;
  return { provider, prompts, last: () => prompts[prompts.length - 1], lastOpts: () => opts[opts.length - 1] };
}

describe('B27 registration', () => {
  it('is a valid, judge-by-meaning, advisory rule that is not migration-exempt', () => {
    expect(VALID_RULES.has('B27_SPEC_REVIEW_UNLINKED')).toBe(true);
    expect(RULE_CLASSES.B27_SPEC_REVIEW_UNLINKED).toBe('behavioral-judgment');
    expect(RULE_DISPOSITIONS.B27_SPEC_REVIEW_UNLINKED).toBe('advisory');
    expect(ADVISORY_MIGRATION_EXEMPT_RULES.has('B27_SPEC_REVIEW_UNLINKED')).toBe(false);
    expect(resolveRuleDisposition('B27_SPEC_REVIEW_UNLINKED', false)).toBe('advisory');
    expect(resolveRuleDisposition('B27_SPEC_REVIEW_UNLINKED', true)).toBe('advisory');
  });
  it('is not in the benchmarked base template (dynamic section only)', () => {
    expect(TONE_GATE_PROMPT_TEMPLATE).not.toContain('B27_SPEC_REVIEW_UNLINKED');
  });
  it('carries both sides of the boundary, the B25 citation order and under-fire bias', () => {
    const s = B27_SPEC_REVIEW_RULE;
    expect(s).toContain('JUDGE BY MEANING');
    expect(s).toContain('a link to something else does not count');
    expect(s).toContain('exists=no does not open');
    expect(s).toContain('judge a handoff they missed exactly like one they found');
    expect(s).toContain('cite B25');
    expect(s).toContain('when unsure whether the candidate hands over a spec for review, do NOT fire');
  });
});

describe('B27 section', () => {
  it('renders the detector facts as bounded data', () => {
    const out = renderSpecReviewSection({ facts: { ...FACTS, links: [{ shape: 'doc', ownHost: true, exists: 'unknown' }, { shape: 'other' }] } });
    expect(out).toContain(SECTION);
    expect(out).toContain('spec-reference: "docs/specs/spec-review-link-at-delivery.md"');
    expect(out).toContain('handoff-wording: yes');
    expect(out).toContain('L1 shape=doc own-host exists=unknown; L2 shape=other');
  });
  it('still renders the rule, judged from the text alone, when the detector facts are missing', () => {
    const out = renderSpecReviewSection({});
    expect(out).toContain(SECTION);
    expect(out).toContain('Detector facts: unavailable');
  });
  it('the acknowledged-rules section names the left-out rules, and is empty for none', () => {
    expect(renderAcknowledgedRulesSection(['B27_SPEC_REVIEW_UNLINKED', 'B2_FILE_PATH'])).toContain('Do NOT cite any of them');
    expect(renderAcknowledgedRulesSection([])).toBe('');
  });
});

describe('B27 in a review', () => {
  it('renders only when the route attached the context, whatever the text says', async () => {
    const { provider, last } = capture();
    const gate = new MessagingToneGate(provider);
    await gate.review('Morning. The build is green.', { channel: 'telegram', specReview: {} });
    expect(last()).toContain(SECTION);
    await gate.review(HANDOFF, { channel: 'telegram' });
    expect(last()).not.toContain(SECTION);
  });

  it('the prompt id carries -b27 exactly when B27 is rendered, after -b26, and -chain for a chain re-review', async () => {
    const { provider, lastOpts } = capture();
    const gate = new MessagingToneGate(provider);
    await gate.review(HANDOFF, { channel: 'telegram' });
    expect(lastOpts().provenance?.promptId).toBe(TONE_GATE_PROMPT_ID);
    await gate.review(HANDOFF, { channel: 'telegram', specReview: { facts: FACTS } });
    expect(lastOpts().provenance?.promptId).toBe(`${TONE_GATE_PROMPT_ID}${TONE_GATE_PROMPT_ID_B27_SUFFIX}`);
    await gate.review(HANDOFF, { channel: 'telegram', waitingAsk: {}, specReview: {} });
    expect(lastOpts().provenance?.promptId).toBe(`${TONE_GATE_PROMPT_ID}${TONE_GATE_PROMPT_ID_B26_SUFFIX}${TONE_GATE_PROMPT_ID_B27_SUFFIX}`);
    await gate.review(HANDOFF, { channel: 'telegram', omitRules: ['B27_SPEC_REVIEW_UNLINKED'] });
    expect(lastOpts().provenance?.promptId).toBe(`${TONE_GATE_PROMPT_ID}${TONE_GATE_PROMPT_ID_CHAIN_SUFFIX}`);
    expect(lastOpts().provenance?.context?.omittedRules).toEqual(['B27_SPEC_REVIEW_UNLINKED']);
  });

  it('a B27 citation where B27 was rendered is an advisory nudge', async () => {
    const { provider } = capture([{ pass: false, rule: 'B27_SPEC_REVIEW_UNLINKED', issue: 'No readable link.', suggestion: 'Publish it.' }]);
    const r = await new MessagingToneGate(provider).review(HANDOFF, { channel: 'telegram', specReview: { facts: FACTS } });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B27_SPEC_REVIEW_UNLINKED');
    expect(r.advisory).toBe(true);
    expect(r.strayCitation).toBeUndefined();
  });

  it('a B27 citation where it was NOT rendered is a stray citation: one retry, then the invalid-citation outcome, never a nudge', async () => {
    const stray = { pass: false, rule: 'B27_SPEC_REVIEW_UNLINKED', issue: 'x', suggestion: 'y' };
    const { provider, prompts } = capture([stray, stray]);
    const r = await new MessagingToneGate(provider).review(HANDOFF, { channel: 'telegram' });
    expect(prompts).toHaveLength(2);
    expect(r.advisory).not.toBe(true);
    expect(r.failedClosed).toBe(true);
    expect(r.strayCitation).toBe(true);
  });

  it('a stray citation followed by a valid hold keeps the hold (B25 stays reachable)', async () => {
    const { provider } = capture([
      { pass: false, rule: 'B27_SPEC_REVIEW_UNLINKED', issue: 'x', suggestion: 'y' },
      { pass: false, rule: 'B25_SPEC_APPROVAL_UNCHECKED', issue: 'No check result.', suggestion: 'Run the check.' },
    ]);
    const r = await new MessagingToneGate(provider).review(HANDOFF, { channel: 'telegram', omitRules: ['B27_SPEC_REVIEW_UNLINKED'] });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B25_SPEC_APPROVAL_UNCHECKED');
    expect(r.advisory).not.toBe(true);
    expect(r.strayCitation).toBe(true);
  });

  it('a rule an override chain left out is never accepted again (B2 cited after B2 was acknowledged)', async () => {
    const b2 = { pass: false, rule: 'B2_FILE_PATH', issue: 'path', suggestion: 'drop it' };
    const { provider, last } = capture([b2, b2]);
    const r = await new MessagingToneGate(provider).review(HANDOFF, { channel: 'telegram', omitRules: ['B27_SPEC_REVIEW_UNLINKED', 'B2_FILE_PATH'] });
    expect(last()).toContain('=== ALREADY ACKNOWLEDGED ON THIS TEXT ===');
    expect(r.strayCitation).toBe(true);
    expect(r.rule).not.toBe('B2_FILE_PATH');
  });
});

describe('B27 capture ceiling (enrolled agents only)', () => {
  const long = 'Ready for your review: docs/specs/a.md ' + 'x'.repeat(12_000) + ' https://echo.example.dev/docs/abc12345-c4e6-4636-b97f-2e6ea4e32af9';
  it('keeps the whole judged text up to B27_CAPTURE_MAX_CHARS when B27 capture is on', async () => {
    const { provider, lastOpts } = capture();
    await new MessagingToneGate(provider).review(long, { channel: 'email', specReview: { captureBody: true } });
    const ctx = lastOpts().provenance?.context as Record<string, any>;
    expect(ctx[CONTENT_FULL_KEY].candidateBody).toContain('/docs/abc12345');
    expect(ctx.candidate.bodyTruncated).toBe(false);
  });
  it('never exceeds the B27 ceiling, and every other call keeps the 4,000 limit', () => {
    const capped = buildToneDecisionContext('y'.repeat(B27_CAPTURE_MAX_CHARS + 50), { channel: 'telegram' }, { recordCandidateBody: true, maxBodyChars: 999_999, ceilingChars: 999_999 }) as Record<string, any>;
    expect((capped[CONTENT_FULL_KEY].candidateBody as string).length).toBe(B27_CAPTURE_MAX_CHARS);
    const plain = buildToneDecisionContext(long, { channel: 'telegram' }, { recordCandidateBody: true, maxBodyChars: 999_999 }) as Record<string, any>;
    expect((plain[CONTENT_FULL_KEY].candidateBody as string).length).toBe(TONE_CANDIDATE_BODY_MAX_CHARS);
    expect(plain.candidate.bodyTruncated).toBe(true);
  });
  it('captures nothing for an eligible review on an agent that is not enrolled', async () => {
    const { provider, lastOpts } = capture();
    await new MessagingToneGate(provider).review(long, { channel: 'telegram', specReview: {} });
    expect((lastOpts().provenance?.context as Record<string, any>)[CONTENT_FULL_KEY]).toBeUndefined();
  });
});
