// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 1 (unit) tests for the PURE cartographer detect module (fix instar#1069).
 * These run in-process against a REAL git repo + synthetic index.json — NO worker
 * (the worker-from-dist path has its own dist-backed integration test). They prove
 * the event-loop-safety invariants that are properties of the pure module:
 *   - bounded candidates (≤ maxCandidates) via heap (peak heap ≤ maxCandidates)
 *   - golden deepest-first ordering (frozen expected, not a tautology)
 *   - ZERO node-file reads during detect (instrumentation)
 *   - the refusal taxonomy: byte-guard / git-error / index-unreadable / index-missing
 *   - secret-path-filtered, bounded stale sample
 *   - the anti-starvation defer counter is sourced from + persisted to the INDEX
 *   - applyIndexDeltas applies the author-phase deltas in one write
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runDetect,
  applyIndexDeltas,
  type DetectInput,
  type DetectInstrumentation,
} from '../../src/core/cartographerDetect.js';
import type { CartographerIndex, CartographerIndexEntry } from '../../src/core/CartographerTree.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd, stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string;
let indexPath: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-detect-'));
  fs.mkdirSync(path.join(repo, '.instar', 'cartographer'), { recursive: true });
  indexPath = path.join(repo, '.instar', 'cartographer', 'index.json');
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

/** Write a synthetic index.json. Entries default to never-authored (codeHash null). */
function writeIndex(nodes: Record<string, Partial<CartographerIndexEntry> & { kind: 'dir' | 'file' }>): void {
  const index: CartographerIndex = {
    schemaVersion: 2, root: '', generatedAt: '2026-01-01T00:00:00.000Z', nodes: {},
  };
  for (const [p, e] of Object.entries(nodes)) {
    index.nodes[p] = {
      kind: e.kind, summaryUpdatedAt: e.summaryUpdatedAt ?? null, codeHash: e.codeHash ?? null,
      hasChildren: e.hasChildren ?? false,
      ...(e.staleSincePass !== undefined ? { staleSincePass: e.staleSincePass } : {}),
      ...(e.firstSeenAt !== undefined ? { firstSeenAt: e.firstSeenAt } : {}),
      ...(e.authorFailed !== undefined ? { authorFailed: e.authorFailed } : {}),
    };
  }
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

function input(over: Partial<DetectInput> = {}): DetectInput {
  return {
    indexPath, projectDir: repo, maxIndexBytes: 256 * 1024 * 1024, maxCandidates: 100,
    maxNodesPerPass: 25, maxDeferredPasses: 5, revalidateSamplePerPass: 0, graceMs: 0,
    gitMaxBuffer: 64 * 1024 * 1024, snapshotSampleMax: 500, nowMs: Date.parse('2026-01-02T00:00:00.000Z'),
    ...over,
  };
}

describe('cartographerDetect.runDetect — bounded + ordered', () => {
  it('returns at most maxCandidates and never materializes/sorts the full set (peak heap ≤ cap)', () => {
    const nodes: Record<string, { kind: 'file' }> = {};
    for (let i = 0; i < 1000; i++) nodes[`src/d${i % 10}/f${i}.ts`] = { kind: 'file' };
    writeIndex(nodes);
    const instr: DetectInstrumentation = { candidateHeapPeak: 0, starvedHeapPeak: 0, nodeFileReads: -1 };
    const r = runDetect(input({ maxCandidates: 30 }), instr);
    expect(r.refused).toBe(false);
    expect(r.candidates.length).toBeLessThanOrEqual(30);
    expect(instr.candidateHeapPeak).toBeLessThanOrEqual(30);
    expect(r.staleTotal).toBe(1000); // counts the FULL candidate set, even though only 30 returned
  });

  it('detect reads ZERO node files (the invariant the freeze fix depends on)', () => {
    writeIndex({ 'a.ts': { kind: 'file' }, 'b.ts': { kind: 'file' } });
    const instr: DetectInstrumentation = { candidateHeapPeak: 0, starvedHeapPeak: 0, nodeFileReads: -1 };
    runDetect(input(), instr);
    expect(instr.nodeFileReads).toBe(0);
  });

  it('GOLDEN deepest-first ordering (children before parents; path tiebreak)', () => {
    // A fixed fixture → a frozen expected order. A future ordering change fails here.
    writeIndex({
      '': { kind: 'dir', hasChildren: true },
      'src': { kind: 'dir', hasChildren: true },
      'src/a': { kind: 'dir', hasChildren: true },
      'src/a/deep.ts': { kind: 'file' },
      'src/b.ts': { kind: 'file' },
    });
    const r = runDetect(input({ maxCandidates: 100 }));
    expect(r.candidates).toEqual(['src/a/deep.ts', 'src/a', 'src/b.ts', 'src', '']);
  });
});

describe('cartographerDetect.runDetect — refusal taxonomy (each feeds the breaker)', () => {
  it('index missing → NOT a refusal, indexMissing:true (boot scaffold builds it)', () => {
    fs.rmSync(indexPath, { force: true });
    const r = runDetect(input());
    expect(r.refused).toBe(false);
    expect(r.indexMissing).toBe(true);
  });

  it('over-size index → refused detect-index-too-large (BEFORE the parse)', () => {
    writeIndex({ 'a.ts': { kind: 'file' } });
    const r = runDetect(input({ maxIndexBytes: 10 }));
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toBe('detect-index-too-large');
  });

  it('corrupt index → refused detect-index-unreadable', () => {
    fs.writeFileSync(indexPath, '{ this is not json');
    const r = runDetect(input());
    expect(r.refused).toBe(true);
    expect(r.refusalReason).toBe('detect-index-unreadable');
  });

  it('git failure → refused detect-git-error (NEVER "every node path-gone")', () => {
    writeIndex({ 'a.ts': { kind: 'file' } });
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-nogit-'));
    try {
      const r = runDetect(input({ projectDir: nonGit }));
      expect(r.refused).toBe(true);
      expect(r.refusalReason).toBe('detect-git-error');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe('cartographerDetect.runDetect — snapshot sample + freshness', () => {
  it('stale sample is bounded by snapshotSampleMax and excludes secret-bearing paths', () => {
    const nodes: Record<string, { kind: 'file' }> = { 'src/.env': { kind: 'file' }, 'src/secrets.ts': { kind: 'file' } };
    for (let i = 0; i < 20; i++) nodes[`src/f${i}.ts`] = { kind: 'file' };
    writeIndex(nodes);
    const r = runDetect(input({ snapshotSampleMax: 5 }));
    expect(r.staleSample.length).toBe(5);
    expect(r.staleTotal).toBe(22); // total counts everything, including secret-bearing
    const sampled = r.staleSample.map((e) => e.path);
    expect(sampled).not.toContain('src/.env');
    expect(sampled).not.toContain('src/secrets.ts');
  });

  it('freshness aggregate uses index-entry firstSeenAt/authorFailed (zero node files)', () => {
    writeIndex({
      'old.ts': { kind: 'file', codeHash: null, firstSeenAt: '2020-01-01T00:00:00.000Z' }, // past grace
      'new.ts': { kind: 'file', codeHash: null, firstSeenAt: '2026-01-02T00:00:00.000Z' }, // within grace
      'q.ts': { kind: 'file', codeHash: null, authorFailed: true },
    });
    const r = runDetect(input({ graceMs: 1000 }));
    expect(r.freshness.neverAuthoredPastGrace).toBeGreaterThanOrEqual(1);
    expect(r.freshness.neverAuthoredWithinGrace).toBeGreaterThanOrEqual(1);
    expect(r.freshness.authorFailedCount).toBe(1);
  });
});

describe('cartographerDetect.runDetect — anti-starvation defer (index-sourced)', () => {
  it('a dir candidate evicted by the bound, with a candidate child, gets staleSincePass bumped + persisted', () => {
    // maxCandidates=1 → only the deepest child is selected; the parent dir is evicted
    // but still has a candidate child → its staleSincePass increments in the index.
    writeIndex({
      'src': { kind: 'dir', hasChildren: true, staleSincePass: 2 },
      'src/deep.ts': { kind: 'file' },
    });
    const r = runDetect(input({ maxCandidates: 1, maxNodesPerPass: 1 }));
    expect(r.deferredApplied).toBeGreaterThanOrEqual(1);
    const reread = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as CartographerIndex;
    expect(reread.nodes['src'].staleSincePass).toBe(3); // 2 → 3, persisted by the detect-phase write
  });
});

describe('cartographerDetect.applyIndexDeltas — author-phase write', () => {
  it('applies summary deltas to the index in one write', () => {
    writeIndex({ 'a.ts': { kind: 'file' }, 'b.ts': { kind: 'file' } });
    const res = applyIndexDeltas({
      indexPath, maxIndexBytes: 256 * 1024 * 1024,
      deltas: [{ path: 'a.ts', summaryUpdatedAt: '2026-06-12T00:00:00.000Z', codeHash: 'abc', staleSincePass: 0, authorFailed: false }],
    });
    expect(res.written).toBe(1);
    const reread = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as CartographerIndex;
    expect(reread.nodes['a.ts'].codeHash).toBe('abc');
    expect(reread.nodes['a.ts'].summaryUpdatedAt).toBe('2026-06-12T00:00:00.000Z');
    expect(reread.nodes['b.ts'].codeHash).toBe(null); // untouched
  });

  it('no deltas → no write, no refusal', () => {
    writeIndex({ 'a.ts': { kind: 'file' } });
    const res = applyIndexDeltas({ indexPath, maxIndexBytes: 256 * 1024 * 1024, deltas: [] });
    expect(res.written).toBe(0);
    expect(res.refused).toBe(false);
  });
});
