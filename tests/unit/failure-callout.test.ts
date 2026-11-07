import { describe, it, expect } from 'vitest';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { advanceFailureCase, newFailureCase } from '../../src/monitoring/FailureCallout.js';
import { CaptureRing, captureAndDistill, parseDistillEnvelope } from '../../src/monitoring/CorrectionCaptureLoop.js';
import { buildClassReviewPrompt } from '../../src/monitoring/CorrectionClassReview.js';

const context = { turns: [{ text: 'Please create the group yourself', fromUser: false, at: 1 }, { text: 'You handed my task back to me', fromUser: true, at: 2 }], instructions: ['Agent owns setup'], decisions: ['Approval preceded brief restriction'], sourceRefs: ['telegram:135786:139231'], missing: [] };
const investigation = { classification: 'enforcement-gap', standardRefs: ['The Person Decides'], rootCause: 'Agent-authored restriction was treated as operator prohibition', classFix: 'Review restriction provenance before handing back agent work', fixRefs: ['src/core/MessagingToneGate.ts'] };
const verification = { scenario: 'approved group setup', baselineRef: 'message:139229', replayRef: 'replay-output', allowedCaseRef: 'credential-request-output', replayPassed: true, allowedCasePassed: true };

describe('failure-callout closure discipline', () => {
  it('requires complete evidence, class fix and both replay outcomes', () => {
    const captured = newFailureCase(context);
    expect(() => advanceFailureCase(captured, { verification })).toThrow('investigation required');
    expect(() => advanceFailureCase(captured, { investigation: { ...investigation, classification: 'oops' } })).toThrow('classification');
    const diagnosed = advanceFailureCase(captured, { investigation });
    expect(diagnosed.state).toBe('investigated');
    expect(() => advanceFailureCase(diagnosed, { verification: { ...verification, replayPassed: false } })).toThrow('verification requires');
    expect(() => advanceFailureCase(diagnosed, { verification: { ...verification, allowedCasePassed: false } })).toThrow('verification requires');
    expect(advanceFailureCase(diagnosed, { verification }).state).toBe('verified');
    expect(advanceFailureCase(captured, { investigation: { ...investigation, classification: 'constitution-gap' } }).investigation?.classification).toBe('constitution-gap');
  });

  it('preserves an early diagnosis and proposed fix while evidence or ratification is pending', () => {
    const captured = newFailureCase({ ...context, missing: ['helper brief'] });
    const diagnosed = advanceFailureCase(captured, {
      investigation: { ...investigation, classification: 'constitution-gap', fixRefs: [] },
    });
    expect(diagnosed.state).toBe('investigated');
    expect(diagnosed.investigation?.fixRefs).toEqual([]);
    expect(diagnosed.context.missing).toEqual(['helper brief']);
    expect(() => advanceFailureCase(diagnosed, { verification })).toThrow('complete the context');

    const complete = advanceFailureCase(diagnosed, {
      context,
      investigation: { ...investigation, fixRefs: [] },
    });
    expect(() => advanceFailureCase(complete, { verification })).toThrow('implemented class fix');
    const fixed = advanceFailureCase(complete, { investigation });
    expect(advanceFailureCase(fixed, { verification }).state).toBe('verified');
  });

  it.each([
    { name: 'no turns', turns: [] },
    { name: 'only the complaint', turns: context.turns.filter(t => t.fromUser) },
    { name: 'only the failing reply', turns: context.turns.filter(t => !t.fromUser) },
    { name: 'blank failing reply', turns: [context.turns[1], { text: '  ', fromUser: false, at: 3 }] },
    { name: 'blank complaint', turns: [context.turns[0], { text: '  ', fromUser: true, at: 3 }] },
  ])('keeps diagnosis open with $name', ({ turns }) => {
    const diagnosed = advanceFailureCase(newFailureCase({ ...context, turns }), { investigation });
    expect(diagnosed.state).toBe('investigated');
    expect(() => advanceFailureCase(diagnosed, { verification })).toThrow('failing reply and user callout');
  });

  it('rejects malformed update types without changing the existing evidence', () => {
    const captured = newFailureCase(context);
    const before = structuredClone(captured);
    for (const value of [null, [], 'context', 5]) {
      expect(() => advanceFailureCase(captured, { context: value })).toThrow('context must be an object');
    }
    for (const value of [null, 'missing source', [1]]) {
      expect(() => advanceFailureCase(captured, { context: { ...context, missing: value } })).toThrow('array of strings');
    }
    for (const turns of ['message', [{ text: 5, fromUser: true }], [{ text: 'reply', fromUser: 'false' }], [{ text: 'reply', fromUser: false, at: 'today' }]]) {
      expect(() => advanceFailureCase(captured, { context: { ...context, turns } })).toThrow('context.turns');
    }
    expect(() => advanceFailureCase(captured, { investigation: { ...investigation, fixRefs: 'PR-1' } })).toThrow('array of strings');
    expect(() => advanceFailureCase(captured, { investigation: { ...investigation, standardRefs: [null] } })).toThrow('array of strings');
    const diagnosed = advanceFailureCase(captured, { investigation });
    for (const value of [null, [], 'passed']) {
      expect(() => advanceFailureCase(diagnosed, { verification: value })).toThrow('verification evidence required');
    }
    expect(() => advanceFailureCase(diagnosed, { verification: { ...verification, replayPassed: 'true' } })).toThrow('verification requires');
    expect(captured).toEqual(before);
  });

  it.each([
    { name: 'old turns', field: 'context.turns', evidence: { turns: Array(13).fill(context.turns[0]).concat(context.turns) } },
    { name: 'turn text', field: 'context.turns.text', evidence: { turns: [{ ...context.turns[0], text: 'x'.repeat(4001) }, context.turns[1]] } },
    { name: 'instructions', field: 'context.instructions', evidence: { instructions: ['x'.repeat(4001)] } },
    { name: 'decisions', field: 'context.decisions', evidence: { decisions: Array(21).fill('decision') } },
    { name: 'source references', field: 'context.sourceRefs', evidence: { sourceRefs: Array(21).fill('source') } },
    { name: 'missing entries', field: 'context.missing', evidence: { missing: Array(20).fill('').concat('unavailable source') } },
  ])('discloses truncation of $name and refuses verification until resolved', ({ field, evidence }) => {
    const captured = newFailureCase({ ...context, ...evidence });
    expect(captured.context.missing).toEqual(expect.arrayContaining([expect.stringContaining(`Evidence truncated in ${field};`)]));
    const diagnosed = advanceFailureCase(captured, { investigation });
    expect(() => advanceFailureCase(diagnosed, { verification })).toThrow('resolve missing evidence');
    // The investigator explicitly replaces the partial excerpt with bounded,
    // resolved evidence plus exact references to the original full artifact.
    const resolved = advanceFailureCase(diagnosed, { context, investigation });
    expect(advanceFailureCase(resolved, { verification }).state).toBe('verified');
  });

  it('keeps truncation warnings through repeated scrubbing and diagnosis updates', () => {
    const captured = newFailureCase({ ...context, instructions: Array(21).fill('instruction'), missing: Array(20).fill('missing evidence') });
    const scrubbedAgain = newFailureCase(captured.context);
    expect(scrubbedAgain.context.missing.join(' ')).toContain('Evidence truncated in context.instructions;');
    const diagnosed = advanceFailureCase(newFailureCase(context), { investigation: { ...investigation, rootCause: 'x'.repeat(4001) } });
    expect(diagnosed.context.missing.join(' ')).toContain('Evidence truncated in investigation.rootCause;');
    expect(() => advanceFailureCase(diagnosed, { verification })).toThrow('resolve missing evidence');
    const complete = advanceFailureCase(newFailureCase(context), { investigation });
    expect(() => advanceFailureCase(complete, { verification: { ...verification, replayRef: 'x'.repeat(4001) } })).toThrow('verification evidence exceeds bounds');
  });

  it('scrubs context before storage, bounds it, omits it from lists and reopens repeats', () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'failure-test' });
    try {
      const input = { kind: 'infra-gap' as const, severity: 'failure-callout' as const, learning: 'agent tasks stay agent owned', scrubbedSummary: 'handed work back', deterministicWeight: 3, failureContext: { ...context, instructions: ['token=abcdefghijklmnop'] } };
      const first = ledger.record(input)!;
      expect(JSON.stringify(first)).not.toContain('abcdefghijklmnop');
      expect(CorrectionLedger.toApiView(first, false).failureCase).toBeUndefined();
      let result = ledger.updateFailureCase(first.id, { investigation }, first.version);
      expect(result.ok).toBe(true); if (!result.ok) return;
      result = ledger.updateFailureCase(first.id, { verification }, result.record.version);
      expect(result.ok).toBe(true);
      expect(ledger.updateFailureCase(first.id, { verification }, first.version)).toMatchObject({ conflict: true });
      const repeat = ledger.record(input)!;
      expect(repeat.failureCase?.state).toBe('reopened');
      expect(repeat.failureCase?.verification).toBeUndefined();
      expect(repeat.failureCase?.history?.at(-1)?.verification).toEqual(verification);
      expect(ledger.list({ unresolvedFailures: true })).toHaveLength(1);
      expect(ledger.list({ severity: 'failure-callout' })).toHaveLength(1);
      for (let n = 0; n < 8; n++) ledger.record(input);
      expect(ledger.get(first.id)?.failureCase?.history).toHaveLength(5);
      const archived = ledger.listFailureEpisodes(first.id);
      expect(archived).toHaveLength(12);
      expect(archived.find(entry => entry.version === 3)?.episode.verification).toEqual(verification);
      expect(archived.at(-1)?.episode.state).toBe('captured');
      expect(archived.every(entry => !('history' in entry.episode))).toBe(true);
      const firstPage = ledger.listFailureEpisodes(first.id, undefined, 3);
      const nextPage = ledger.listFailureEpisodes(first.id, firstPage.at(-1)!.version, 3);
      expect(nextPage[0].version).toBeLessThan(firstPage.at(-1)!.version);
      expect(ledger.updateFailureCase(first.id, { investigation }, first.version)).toMatchObject({ conflict: true });
      expect(ledger.listFailureEpisodes(first.id)).toEqual(archived);
      expect(newFailureCase({ turns: Array(50).fill({ text: 'x'.repeat(10000), fromUser: true }) }).context.turns).toHaveLength(12);
    } finally { ledger.close(); }
  });

  it('captures serious callouts through the real capture seam and feeds review context', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'capture' });
    try {
      const ring = new CaptureRing({ captureContextTurns: 8, captureTopicMapMax: 3, topicTtlMs: 60000 });
      ring.push(1, { text: 'Please create the group yourself', fromUser: false, at: 1 });
      await captureAndDistill({ ring, ledger, distill: async () => JSON.stringify({ learning: 'Do the approved setup', kind: 'infra-gap', severity: 'failure-callout', llm_confidence: 1, scrubbed_summary: 'Agent handed setup back' }) }, { topicId: 1, text: 'Why are you making me do your work?', fromUser: true, deterministicWeight: 3, isLearningSignal: true });
      const record = ledger.list()[0];
      expect(record.severity).toBe('failure-callout');
      expect(record.failureCase?.context.turns).toHaveLength(2);
      expect(buildClassReviewPrompt(record.scrubbedSummary, [], [], record.failureCase)).toContain('Please create the group yourself');
      expect(record.failureCase?.context.missing).toContain('instructions');
      expect(parseDistillEnvelope('{"learning":"Use shorter replies","kind":"user-preference","llm_confidence":1}')).toMatchObject({ severity: 'correction' });
    } finally { ledger.close(); }
  });
});
