/**
 * Unit tests for IntelligenceRouter + componentCategories
 * (docs/specs/per-component-framework-routing.md, B1).
 *
 * Uses fake IntelligenceProviders (record which provider answered) so we test
 * routing/fallback/live-config logic with no CLI. The per-framework breaker
 * isolation is proven structurally: a routed call reaches a DIFFERENT provider
 * instance than a default call, and each instance owns its own breaker.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  IntelligenceRouter,
  type ComponentFrameworksConfig,
} from '../../src/core/IntelligenceRouter.js';
import type { IntelligenceFramework } from '../../src/core/intelligenceProviderFactory.js';
import type { IntelligenceProvider, IntelligenceOptions } from '../../src/core/types.js';
import { categoryForComponent } from '../../src/core/componentCategories.js';

function fakeProvider(label: string): IntelligenceProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async evaluate(_prompt: string, _opts?: IntelligenceOptions): Promise<string> {
      calls.push(_opts?.attribution?.component ?? '(none)');
      return label;
    },
  };
}

function makeRouter(opts: {
  config?: ComponentFrameworksConfig;
  built?: Partial<Record<IntelligenceFramework, IntelligenceProvider | null>>;
  onDegrade?: (i: unknown) => void;
}) {
  const defaultProvider = fakeProvider('claude');
  const buildProvider = vi.fn((fw: IntelligenceFramework) => opts.built?.[fw] ?? null);
  const router = new IntelligenceRouter({
    defaultProvider,
    defaultFramework: 'claude-code',
    resolveConfig: () => opts.config,
    buildProvider,
    onDegrade: opts.onDegrade as never,
  });
  return { router, defaultProvider, buildProvider };
}

describe('componentCategories', () => {
  it('maps known sentinels/gates/reflectors, strips suffixes, defaults to other', () => {
    expect(categoryForComponent('MessageSentinel')).toBe('sentinel');
    expect(categoryForComponent('PromptGate')).toBe('gate');
    expect(categoryForComponent('JobReflector')).toBe('reflector');
    expect(categoryForComponent('CompletionEvaluator/P13')).toBe('sentinel'); // suffix stripped
    expect(categoryForComponent('server:CoherenceGate')).toBe('gate');         // prefix stripped
    expect(categoryForComponent('SomethingUnknown')).toBe('other');
    expect(categoryForComponent(undefined)).toBe('other');
  });
});

describe('IntelligenceRouter — resolution precedence', () => {
  it('override > category > default', () => {
    const cfg: ComponentFrameworksConfig = {
      default: 'claude-code',
      categories: { sentinel: 'codex-cli' },
      overrides: { MessageSentinel: 'gemini-cli' },
    };
    const { router } = makeRouter({ config: cfg });
    // override wins
    expect(router.resolveFramework('MessageSentinel', 'sentinel', cfg)).toBe('gemini-cli');
    // category wins when no override
    expect(router.resolveFramework('PresenceProxy', 'sentinel', cfg)).toBe('codex-cli');
    // default when neither
    expect(router.resolveFramework('Whatever', 'other', cfg)).toBe('claude-code');
  });
});

describe('IntelligenceRouter — dispatch', () => {
  it('unconfigured: every call goes to the default provider, no other provider is ever built', async () => {
    const { router, defaultProvider, buildProvider } = makeRouter({ config: undefined });
    const r = await router.evaluate('p', { attribution: { component: 'MessageSentinel' } });
    expect(r).toBe('claude');
    expect(defaultProvider.calls).toEqual(['MessageSentinel']);
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it('routes a sentinel to codex (a DIFFERENT provider instance) while default stays on claude', async () => {
    const codex = fakeProvider('codex');
    const { router, defaultProvider } = makeRouter({
      config: { categories: { sentinel: 'codex-cli' } },
      built: { 'codex-cli': codex },
    });
    // sentinel → codex
    expect(await router.evaluate('p', { attribution: { component: 'PresenceProxy' } })).toBe('codex');
    // a non-sentinel (other) → default claude
    expect(await router.evaluate('p', { attribution: { component: 'SomethingUnknown' } })).toBe('claude');
    expect(codex.calls).toEqual(['PresenceProxy']);
    expect(defaultProvider.calls).toEqual(['SomethingUnknown']);
  });

  it('explicit attribution.category overrides the registry', async () => {
    const codex = fakeProvider('codex');
    const { router } = makeRouter({
      config: { categories: { gate: 'codex-cli' } },
      built: { 'codex-cli': codex },
    });
    // MessageSentinel is a 'sentinel' in the registry, but we force category 'gate'
    const r = await router.evaluate('p', { attribution: { component: 'MessageSentinel', category: 'gate' } });
    expect(r).toBe('codex');
  });

  it('caches the per-framework provider (build once across calls)', async () => {
    const codex = fakeProvider('codex');
    const { router, buildProvider } = makeRouter({
      config: { categories: { sentinel: 'codex-cli' } },
      built: { 'codex-cli': codex },
    });
    await router.evaluate('p', { attribution: { component: 'PresenceProxy' } });
    await router.evaluate('p', { attribution: { component: 'MessageSentinel' } });
    expect(buildProvider).toHaveBeenCalledTimes(1);
  });
});

describe('IntelligenceRouter — fallback (D4)', () => {
  it('binary missing + fallback default: degrades to default provider and reports', async () => {
    const onDegrade = vi.fn();
    const { router, defaultProvider } = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, fallback: 'default' },
      built: { 'codex-cli': null }, // codex binary missing
      onDegrade,
    });
    const r = await router.evaluate('p', { attribution: { component: 'PresenceProxy' } });
    expect(r).toBe('claude'); // degraded to default
    expect(defaultProvider.calls).toEqual(['PresenceProxy']);
    expect(onDegrade).toHaveBeenCalledTimes(1);
    expect(onDegrade.mock.calls[0][0]).toMatchObject({ from: 'codex-cli', to: 'claude-code' });
  });

  it('binary missing + fallback none: throws (strict)', async () => {
    const { router } = makeRouter({
      config: { categories: { sentinel: 'codex-cli' }, fallback: 'none' },
      built: { 'codex-cli': null },
    });
    await expect(router.evaluate('p', { attribution: { component: 'PresenceProxy' } })).rejects.toThrow(/unavailable/);
  });
});

describe('IntelligenceRouter — live config (hot, no restart)', () => {
  it('a config change is reflected on the next call', async () => {
    const codex = fakeProvider('codex');
    const defaultProvider = fakeProvider('claude');
    let cfg: ComponentFrameworksConfig | undefined = undefined;
    const router = new IntelligenceRouter({
      defaultProvider,
      defaultFramework: 'claude-code',
      resolveConfig: () => cfg,
      buildProvider: () => codex,
    });
    // before config: default
    expect(await router.evaluate('p', { attribution: { component: 'PresenceProxy' } })).toBe('claude');
    // flip config live
    cfg = { categories: { sentinel: 'codex-cli' } };
    expect(await router.evaluate('p', { attribution: { component: 'PresenceProxy' } })).toBe('codex');
  });
});

describe('IntelligenceRouter — for() diagnostic surface', () => {
  it('reports resolved framework + availability per component', () => {
    const codex = fakeProvider('codex');
    const { router } = makeRouter({
      config: { categories: { sentinel: 'codex-cli' } },
      built: { 'codex-cli': codex },
    });
    expect(router.for('PresenceProxy')).toMatchObject({ category: 'sentinel', framework: 'codex-cli', available: true });
    expect(router.for('SomethingUnknown')).toMatchObject({ category: 'other', framework: 'claude-code', available: true });
  });

  it('reports available:false when the routed framework binary is missing', () => {
    const { router } = makeRouter({
      config: { categories: { sentinel: 'codex-cli' } },
      built: { 'codex-cli': null },
    });
    expect(router.for('PresenceProxy')).toMatchObject({ framework: 'codex-cli', available: false });
  });
});
