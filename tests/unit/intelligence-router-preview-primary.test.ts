/**
 * IntelligenceRouter.previewPrimary — the read-only preview the readiness authority
 * proposal uses. The property that matters: the preview names the SAME (framework, model)
 * the real evaluate() call reports through onModel for the same attribution, in each
 * routing mode (category, enforced nature plan, dryRun nature plan, unavailable route).
 */
import { describe, it, expect } from 'vitest';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';

const ARBITER = { component: 'FeedbackReadinessArbiter', category: 'gate' as const, nature: 'B', injectionExposed: true, model: 'capable' };

function reporting(framework: IntelligenceFramework): IntelligenceProvider {
  return {
    evaluate: async (_prompt: string, options?: IntelligenceOptions) => {
      options?.onModel?.({ model: String(options?.model ?? ''), framework });
      return '{}';
    },
  };
}

async function realCall(router: IntelligenceRouter): Promise<{ model: string; framework?: string } | null> {
  let seen: { model: string; framework?: string } | null = null;
  await router.evaluate('p', {
    model: 'capable',
    attribution: { component: ARBITER.component, category: 'gate', gating: true, nature: 'B', injectionExposed: true },
    onModel: (info) => { seen = info; },
  } as IntelligenceOptions);
  return seen;
}

function router(opts: { nature?: { enabled: boolean; dryRun: boolean }; built?: Partial<Record<IntelligenceFramework, IntelligenceProvider>>; cfg?: object }) {
  return new IntelligenceRouter({
    defaultProvider: reporting('claude-code'),
    defaultFramework: 'claude-code',
    resolveConfig: () => opts.cfg as never,
    buildProvider: (fw) => opts.built?.[fw] ?? null,
    resolveNatureRouting: opts.nature ? () => opts.nature : undefined,
  });
}

describe('previewPrimary matches the real primary selection', () => {
  it('no nature routing, unconfigured → default framework with the caller hint', async () => {
    const r = router({});
    expect(r.previewPrimary(ARBITER.component, ARBITER)).toEqual({ framework: 'claude-code', model: 'capable', source: 'category' });
    expect(await realCall(r)).toEqual({ model: 'capable', framework: 'claude-code' });
  });

  it('category override to codex-cli → codex-cli (the live Studio legacy view)', async () => {
    const r = router({ cfg: { overrides: { FeedbackReadinessArbiter: 'codex-cli' } }, built: { 'codex-cli': reporting('codex-cli') } });
    expect(r.previewPrimary(ARBITER.component, ARBITER)?.framework).toBe('codex-cli');
    expect((await realCall(r))?.framework).toBe('codex-cli');
  });

  it('ENFORCED nature routing → the plan primary door + its concrete model id, same as evaluate()', async () => {
    const r = router({ nature: { enabled: true, dryRun: false }, built: { 'codex-cli': reporting('codex-cli') } });
    const preview = r.previewPrimary(ARBITER.component, ARBITER);
    expect(preview?.source).toBe('nature-route');
    const real = await realCall(r);
    expect(real).toEqual({ model: preview?.model, framework: preview?.framework });
  });

  it('dryRun nature routing only observes → the category selection, same as evaluate()', async () => {
    const r = router({ nature: { enabled: true, dryRun: true }, built: { 'codex-cli': reporting('codex-cli') } });
    const preview = r.previewPrimary(ARBITER.component, ARBITER);
    expect(preview?.source).toBe('category');
    expect(await realCall(r)).toEqual({ model: preview?.model, framework: preview?.framework });
  });

  it('routed framework unavailable → null (no primary to bind an authority to)', () => {
    const r = router({ cfg: { overrides: { FeedbackReadinessArbiter: 'gemini-cli' } } });
    expect(r.previewPrimary(ARBITER.component, ARBITER)).toBeNull();
  });
});
