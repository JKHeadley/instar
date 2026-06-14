// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 2 (integration) — the event-loop-safety proof for fix instar#1069, run
 * against the REAL compiled worker in dist/ (the globalSetup builds it). These
 * tests prove what unit tests in-process cannot:
 *   - the PROD worker path resolves (`new URL('./cartographerDetect.worker.js',
 *     import.meta.url)`) and returns a bounded result + writes the snapshot;
 *   - detect on a LARGE index does NOT starve the main event loop (sampled
 *     setInterval drift stays < 250ms) — the regression guard: reverting detect to
 *     the main thread spikes the lag and fails this test;
 *   - detectTimeoutMs bounds the worker (a 1ms budget refuses detect-timeout);
 *   - the detectInWorker:false rollback runs the SAME bounded module synchronously.
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { CartographerIndex } from '../../src/core/CartographerTree.js';
import type {
  SweepEngineConfig,
  SweepRouterLike,
  SweepLlmQueueLike,
} from '../../src/core/CartographerSweepEngine.js';
import type { PressureReading } from '../../src/monitoring/SessionReaper.js';

// fix instar#1069: load the engine + tree FROM dist (built by globalSetup) so the
// worker resolves via the engine's dist import.meta.url — proving the PROD path.
// Runtime-resolved paths so `tsc --noEmit` (which may run before dist exists) does
// not try to statically resolve them.
type EngineMod = typeof import('../../src/core/CartographerSweepEngine.js');
type TreeMod = typeof import('../../src/core/CartographerTree.js');
let CartographerSweepEngine: EngineMod['CartographerSweepEngine'];
let CartographerTree: TreeMod['CartographerTree'];
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'core');
beforeAll(async () => {
  const eng = (await import(/* @vite-ignore */ path.join(DIST, 'CartographerSweepEngine.js'))) as EngineMod;
  const tre = (await import(/* @vite-ignore */ path.join(DIST, 'CartographerTree.js'))) as TreeMod;
  CartographerSweepEngine = eng.CartographerSweepEngine;
  CartographerTree = tre.CartographerTree;
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string, stateDir: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-elw-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(path.join(stateDir, 'cartographer'), { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'init']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const tree = (): CartographerTree => new CartographerTree({ projectDir: repo, stateDir });
const normalPressure = (): PressureReading => ({ tier: 'normal' });
const queueStub: SweepLlmQueueLike = { enqueue: (_l, fn) => fn(new AbortController().signal) };
const routerStub: SweepRouterLike = {
  defaultFramework: 'claude-code',
  for: () => ({ component: 'CartographerSweep', category: 'job', framework: 'codex-cli', available: true }),
  evaluate: async () => 'summary',
};

/** Overwrite the index with N synthetic never-authored entries (no real files needed). */
function writeLargeIndex(t: CartographerTree, n: number): void {
  const index: CartographerIndex = { schemaVersion: 2, root: '', generatedAt: '2026-01-01T00:00:00.000Z', nodes: {} };
  for (let i = 0; i < n; i++) {
    index.nodes[`src/d${i % 50}/f${i}.ts`] = { kind: 'file', summaryUpdatedAt: null, codeHash: null, hasChildren: false };
  }
  fs.writeFileSync(t.indexFilePath(), JSON.stringify(index));
}

function engineFor(t: CartographerTree, over: Partial<SweepEngineConfig> = {}): CartographerSweepEngine {
  const config: SweepEngineConfig = {
    maxNodesPerPass: 25, maxCentsPerPass: 25, estCentsPerAuthor: 1, maxLeafBytes: 24576,
    minSummaryChars: 10, maxSummaryChars: 600, allowClaudeFallback: false,
    nodeFailQuarantineThreshold: 3, maxDeferredPasses: 5, revalidateSamplePerPass: 0, minNodesUnderPressure: 3,
    detectInWorker: true, detectTimeoutMs: 120000, detectWorkerHeapMb: 1024,
    maxIndexBytes: 256 * 1024 * 1024, snapshotSampleMax: 500, gitMaxBuffer: 64 * 1024 * 1024,
    detectCandidateHeadroom: 4, ...over,
  };
  return new CartographerSweepEngine({
    tree: t, router: routerStub, llmQueue: queueStub, pressure: normalPressure,
    holdsLease: () => true, config, stateDir,
  });
}

describe('cartographer event-loop safety — REAL dist worker (fix instar#1069)', () => {
  it('detect runs in the dist worker, returns a bounded result, and writes the snapshot', async () => {
    const t = tree();
    writeLargeIndex(t, 20000);
    const engine = engineFor(t);
    const r = await engine.runPass();
    // Not a refusal → the worker resolved from dist and answered (NOT worker-start-failure).
    expect(r.refused).toBe(false);
    expect(r.detectStatus).toBe('ok');
    expect(r.candidateCount).toBe(20000);
    // Snapshot written + served by the routes.
    const snap = t.readSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.counts.nodeCount).toBe(20000);
    expect(snap!.lastDetectStatus).toBe('ok');
  });

  it('detect on a large index does NOT starve the event loop (max sampled lag < 250ms)', async () => {
    const t = tree();
    writeLargeIndex(t, 60000); // big enough that a MAIN-THREAD parse would blow past 250ms
    const engine = engineFor(t);

    const SAMPLE_MS = 20;
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - SAMPLE_MS);
      last = now;
    }, SAMPLE_MS);
    last = Date.now();
    try {
      await engine.runPass();
    } finally {
      clearInterval(timer);
    }
    // With detect in the worker, the main loop stays responsive. Reverting detect to
    // the main thread (the #1069 regression) spikes this well past 250ms.
    expect(maxLag).toBeLessThan(250);
  });

  it('detectTimeoutMs bounds the worker → refused detect-timeout', async () => {
    const t = tree();
    writeLargeIndex(t, 20000);
    const engine = engineFor(t, { detectTimeoutMs: 1 }); // 1ms — the worker cannot even start+answer
    const r = await engine.runPass();
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toBe('detect-timeout');
    expect(r.detectStatus).toBe('timeout');
  });

  it('rollback (detectInWorker:false) runs the SAME bounded module synchronously', async () => {
    const t = tree();
    writeLargeIndex(t, 5000);
    const engine = engineFor(t, { detectInWorker: false });
    const r = await engine.runPass();
    expect(r.refused).toBe(false);
    expect(r.candidateCount).toBe(5000); // bounded detect still sees the full count
    expect(t.readSnapshot()).not.toBeNull();
  });

  it('boot scaffold (scaffoldChunked) does NOT starve the event loop on a large real tree (lag < 250ms)', async () => {
    const t = tree();
    // Generate a large real directory tree (~6000 leaf files) so the walk + per-node
    // writes + the streamed index serialize are all non-trivial. Unchunked (the
    // regression) this would block the loop; chunked, per-yield lag stays bounded.
    const DIRS = 40, PER = 150;
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(repo, 'src', `m${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < PER; f++) fs.writeFileSync(path.join(dir, `f${f}.ts`), `export const x${f} = ${f};\n`);
    }
    const SAMPLE_MS = 20;
    let maxLag = 0;
    let last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - SAMPLE_MS); last = now; }, SAMPLE_MS);
    last = Date.now();
    try {
      await t.scaffoldChunked({ chunkNodes: 200, onYield: () => new Promise<void>((r) => setImmediate(r)) });
    } finally {
      clearInterval(timer);
    }
    expect(maxLag).toBeLessThan(250);
    // The index was written incrementally and is readable.
    const loaded = t.loadIndexBounded(256 * 1024 * 1024);
    expect(loaded.state).toBe('ok');
    expect(loaded.nodeCount).toBeGreaterThan(6000);
  });
});
