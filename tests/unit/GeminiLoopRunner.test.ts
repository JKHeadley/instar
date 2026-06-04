/**
 * Unit tests for GeminiLoopRunner (need-gem-002, increment 2) — the budget-gated,
 * dark-by-default async service that makes the GeminiLoopDriver invocable.
 *
 * Both sides of admission (disabled / at-capacity / budget / invalid / OK), the
 * async run lifecycle (running → done, result captured), and registry eviction.
 * All deps injected → zero real gemini calls.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  GeminiLoopRunner,
  type GeminiLoopRunnerDeps,
  type GeminiLoopDriverConfig,
} from '../../src/monitoring/GeminiLoopRunner.js';
import { DEFAULT_DONE_SENTINEL, type GeminiLoopSpawnResult } from '../../src/monitoring/GeminiLoopDriver.js';

function cfg(over: Partial<GeminiLoopDriverConfig> = {}): GeminiLoopDriverConfig {
  return {
    enabled: true,
    model: 'gemini-2.5-flash',
    maxTurns: 12,
    minTurnIntervalMs: 0,
    maxConcurrent: 1,
    maxRetainedRuns: 50,
    ...over,
  };
}

const ok = (stdout: string): GeminiLoopSpawnResult => ({ exitCode: 0, stdout, stderr: '', truncated: false });

function mkRunner(over: Partial<GeminiLoopRunnerDeps> = {}): GeminiLoopRunner {
  let id = 0;
  const deps: GeminiLoopRunnerDeps = {
    config: cfg(),
    // turn 1 finishes immediately via the sentinel → one-turn run
    spawn: async () => ok(`done\n${DEFAULT_DONE_SENTINEL}`),
    captureHandle: async () => 'handle-uuid',
    budgetGate: () => ({ ok: true }),
    genId: () => `run-${++id}`,
    ...over,
  };
  return new GeminiLoopRunner(deps);
}

async function settle() {
  // let the fire-and-forget driver promise chain resolve
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('GeminiLoopRunner — admission boundaries', () => {
  it('refuses when disabled', () => {
    const r = mkRunner({ config: cfg({ enabled: false }) });
    const out = r.startRun({ goalPrompt: 'do X' });
    expect(out).toEqual({ ok: false, reason: 'disabled' });
    expect(r.isEnabled()).toBe(false);
  });

  it('refuses an empty/whitespace goal as invalid', () => {
    const r = mkRunner();
    expect(r.startRun({ goalPrompt: '   ' })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses when the budget gate is closed', () => {
    const r = mkRunner({ budgetGate: () => ({ ok: false, reason: 'memory pressure' }) });
    expect(r.startRun({ goalPrompt: 'do X' })).toMatchObject({ ok: false, reason: 'budget', detail: 'memory pressure' });
  });

  it('refuses a second run past maxConcurrent (and admits again after the first finishes)', async () => {
    // a spawn that never resolves keeps run 1 active
    let release!: () => void;
    const blocker = new Promise<GeminiLoopSpawnResult>((res) => { release = () => res(ok(`x\n${DEFAULT_DONE_SENTINEL}`)); });
    const r = mkRunner({ config: cfg({ maxConcurrent: 1 }), spawn: () => blocker });

    const a = r.startRun({ goalPrompt: 'task A' });
    expect(a.ok).toBe(true);
    expect(r.activeRuns()).toBe(1);

    const b = r.startRun({ goalPrompt: 'task B' });
    expect(b).toMatchObject({ ok: false, reason: 'at-capacity' });

    release();
    await settle();
    expect(r.activeRuns()).toBe(0);
    // capacity freed → a new run admits
    expect(r.startRun({ goalPrompt: 'task C' }).ok).toBe(true);
  });
});

describe('GeminiLoopRunner — async run lifecycle', () => {
  it('returns a runId immediately, then records the result when the loop finishes', async () => {
    const r = mkRunner();
    const out = r.startRun({ goalPrompt: 'do X' });
    expect(out).toEqual({ ok: true, runId: 'run-1' });

    // synchronously, the run is still "running"
    expect(r.getRun('run-1')?.status).toBe('running');

    await settle();
    const rec = r.getRun('run-1')!;
    expect(rec.status).toBe('done');
    expect(rec.result?.stopReason).toBe('done-sentinel');
    expect(rec.finishedAt).toBeGreaterThanOrEqual(rec.startedAt);
    expect(r.activeRuns()).toBe(0);
  });

  it('clamps a requested maxTurns to the config cap', async () => {
    const calls: string[][] = [];
    const r = mkRunner({
      config: cfg({ maxTurns: 3 }),
      // never emit the sentinel → runs to the cap
      spawn: async (argv) => { calls.push(argv); return ok('working'); },
    });
    r.startRun({ goalPrompt: 'do X', maxTurns: 99 });
    await settle();
    // capped at 3, not 99
    expect(calls.length).toBe(3);
  });

  it('records an error status if the driver throws', async () => {
    const r = mkRunner({ spawn: async () => { throw new Error('spawn blew up'); } });
    r.startRun({ goalPrompt: 'do X' });
    await settle();
    const rec = r.getRun('run-1')!;
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('spawn blew up');
    expect(r.activeRuns()).toBe(0);
  });
});

describe('GeminiLoopRunner — registry', () => {
  it('evicts oldest FINISHED runs past maxRetainedRuns', async () => {
    let n = 0;
    const r = mkRunner({ config: cfg({ maxRetainedRuns: 2, maxConcurrent: 10 }), genId: () => `r${++n}` });
    r.startRun({ goalPrompt: 'a' });
    await settle();
    r.startRun({ goalPrompt: 'b' });
    await settle();
    r.startRun({ goalPrompt: 'c' });
    await settle();
    const ids = r.listRuns().map((x) => x.runId);
    expect(ids.length).toBeLessThanOrEqual(2);
    expect(ids).toContain('r3'); // newest retained
    expect(ids).not.toContain('r1'); // oldest evicted
  });

  it('listRuns returns newest-first', async () => {
    let n = 0;
    const r = mkRunner({ config: cfg({ maxConcurrent: 10 }), genId: () => `r${++n}`, now: () => n * 1000 });
    r.startRun({ goalPrompt: 'a' });
    r.startRun({ goalPrompt: 'b' });
    await settle();
    expect(r.listRuns()[0].goalPrompt).toBe('b');
  });
});
