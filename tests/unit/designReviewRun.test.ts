import { describe, expect, it, vi } from 'vitest';
import { runRecordedDesignReview, claudeFallbackReviewModel } from '../../src/core/designReviewRun.js';
import {
  claudeHardeningPreflight,
  classifyReviewFailure,
  __resetClaudeHardeningPreflightCache,
  type ReviewerResult,
} from '../../src/core/crossModelReviewer.js';

const assembled = { promptText: 'review this', truncated: false } as never;
const available = (framework: string, model: string) => ({ available: true, framework, model, crossFamily: framework !== 'claude-code' }) as never;
const detectAll = (id: string) =>
  id === 'claude-code' ? available(id, 'claude-fable-5-2')
    : id === 'codex-cli' ? available(id, 'gpt-6-astra')
      : id === 'gemini-cli' ? available(id, 'gemini-3.1-pro-preview')
        : available(id, 'grok-4.6');
const ok = (framework: string, model: string, verdict: ReviewerResult['verdict'] = 'CLEAN'): ReviewerResult => ({ status: 'ok', framework: framework as never, model, verdict, flag: 'x', findings: [{ reviewer: framework, verdict: verdict ?? 'CLEAN', text: 'finding text' } as never] });
const degraded = (framework: string, model: string, reason: string): ReviewerResult => ({ status: 'degraded', framework: framework as never, model, reason, flag: 'x' });

const DEV = { developmentAgent: true, enabledFrameworks: ['claude-code', 'codex-cli'] };

describe('runRecordedDesignReview', () => {
  it('a live secret stops the whole run before anything is sent', async () => {
    const review = vi.fn();
    const out = await runRecordedDesignReview({ text: 'token: ghp_' + 'a'.repeat(36), assembled, config: DEV, review: review as never, detectFor: detectAll });
    expect(out.ok).toBe(false);
    expect(review).not.toHaveBeenCalled();
  });

  it('attempts every family: same door on the design model, enabled outside family on its lane, others disabled', async () => {
    const review = vi.fn(async (a: any) => ok(a.family, a.detectionOverride.model));
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: DEV, review: review as never, detectFor: detectAll });
    if (!out.ok) throw new Error('refused');
    const by = Object.fromEntries(out.passes.map((p) => [p.family, p]));
    expect(by.claude).toMatchObject({ status: 'ok', model: 'claude-fable-5-2', attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'ok' }], verdict: 'CLEAN' });
    expect(by.codex).toMatchObject({ status: 'ok', model: 'gpt-6-astra' });
    // Signed in on the machine but not one of the agent's frameworks (decision 10).
    expect(by.gemini).toMatchObject({ status: 'unavailable', reason: 'disabled', attempts: [] });
    expect(by.grok).toMatchObject({ status: 'unavailable', reason: 'disabled' });
    expect(out.runId).toMatch(/^[0-9a-f]{32}$/);
    // The reviewers' own findings come back for the session to act on (never recorded).
    expect(out.findings.map((f) => f.family).sort()).toEqual(['claude', 'codex']);
    // The same-door pass forces the design model even over a configured override.
    const claudeCall = review.mock.calls.find((c: any) => c[0].family === 'claude-code')![0] as any;
    expect(claudeCall.config.specConverge.reviewers.anthropic).toMatchObject({ enabled: true, model: 'claude-fable-5-2' });
  });

  it('asks for the design model whatever the reviewer-model override says', async () => {
    const review = vi.fn(async (a: any) => ok(a.family, a.config?.specConverge?.reviewers?.anthropic?.model ?? a.detectionOverride.model));
    const cfg = { ...DEV, specConverge: { reviewers: { anthropic: { model: 'claude-opus-5-5' } } } };
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: cfg, review: review as never, detectFor: detectAll });
    if (!out.ok) throw new Error('refused');
    expect(out.passes.find((p) => p.family === 'claude')!.model).toBe('claude-fable-5-2');
  });

  it('a refused design model falls back once to the door default; the refusal stays on record', async () => {
    const review = vi.fn(async (a: any) => {
      const m = a.config?.specConverge?.reviewers?.anthropic?.model;
      if (a.family === 'claude-code') return m === 'claude-fable-5-2' ? degraded(a.family, m, 'model-not-on-plan') : ok(a.family, m, 'MINOR ISSUES');
      return ok(a.family, a.detectionOverride.model);
    });
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: { ...DEV, sessions: { frameworkDefaultModels: { 'claude-code': 'claude-opus-5-5' } } }, review: review as never, detectFor: detectAll });
    if (!out.ok) throw new Error('refused');
    const claude = out.passes.find((p) => p.family === 'claude')!;
    expect(claude.attempts).toEqual([
      { askedModel: 'claude-fable-5-2', outcome: 'refused', reason: 'not-on-plan' },
      { askedModel: 'claude-opus-5-5', outcome: 'ok' },
    ]);
    expect(claude).toMatchObject({ status: 'ok', model: 'claude-opus-5-5', verdict: 'MINOR ISSUES' });
  });

  it('a transient failure is not a refusal: no fallback, the pass is degraded with the reason', async () => {
    const review = vi.fn(async (a: any) => a.family === 'claude-code' ? degraded(a.family, 'claude-fable-5-2', 'timeout') : ok(a.family, a.detectionOverride.model));
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: DEV, review: review as never, detectFor: detectAll });
    if (!out.ok) throw new Error('refused');
    const claude = out.passes.find((p) => p.family === 'claude')!;
    expect(claude).toMatchObject({ status: 'degraded', reason: 'timed-out', attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'failed', reason: 'timed-out' }] });
    expect(review.mock.calls.filter((c: any) => c[0].family === 'claude-code')).toHaveLength(1);
  });

  it('a family that is not installed gets a row with the durable reason', async () => {
    const review = vi.fn(async (a: any) => ok(a.family, a.detectionOverride.model));
    const detect = (id: string) => id === 'codex-cli' ? ({ available: false, reason: 'codex-not-installed' } as never) : detectAll(id);
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: DEV, review: review as never, detectFor: detect });
    if (!out.ok) throw new Error('refused');
    expect(out.passes.find((p) => p.family === 'codex')).toMatchObject({ status: 'unavailable', reason: 'not-installed' });
  });

  it('standard off (fleet): the Claude family keeps its existing gating; explicit off is honoured where on', async () => {
    const review = vi.fn(async (a: any) => ok(a.family, a.detectionOverride.model));
    const fleet = await runRecordedDesignReview({ text: 'plan', assembled, config: { enabledFrameworks: ['claude-code'] }, review: review as never, detectFor: detectAll });
    if (!fleet.ok) throw new Error('refused');
    expect(fleet.passes.find((p) => p.family === 'claude')).toMatchObject({ status: 'unavailable', reason: 'disabled' });
    const off = await runRecordedDesignReview({ text: 'plan', assembled, config: { ...DEV, specConverge: { reviewers: { anthropic: { enabled: false } } } }, review: review as never, detectFor: detectAll });
    if (!off.ok) throw new Error('refused');
    expect(off.passes.find((p) => p.family === 'claude')).toMatchObject({ status: 'unavailable', reason: 'disabled' });
  });

  it('an unknown module reason is transient and reported as unmapped', async () => {
    const review = vi.fn(async (a: any) => a.family === 'codex-cli' ? degraded(a.family, 'gpt-6-astra', 'brand-new-thing') : ok(a.family, a.detectionOverride.model));
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: DEV, review: review as never, detectFor: detectAll });
    if (!out.ok) throw new Error('refused');
    expect(out.passes.find((p) => p.family === 'codex')).toMatchObject({ status: 'degraded', reason: 'call-failed' });
    expect(out.unmappedReasons).toEqual(['brand-new-thing']);
  });

  it('a reviewer that throws cannot fail the run', async () => {
    const review = vi.fn(async (a: any) => { if (a.family === 'codex-cli') throw new Error('boom'); return ok(a.family, a.detectionOverride.model); });
    const out = await runRecordedDesignReview({ text: 'plan', assembled, config: DEV, review: review as never, detectFor: detectAll });
    if (!out.ok) throw new Error('refused');
    expect(out.passes.find((p) => p.family === 'codex')).toMatchObject({ status: 'degraded', reason: 'call-failed' });
  });
});

describe('claudeFallbackReviewModel', () => {
  it('uses the configured default when it is an accepted concrete id, else the door fallback', () => {
    expect(claudeFallbackReviewModel({ sessions: { frameworkDefaultModels: { 'claude-code': 'claude-opus-5-5' } } }, 'claude-fable-5-2')).toBe('claude-opus-5-5');
    expect(claudeFallbackReviewModel({ sessions: { frameworkDefaultModels: { 'claude-code': 'opus' } } }, 'claude-fable-5-2')).toBe('claude-opus-5-5');
    expect(claudeFallbackReviewModel({ sessions: { frameworkDefaultModels: { 'claude-code': 'claude-fable-5-2' } } }, 'claude-fable-5-2')).toBe('claude-opus-5-5');
  });
});

describe('reviewer module changes', () => {
  it('a hardening probe that cannot run is inconclusive and is not cached', () => {
    __resetClaudeHardeningPreflightCache();
    expect(claudeHardeningPreflight('/nonexistent/claude-binary-for-test')).toBe('inconclusive');
    expect(claudeHardeningPreflight('/nonexistent/claude-binary-for-test')).toBe('inconclusive');
    __resetClaudeHardeningPreflightCache();
  });

  it('classifies a provider refusing the requested model as not on the plan', () => {
    expect(classifyReviewFailure(new Error("There's an issue with the selected model (claude-fable-5-2). It may not exist or you may not have access to it."))).toBe('model-not-on-plan');
    expect(classifyReviewFailure(new Error("400 The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."))).toBe('model-not-on-plan');
    expect(classifyReviewFailure(new Error('ModelNotFoundError: gemini-4-argon'))).toBe('model-not-on-plan');
    expect(classifyReviewFailure(new Error('429 Too Many Requests'))).toBe('rate-limited');
    expect(classifyReviewFailure(new Error('something else broke'))).toBe('error');
  });
});
