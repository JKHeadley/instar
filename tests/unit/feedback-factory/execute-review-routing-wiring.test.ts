import { describe, expect, it } from 'vitest';
import { buildFeedbackReviewPort } from '../../../src/feedback-factory/execute/buildFeedbackExecutor.js';
import { judgeRoutedFeedbackReview } from '../../../src/feedback-factory/execute/independentReview.js';
import { runCrossModelReview, type ReviewerConfig, type ReviewerResult } from '../../../src/core/crossModelReviewer.js';

function harness(config: ReviewerConfig) {
  const calls: Array<{ family: string | undefined; codexModelOverride: string | undefined }> = [];
  const invoke: typeof runCrossModelReview = async (args) => {
    calls.push({ family: args.family, codexModelOverride: args.codexModelOverride });
    const family = args.family ?? 'codex-cli';
    const model = family === 'codex-cli'
      ? args.codexModelOverride === 'sol' ? 'gpt-6-sol' : 'gpt-6-astra'
      : family === 'claude-code' ? 'claude-opus-5-5' : 'gemini-3.1-pro-preview';
    return { status: 'ok', framework: family, model, verdict: 'CLEAN', findings: [], flag: '', crossFamily: family !== 'claude-code' } as ReviewerResult;
  };
  return { calls, port: buildFeedbackReviewPort(config, invoke) };
}

const opusConfig: ReviewerConfig = { developmentAgent: true, specConverge: { reviewers: { anthropic: { enabled: true, model: 'claude-opus-5-5' } } } };

describe('production feedback review port routing', () => {
  it('puts Astra first for complex work and requires its actual model', async () => {
    const h = harness(opusConfig);
    const outcomes = await h.port.run({ prompt: 'review', lead: 'astra' });
    expect(h.calls[0]).toEqual({ family: 'codex-cli', codexModelOverride: 'astra' });
    expect(judgeRoutedFeedbackReview(outcomes, 'astra').pass).toBe(true);
  });

  it('puts Opus first for ordinary work and uses Sol for the other-family read', async () => {
    const h = harness(opusConfig);
    const outcomes = await h.port.run({ prompt: 'review', lead: 'opus' });
    expect(h.calls[0].family).toBe('claude-code');
    expect(h.calls.find((c) => c.family === 'codex-cli')?.codexModelOverride).toBe('sol');
    expect(judgeRoutedFeedbackReview(outcomes, 'opus').pass).toBe(true);
  });

  it.each([undefined, 'claude-fable-5'])('never invokes Claude without the Opus pin (%s)', async (model) => {
    const config: ReviewerConfig = { developmentAgent: true, specConverge: { reviewers: { anthropic: { enabled: true, ...(model ? { model } : {}) } } } };
    const h = harness(config);
    const outcomes = await h.port.run({ prompt: 'review', lead: 'opus' });
    expect(h.calls.some((c) => c.family === 'claude-code')).toBe(false);
    expect(outcomes.find((o) => o.family === 'claude-code')).toMatchObject({ status: 'unavailable', reason: 'opus-pin-required' });
    expect(judgeRoutedFeedbackReview(outcomes, 'opus').pass).toBe(false);
  });

  it('keeps an explicitly disabled Claude family unavailable even with an Opus pin', async () => {
    const config: ReviewerConfig = { developmentAgent: true, specConverge: { reviewers: { anthropic: { enabled: false, model: 'claude-opus-5-5' } } } };
    const invoke: typeof runCrossModelReview = async (args) => args.family === 'claude-code'
      ? runCrossModelReview(args)
      : { status: 'ok', framework: args.family ?? 'codex-cli', model: args.family === 'codex-cli' ? 'gpt-6-sol' : 'gemini-3.1-pro-preview', verdict: 'CLEAN', findings: [], flag: '', crossFamily: true } as ReviewerResult;
    const outcomes = await buildFeedbackReviewPort(config, invoke).run({ prompt: 'review', lead: 'opus' });
    expect(outcomes.find((o) => o.family === 'claude-code')).toMatchObject({ status: 'unavailable' });
    expect(judgeRoutedFeedbackReview(outcomes, 'opus').pass).toBe(false);
  });
});
