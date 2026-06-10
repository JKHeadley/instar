// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) tests for CartographerSweepEngine (cartographer-doc-freshness
 * spec #2). Uses a REAL temporary git repo + real CartographerTree (spec #1), so
 * staleness/committed-content/setSummary are exercised for real; only the router,
 * LLM queue, pressure, and lease are injected stubs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import {
  CartographerSweepEngine,
  SweepAbortedError,
  type SweepEngineConfig,
  type SweepRouterLike,
  type SweepLlmQueueLike,
} from '../../src/core/CartographerSweepEngine.js';
import type { PressureReading, PressureTier } from '../../src/monitoring/SessionReaper.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}
function commitAll(repo: string, msg: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', msg]);
}

let repo: string;
let stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-sweep-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
  // Distinctive camelCase symbols so the deterministic symbol-presence check has teeth.
  fs.writeFileSync(path.join(repo, 'src', 'core', 'Widget.ts'), 'export function computeWidgetTotal() { return 0; }\n');
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export function bootstrapApp() { return 1; }\n');
  commitAll(repo, 'init');
});
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function tree(): CartographerTree {
  return new CartographerTree({ projectDir: repo, stateDir });
}

function defaultConfig(over: Partial<SweepEngineConfig> = {}): SweepEngineConfig {
  return {
    maxNodesPerPass: 25,
    maxCentsPerPass: 25,
    estCentsPerAuthor: 1,
    maxLeafBytes: 24576,
    minSummaryChars: 10,
    maxSummaryChars: 600,
    allowClaudeFallback: false,
    nodeFailQuarantineThreshold: 3,
    maxDeferredPasses: 5,
    revalidateSamplePerPass: 0,
    minNodesUnderPressure: 3,
    ...over,
  };
}

/** A router stub. Default: routes off-Claude (codex-cli), available. */
function routerStub(opts: {
  framework?: string;
  available?: boolean;
  evaluate: (prompt: string) => string;
}): SweepRouterLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    defaultFramework: 'claude-code',
    for: () => ({ component: 'CartographerSweep', category: 'job', framework: opts.framework ?? 'codex-cli', available: opts.available ?? true }),
    evaluate: async (prompt: string) => {
      calls.push(prompt);
      return opts.evaluate(prompt);
    },
  };
}

/** A queue stub that just runs the fn with a never-aborted signal. */
function queueStub(over?: Partial<SweepLlmQueueLike>): SweepLlmQueueLike {
  return {
    enqueue: (_lane, fn) => fn(new AbortController().signal),
    ...over,
  };
}

const normalPressure = (): PressureReading => ({ tier: 'normal' as PressureTier });

/** Pull the node path a leaf/dir prompt was built for, for ordering assertions. */
function promptPath(prompt: string): string | null {
  const f = prompt.match(/File: (\S+)/);
  if (f) return f[1];
  const d = prompt.match(/Directory: (.+)/);
  if (d) return d[1].trim();
  return null;
}

describe('CartographerSweepEngine.probeRouting', () => {
  it('refuses when routing resolves to the default (Claude) framework', () => {
    const t = tree(); t.scaffold();
    const engine = new CartographerSweepEngine({
      tree: t, router: routerStub({ framework: 'claude-code', evaluate: () => 'x' }),
      llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    const probe = engine.probeRouting();
    expect(probe.ok).toBe(false);
  });

  it('allows resolve-to-default ONLY when allowClaudeFallback is true', () => {
    const t = tree(); t.scaffold();
    const engine = new CartographerSweepEngine({
      tree: t, router: routerStub({ framework: 'claude-code', evaluate: () => 'x' }),
      llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig({ allowClaudeFallback: true }), stateDir,
    });
    expect(engine.probeRouting().ok).toBe(true);
  });

  it('refuses when the off-Claude framework is unavailable (binary missing)', () => {
    const t = tree(); t.scaffold();
    const engine = new CartographerSweepEngine({
      tree: t, router: routerStub({ framework: 'codex-cli', available: false, evaluate: () => 'x' }),
      llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    expect(engine.probeRouting().ok).toBe(false);
  });
});

describe('CartographerSweepEngine.runPass — authoring', () => {
  it('authors never-authored leaf nodes off-Claude, with sweep provenance', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({
      evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal to total widgets.'
        : p.includes('index.ts') ? 'Provides bootstrapApp to start the app.'
        : 'Summarizes the directory contents for computeWidgetTotal and bootstrapApp.',
    });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.ranAuthorPath).toBe(true);
    expect(r.authored).toBeGreaterThan(0);
    const leaf = t.getNode('src/core/Widget.ts');
    expect(leaf?.summary).toContain('computeWidgetTotal');
    expect(leaf?.provenance?.source).toBe('sweep');
    expect(leaf?.lastAuthoredBy).toBe('sweep:codex-cli');
    expect(t.computeStaleness('src/core/Widget.ts')).toBe('fresh');
  });

  it('does NOT author when this machine is not the lease holder', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: () => 'Implements computeWidgetTotal here.' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => false,
      config: defaultConfig(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.ranAuthorPath).toBe(false);
    expect(r.authored).toBe(0);
    expect(router.calls.length).toBe(0);
  });

  it('refuses (authors zero) when the routing probe fails', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ framework: 'claude-code', evaluate: () => 'x' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.refused).toBe(true);
    expect(r.authored).toBe(0);
    expect(router.calls.length).toBe(0);
  });
});

describe('CartographerSweepEngine — deterministic quality bar', () => {
  it('rejects a symbol-less summary (left never-authored, not written)', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: () => 'This module does some general work and stuff.' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    const r = await engine.runPass();
    // The leaf files name distinctive symbols; a prose summary references none → rejected.
    expect(r.failed).toBeGreaterThan(0);
    expect(t.getNode('src/core/Widget.ts')?.summary).toBe('');
    expect(t.computeStaleness('src/core/Widget.ts')).toBe('never-authored');
  });
});

describe('CartographerSweepEngine — ordering (children before parents)', () => {
  it('authors a stale child before its stale parent dir', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({
      evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal here.'
        : p.includes('index.ts') ? 'Implements bootstrapApp here.'
        : 'Directory summary mentioning computeWidgetTotal.',
    });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    await engine.runPass();
    const order = router.calls.map(promptPath).filter(Boolean) as string[];
    const childIdx = order.indexOf('src/core/Widget.ts');
    const parentIdx = order.indexOf('src/core');
    const rootIdx = order.indexOf('(repo root)');
    expect(childIdx).toBeGreaterThanOrEqual(0);
    expect(parentIdx).toBeGreaterThan(childIdx);   // parent dir after its child
    if (rootIdx >= 0) expect(rootIdx).toBeGreaterThan(parentIdx); // root last
  });
});

describe('CartographerSweepEngine — dir re-author amplification guard', () => {
  it('refreshes a dir fingerprint with NO LLM call when child digest is unchanged', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({
      evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal here.'
        : p.includes('index.ts') ? 'Implements bootstrapApp here.'
        : 'Directory containing computeWidgetTotal logic.',
    });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    await engine.runPass(); // everything authored
    expect(t.computeStaleness('src/core')).toBe('fresh');

    // A comment-only edit to a leaf flips ancestor tree-oids but does NOT change any
    // child SUMMARY. Re-author the leaf with the SAME summary text (digest unchanged),
    // then the dir should fingerprint-refresh with no new LLM call.
    fs.appendFileSync(path.join(repo, 'src', 'core', 'Widget.ts'), '// a comment\n');
    commitAll(repo, 'comment');
    // Re-author the leaf to the same summary so the child digest is stable.
    router.calls.length = 0;
    router.evaluate = async () => 'Implements computeWidgetTotal here.';
    const r = await engine.runPass();
    // The dir was re-authored by fingerprint only (no LLM prompt for the dir path).
    expect(r.fingerprintRefreshed).toBeGreaterThan(0);
    const dirPrompts = router.calls.filter((p) => promptPath(p) === 'src/core');
    expect(dirPrompts.length).toBe(0);
  });
});

describe('CartographerSweepEngine — per-pass bounds', () => {
  it('authors at most maxNodesPerPass and reports the remainder', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal here.' : 'Implements bootstrapApp here.' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig({ maxNodesPerPass: 1 }), stateDir,
    });
    const r = await engine.runPass();
    expect(r.authored + r.fingerprintRefreshed).toBe(1);
    expect(r.remaining).toBeGreaterThan(0);
  });

  it('stops authoring when the per-pass cents cap binds', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal here.' : 'Implements bootstrapApp here.' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig({ estCentsPerAuthor: 10, maxCentsPerPass: 10 }), stateDir,
    });
    const r = await engine.runPass();
    expect(r.authored).toBe(1); // 1 author = 10 cents; a 2nd would exceed 10
  });
});

describe('CartographerSweepEngine — secrets egress', () => {
  it('never passes a credential-bearing file to an author call', async () => {
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=sk-supersecretvalue1234567890\n');
    commitAll(repo, 'env');
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: () => 'Implements computeWidgetTotal here.' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    await engine.runPass();
    // .env is a leaf only if its extension matched; deny-glob catches it regardless of how it was scaffolded.
    expect(router.calls.some((p) => p.includes('supersecret') || /\.env\b/.test(p))).toBe(false);
  });
});

describe('CartographerSweepEngine — quarantine', () => {
  it('quarantines a node after K consecutive author failures', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: () => 'no symbols here just prose words' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig({ nodeFailQuarantineThreshold: 2 }), stateDir,
    });
    await engine.runPass();
    await engine.runPass();
    const node = t.getNode('src/core/Widget.ts');
    expect(node?.consecutiveAuthorFailures).toBeGreaterThanOrEqual(2);
    expect(node?.authorFailed).toBe(true);
    expect(t.freshnessHealth({ graceMs: 0 }).authorFailedCount).toBeGreaterThan(0);
  });
});

describe('CartographerSweepEngine — abort is backpressure, not failure', () => {
  it('does not count an aborted author toward the breaker/quarantine', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: () => 'Implements computeWidgetTotal here.' });
    const engine = new CartographerSweepEngine({
      tree: t, router,
      llmQueue: { enqueue: () => { throw new SweepAbortedError(); } },
      pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    const r = await engine.runPass();
    expect(r.abortedBackpressure).toBe(true);
    expect(r.failed).toBe(0);
    // Node keeps its prior (never-authored) status; no failure counter bump.
    expect(t.getNode('src/core/Widget.ts')?.consecutiveAuthorFailures ?? 0).toBe(0);
  });
});

describe('CartographerSweepEngine — fresh != correct (re-validation sample)', () => {
  it('re-examines a fresh node when revalidateSamplePerPass > 0', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal here.' : 'Implements bootstrapApp here.' });
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig(), stateDir,
    });
    await engine.runPass(); // author everything
    const before = router.calls.length;
    // Second pass: no candidates (all fresh) but the sample should re-examine fresh nodes.
    const engine2 = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig({ revalidateSamplePerPass: 2 }), stateDir,
    });
    const r = await engine2.runPass();
    expect(r.revalidated).toBeGreaterThan(0);
    expect(router.calls.length).toBeGreaterThan(before);
  });
});

describe('CartographerSweepEngine — idempotent cursor', () => {
  it('fails soft to a full re-scan on a corrupt cursor (never exceeds caps)', async () => {
    const t = tree(); t.scaffold();
    const router = routerStub({ evaluate: (p) => p.includes('Widget.ts') ? 'Implements computeWidgetTotal here.' : 'Implements bootstrapApp here.' });
    // Plant a corrupt cursor.
    const cursorDir = path.join(stateDir, 'state');
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'cartographer-sweep-cursor.json'), '{not json');
    const engine = new CartographerSweepEngine({
      tree: t, router, llmQueue: queueStub(), pressure: normalPressure, holdsLease: () => true,
      config: defaultConfig({ maxNodesPerPass: 2 }), stateDir,
    });
    const r = await engine.runPass();
    expect(r.ranAuthorPath).toBe(true);
    expect(r.authored + r.fingerprintRefreshed).toBeLessThanOrEqual(2); // cap honored despite corrupt cursor
  });
});

// Keep vi import meaningful even if unused above in some runs.
void vi;
