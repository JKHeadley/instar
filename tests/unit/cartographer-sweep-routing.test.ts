// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) — the off-Claude routing guarantee, tested against the REAL
 * IntelligenceRouter degrade path (NOT a bespoke always-correct stub), per the
 * spec's required test. Proves: with routing that resolves to the default (Claude)
 * framework or to a missing binary, the engine refuses and ZERO author calls reach
 * the default provider; with a real off-Claude provider, it authors there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import { CartographerSweepEngine, resolveSweepFrameworkRouting, type SweepEngineConfig, type SweepLlmQueueLike } from '../../src/core/CartographerSweepEngine.js';
import { IntelligenceRouter, type ComponentFrameworksConfig } from '../../src/core/IntelligenceRouter.js';
import { categoryForComponent } from '../../src/core/componentCategories.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

let repo: string, stateDir: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-route-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'Widget.ts'), 'export function computeWidgetTotal() { return 0; }\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

function provider(text = 'Implements computeWidgetTotal for totals.'): IntelligenceProvider & { evaluate: ReturnType<typeof vi.fn> } {
  return { evaluate: vi.fn(async () => text) } as unknown as IntelligenceProvider & { evaluate: ReturnType<typeof vi.fn> };
}
const queue: SweepLlmQueueLike = { enqueue: (_l, fn) => fn(new AbortController().signal) };
function cfg(over: Partial<SweepEngineConfig> = {}): SweepEngineConfig {
  return {
    maxNodesPerPass: 25, maxCentsPerPass: 25, estCentsPerAuthor: 1, maxLeafBytes: 24576,
    minSummaryChars: 10, maxSummaryChars: 600, allowClaudeFallback: false,
    nodeFailQuarantineThreshold: 3, maxDeferredPasses: 5, revalidateSamplePerPass: 0, minNodesUnderPressure: 3,
    detectInWorker: false, // fix instar#1069: sync detect in unit tests (no .ts worker)
    ...over,
  };
}

describe('componentCategories wiring', () => {
  it('CartographerSweep is registered under category "job" (off-Claude routable)', () => {
    expect(categoryForComponent('CartographerSweep')).toBe('job');
  });
});

describe('Slice 3 — resolveSweepFrameworkRouting (freshnessSweep.framework honored, explicit-set-only)', () => {
  it('freshnessSweep.framework becomes the effective override when nothing explicit is set', () => {
    const r = resolveSweepFrameworkRouting({}, 'codex-cli');
    expect(r).toEqual({ framework: 'codex-cli', source: 'freshnessSweep.framework', injectOverride: true });
  });
  it('an explicit overrides.CartographerSweep wins and is NOT re-injected', () => {
    const r = resolveSweepFrameworkRouting({ overrides: { CartographerSweep: 'pi-cli' } }, 'codex-cli');
    expect(r).toEqual({ framework: 'pi-cli', source: 'overrides.CartographerSweep', injectOverride: false });
  });
  it('an explicitly-configured categories.job is never silently overridden (migration safety)', () => {
    const r = resolveSweepFrameworkRouting({ categories: { job: 'gemini-cli' } }, 'codex-cli');
    expect(r).toEqual({ framework: 'gemini-cli', source: 'categories.job', injectOverride: false });
  });
  it('nothing configured + no sweep framework → default (no injection)', () => {
    const r = resolveSweepFrameworkRouting(undefined, undefined);
    expect(r).toEqual({ framework: undefined, source: 'default', injectOverride: false });
  });
});

describe('off-Claude routing — real IntelligenceRouter', () => {
  it('UNCONFIGURED routing resolves to default → engine refuses, ZERO calls to the default provider', async () => {
    const t = new CartographerTree({ projectDir: repo, stateDir }); t.scaffold();
    const def = provider();
    const router = new IntelligenceRouter({
      defaultProvider: def,
      defaultFramework: 'claude-code',
      resolveConfig: () => undefined, // unconfigured ⇒ resolves to default
      buildProvider: () => null,
    });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queue, pressure: () => ({ tier: 'normal' }), holdsLease: () => true, config: cfg(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.refused).toBe(true);
    expect(def.evaluate).not.toHaveBeenCalled();
  });

  it('routed to a MISSING binary (buildProvider null) → refuses, ZERO calls to default provider', async () => {
    const t = new CartographerTree({ projectDir: repo, stateDir }); t.scaffold();
    const def = provider();
    const config: ComponentFrameworksConfig = { categories: { job: 'codex-cli' } };
    const router = new IntelligenceRouter({
      defaultProvider: def,
      defaultFramework: 'claude-code',
      resolveConfig: () => config,
      buildProvider: () => null, // codex binary missing
    });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queue, pressure: () => ({ tier: 'normal' }), holdsLease: () => true, config: cfg(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.refused).toBe(true);
    expect(def.evaluate).not.toHaveBeenCalled();
  });

  it('routed to a REAL off-Claude provider → authors there, NOT on the default provider', async () => {
    const t = new CartographerTree({ projectDir: repo, stateDir }); t.scaffold();
    const def = provider();
    const codex = provider();
    const config: ComponentFrameworksConfig = { categories: { job: 'codex-cli' } };
    const router = new IntelligenceRouter({
      defaultProvider: def,
      defaultFramework: 'claude-code',
      resolveConfig: () => config,
      buildProvider: (fw) => (fw === 'codex-cli' ? codex : null),
    });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queue, pressure: () => ({ tier: 'normal' }), holdsLease: () => true, config: cfg(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.authored).toBeGreaterThan(0);
    expect(codex.evaluate).toHaveBeenCalled();
    expect(def.evaluate).not.toHaveBeenCalled();
    expect(t.getNode('src/Widget.ts')?.provenance?.framework).toBe('codex-cli');
  });
});
