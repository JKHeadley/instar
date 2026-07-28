/**
 * Tier 1 — TopicIntentExtractor's provenance enrollment (§5.1.4/§5.6).
 *
 * ~733 calls/7d: the highest-volume unenrolled point remaining after the stop
 * gate, and the second half of the census task's "enrol the highest-volume
 * scenarios".
 *
 * The contract defended here is CONTENT-BEARING. This extractor reads a raw
 * conversation turn AND a rolling conversational summary — both untrusted, both
 * arbitrary user content. Neither may enter the provenance row. The context is
 * an explicit allowlist of derived values rather than a filtered copy, so a
 * future field on ExtractorInput cannot leak by default.
 *
 * Enrollment must also stay observability-only: it cannot alter the extraction,
 * and it must not break the extractor's degrade-safe "return []" guarantee.
 */
import { describe, it, expect, vi } from 'vitest';
import { createLlmExtractFn } from '../../src/core/TopicIntentExtractor.js';
import { DP_TOPIC_INTENT_EXTRACT, PROVENANCE_COVERAGE } from '../../src/data/provenanceCoverage.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const SECRET_MSG = 'deploy with the key sk-live-topicintent999 and my password is hunter2';
const SECRET_SUMMARY = 'earlier the user pasted /Users/justin/private/keys.env and a token ghp_abc123';

function capturing() {
  const calls: any[] = [];
  const provider = {
    evaluate: vi.fn(async (_p: string, opts?: any) => {
      calls.push(opts);
      return JSON.stringify({ proposals: [] });
    }),
  } as unknown as IntelligenceProvider;
  return { provider, calls };
}

const input = {
  topicId: 33368,
  arcId: 'arc-1',
  message: {
    id: 'msg-7',
    text: SECRET_MSG,
    fromUser: true,
    turn: 12,
    at: '2026-07-25T17:00:00.000Z',
  },
  existingRefs: [{ refId: 'r1' }, { refId: 'r2' }, { refId: 'r3' }],
  rollingSummary: SECRET_SUMMARY,
} as any;

describe('the enrollment is present and typed', () => {
  it('the census declares this point WIRED with a valve and content class', () => {
    const e = PROVENANCE_COVERAGE.find((x) => x.decisionPoint === DP_TOPIC_INTENT_EXTRACT);
    expect(e, 'the decision point must be in the census').toBeDefined();
    expect(e!.status).toBe('wired');
    expect(e!.volumeClass).toBe('budget:200');
    expect(e!.contentClass).toBe('content-bearing');
  });

  it('declares measurement-only ON PURPOSE, with a real argument', () => {
    const e = PROVENANCE_COVERAGE.find((x) => x.decisionPoint === DP_TOPIC_INTENT_EXTRACT)!;
    expect(e.gradingPosture).toBe('measurement-only');
    expect((e.gradingReason ?? '').length).toBeGreaterThanOrEqual(40);
  });

  it('passes a provenance block naming the typed decision point', async () => {
    const { provider, calls } = capturing();
    await createLlmExtractFn(provider)(input);
    expect(calls).toHaveLength(1);
    expect(calls[0].provenance?.decisionPoint).toBe(DP_TOPIC_INTENT_EXTRACT);
    expect(calls[0].provenance?.optionsPresented).toEqual([
      'new-ref',
      'reref',
      'affirm',
      'contradict',
    ]);
  });
});

describe('IDENTITY ONLY — the turn and the summary never enter the row', () => {
  it('does not carry the message text, in whole or in fragment', async () => {
    const { provider, calls } = capturing();
    await createLlmExtractFn(provider)(input);
    const ser = JSON.stringify(calls[0].provenance?.context ?? {});

    expect(ser).not.toContain(SECRET_MSG);
    expect(ser).not.toContain('sk-live-topicintent999');
    expect(ser).not.toContain('hunter2');
  });

  it('does not carry the rolling summary — the bigger leak surface', async () => {
    // The summary spans many turns, so leaking it would republish far more than
    // the message that triggered the call.
    const { provider, calls } = capturing();
    await createLlmExtractFn(provider)(input);
    const ser = JSON.stringify(calls[0].provenance?.context ?? {});

    expect(ser).not.toContain(SECRET_SUMMARY);
    expect(ser).not.toContain('/Users/justin/private/keys.env');
    expect(ser).not.toContain('ghp_abc123');
  });

  it('carries the identity and shape a later reader needs', async () => {
    const { provider, calls } = capturing();
    await createLlmExtractFn(provider)(input);
    const ctx = calls[0].provenance.context as Record<string, unknown>;

    expect(String(ctx.messageSha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.messageChars).toBe(SECRET_MSG.length);
    expect(ctx.topicId).toBe(33368);
    expect(ctx.messageId).toBe('msg-7');
    expect(ctx.fromUser).toBe(true);
    expect(ctx.turn).toBe(12);
    expect(ctx.existingRefCount).toBe(3);
    // Presence and size of the summary, never its content.
    expect(ctx.hasRollingSummary).toBe(true);
    expect(ctx.rollingSummaryChars).toBe(SECRET_SUMMARY.length);
  });

  it('the hash distinguishes two different messages', async () => {
    const a = capturing();
    await createLlmExtractFn(a.provider)(input);
    const b = capturing();
    await createLlmExtractFn(b.provider)({
      ...input,
      message: { ...input.message, text: 'something else entirely' },
    });
    expect(a.calls[0].provenance.context.messageSha256).not.toBe(
      b.calls[0].provenance.context.messageSha256,
    );
  });

  it('handles an absent rolling summary without inventing one', async () => {
    const { provider, calls } = capturing();
    await createLlmExtractFn(provider)({ ...input, rollingSummary: undefined });
    const ctx = calls[0].provenance.context as Record<string, unknown>;
    expect(ctx.hasRollingSummary).toBe(false);
    expect(ctx.rollingSummaryChars).toBe(0);
  });
});

describe('observability only — degrade-safety is preserved', () => {
  it('keeps attribution alongside the new block', async () => {
    // Losing attribution would silently drop this component from the cost surface.
    const { provider, calls } = capturing();
    await createLlmExtractFn(provider)(input);
    expect(calls[0].attribution?.component).toBe('TopicIntentExtractor');
    expect(calls[0].provenance).toBeDefined();
  });

  it('a provider failure still degrades to [] rather than throwing', async () => {
    // The extractor's core guarantee: it never breaks the conversation path it
    // is attached to. Enrollment must not put a throw in front of that.
    const provider = {
      evaluate: vi.fn(async () => {
        throw new Error('provider down');
      }),
    } as unknown as IntelligenceProvider;
    const onDegrade = vi.fn();
    const out = await createLlmExtractFn(provider, onDegrade)(input);
    expect(out).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith('error', 33368);
  });

  it('no provider at all still degrades to [] and never builds a row', async () => {
    const onDegrade = vi.fn();
    const out = await createLlmExtractFn(undefined, onDegrade)(input);
    expect(out).toEqual([]);
    expect(onDegrade).toHaveBeenCalledWith('no-intelligence', 33368);
  });
});
