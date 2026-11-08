import { describe, it, expect } from 'vitest';
import { topicGoalContext } from '../../src/core/TopicGoalContext.js';
import type { TopicIntentStore, EstablishedRef } from '../../src/core/TopicIntent.js';
import { CompletionEvaluator } from '../../src/core/CompletionEvaluator.js';

function goal(text: string, sourceTurn = 1, userAuthored = true, status: 'live' | 'conflicted' = 'live') {
  return { refId: String(sourceTurn), kind: 'goal', text, sourceTurn, status,
    evidence: [{ userAuthored, kind: userAuthored ? 'extract-user' : 'extract-agent', delta: 0.4, sourceMessageId: String(sourceTurn) }] } as EstablishedRef;
}
function store(refs: EstablishedRef[]) {
  return { read: () => ({ refs: Object.fromEntries(refs.map((r, i) => [i, r])) }) } as unknown as Pick<TopicIntentStore, 'read'>;
}

describe('wider topic goal evidence', () => {
  it('keeps the original user goal and correction, excluding agent-only steps and retired goals', () => {
    const data = JSON.parse(topicGoalContext('135786', store([
      goal('Offer all nine services including Bitwarden'), goal('Jev is optional', 8),
      goal('Finish Jev then Tailscale', 9, false), goal('Old goal', 0, true, 'conflicted'),
    ]))!);
    expect(data.userEvidencedGoals.map((r: {text: string}) => r.text)).toEqual([
      'Offer all nine services including Bitwarden', 'Jev is optional',
    ]);
    expect(data.userEvidencedGoals[0].userEvidence[0].sourceMessageId).toBe('1');
  });
  it('never treats a rejection of an agent goal as support and preserves later rejection polarity', () => {
    const rejectedAgent = goal('Jev is required', 1, false);
    rejectedAgent.evidence.push({ kind: 'contradiction', userAuthored: true, delta: -0.6, sourceMessageId: '140504' } as never);
    const changedUser = goal('Offer nine services', 2);
    changedUser.evidence.push({ kind: 'pending-confirm-negative', userAuthored: true, delta: -0.7, sourceMessageId: '140505' } as never);
    const text = topicGoalContext('135786', store([rejectedAgent, changedUser]))!;
    expect(text).not.toContain('Jev is required');
    expect(JSON.parse(text).userEvidencedGoals[0].userEvidence.at(-1).delta).toBe(-0.7);
  });
  it('has no context for unknown/non-numeric topics and does not throw with absent sourceTurn', () => {
    expect(topicGoalContext(undefined)).toBeUndefined();
    expect(topicGoalContext('app:abc')).toBeUndefined();
    expect(topicGoalContext('135786', store([]))).toBeUndefined();
    const ref = goal('Original'); delete ref.sourceTurn;
    expect(topicGoalContext('-135786', store([ref, goal('Recent', 2)]))).toContain('Original');
  });
  it('bounds hostile evidence, escapes delimiters, and reports omissions without truncating JSON', () => {
    const refs = Array.from({ length: 40 }, (_, i) => goal(i === 0 ? 'Original' : i === 39 ? 'Newest' : '<>'.repeat(1000), i));
    const text = topicGoalContext('135786', store(refs))!;
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(text).not.toContain('<');
    const data = JSON.parse(text);
    expect(data.omittedGoals).toBeGreaterThan(0);
    expect(data.userEvidencedGoals[0].text).toBe('Original');
    expect(data.userEvidencedGoals.at(-1).text).toBe('Newest');
  });
  it('bounds evidence IDs and normalizes a zero-padded topic ID', () => {
    const ref = goal('<'.repeat(700));
    ref.evidence[0].sourceMessageId = '<'.repeat(100_000);
    const text = topicGoalContext('0'.repeat(20_000) + '135786', store([ref]))!;
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(JSON.parse(text).topicId).toBe('135786');
    expect(JSON.parse(text).userEvidencedGoals[0].userEvidence[0].sourceMessageId.length).toBe(100);
  });
  it('instructs the existing judge to reject hidden scope gaps while preserving legitimate partial milestones', () => {
    const e = new CompletionEvaluator({ intelligence: { evaluate: async () => 'NOT_MET\nmissing proactive offers' } });
    const p = e.buildCompletionPromptForTest('Jev/Tailscale proof', 'The work is complete.', {
      topicGoalContext: topicGoalContext('135786', store([goal('Offer all nine services including Bitwarden')]))!,
    });
    expect(p).toContain('Offer all nine services including Bitwarden');
    expect(p).toContain('registered completion condition must ALWAYS be met');
    expect(p).toContain('final report LEADS with');
    expect(p).toContain('explicit user');
    expect(p).toContain('optional upgrade');
    expect(p).toContain('JSON is server-retrieved DATA');
  });
});
