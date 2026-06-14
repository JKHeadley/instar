// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) — fix instar#1069: a DETECT refusal must feed the poller's breaker
 * (it increments zeroProgressTicks, NOT consecutiveZeroCandidate). If a refused
 * detect were mistaken for "genuinely nothing to do", the breaker would never trip
 * and the sweep would silently do nothing forever. Here every pass refuses
 * (detect-index-too-large via a 1-byte maxIndexBytes), and the breaker opens.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { CartographerTree } from '../../src/core/CartographerTree.js';
import {
  CartographerSweepEngine,
  type SweepEngineConfig,
  type SweepRouterLike,
  type SweepLlmQueueLike,
} from '../../src/core/CartographerSweepEngine.js';
import { CartographerSweepPoller } from '../../src/monitoring/CartographerSweepPoller.js';
import type { PressureReading } from '../../src/monitoring/SessionReaper.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string, stateDir: string;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-brk-'));
  stateDir = path.join(repo, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-q', '-m', 'init']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const router: SweepRouterLike = {
  defaultFramework: 'claude-code',
  for: () => ({ component: 'CartographerSweep', category: 'job', framework: 'codex-cli', available: true }),
  evaluate: async () => 'x',
};
const queue: SweepLlmQueueLike = { enqueue: (_l, fn) => fn(new AbortController().signal) };
const pressure = (): PressureReading => ({ tier: 'normal' });

describe('CartographerSweepPoller — a detect refusal trips the breaker (fix instar#1069)', () => {
  it('sustained detect refusals open the breaker (refusal ≠ no-candidates)', async () => {
    const t = new CartographerTree({ projectDir: repo, stateDir });
    t.scaffold(); // index.json now exists and is > 1 byte
    const config: SweepEngineConfig = {
      maxNodesPerPass: 25, maxCentsPerPass: 25, estCentsPerAuthor: 1, maxLeafBytes: 24576,
      minSummaryChars: 10, maxSummaryChars: 600, allowClaudeFallback: false, nodeFailQuarantineThreshold: 3,
      maxDeferredPasses: 5, revalidateSamplePerPass: 0, minNodesUnderPressure: 3,
      detectInWorker: false, maxIndexBytes: 1, // every detect refuses detect-index-too-large
    };
    const engine = new CartographerSweepEngine({ tree: t, router, llmQueue: queue, pressure, holdsLease: () => true, config, stateDir });

    // Sanity: one pass refuses (not "no-candidates").
    const r = await engine.runPass();
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toBe('detect-index-too-large');

    const poller = new CartographerSweepPoller({ engine, cadenceMs: 25, idleCadenceMs: 25, zeroProgressTicksToBreak: 1 });
    poller.start();
    // Give the cadence a few ticks; one refused tick (threshold 1) opens the breaker.
    const start = Date.now();
    while (!poller.isBreakerOpen() && Date.now() - start < 2000) {
      await new Promise((res) => setTimeout(res, 25));
    }
    poller.stop();
    expect(poller.isBreakerOpen()).toBe(true);
  });
});
