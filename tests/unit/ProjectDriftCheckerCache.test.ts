/**
 * Unit tests for ProjectDriftCheckerCache.
 *
 * Covers:
 *   - Hit / miss
 *   - Cache key includes promptTemplateVersion, modelId, sortedFileHashes,
 *     specBodySha — so any of them changing yields a fresh key (and miss).
 *   - Mtime fast-path: when an entry exists and all file mtimes match,
 *     a hit is returned without recomputing the cache key.
 *   - Mtime invalidation: bumping the mtime forces a recomputation.
 *   - TTL expiry: entries past TTL miss.
 *   - Disk persistence: a fresh checker instance reloads prior verdicts.
 *   - invalidate() removes an entry.
 *   - Snapshot tolerates corruption.
 *   - Set-shrink / set-grow correctly invalidate the fast-path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectDriftCheckerCache,
  computeCacheKey,
  SNAPSHOT_FILENAME,
} from '../../src/core/ProjectDriftCheckerCache.js';
import type { DriftVerdict } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cache-'));
}

function writeFile(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

function noDrift(): DriftVerdict {
  return {
    verdict: 'no-drift',
    rationale: 'all good',
    evidenceCitations: [],
  };
}

describe('ProjectDriftCheckerCache', () => {
  let dir: string;
  let workdir: string;

  beforeEach(() => {
    dir = makeDir();
    workdir = makeDir();
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ProjectDriftCheckerCache.test.ts:afterEach-dir' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(workdir, { recursive: true, force: true, operation: 'tests/unit/ProjectDriftCheckerCache.test.ts:afterEach-workdir' }); } catch { /* ignore */ }
  });

  it('misses on first lookup and returns a stable key', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const filePath = writeFile(workdir, 'a.ts', 'export const a = 1;');
    const result = c.lookup({
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [filePath],
      referencedFileBytes: [fs.readFileSync(filePath)],
      specBytes: fs.readFileSync(specPath),
    });
    expect(result.hit).toBe(false);
    if (!result.hit) {
      expect(typeof result.key).toBe('string');
      expect(result.key.length).toBeGreaterThan(20);
    }
  });

  it('hits via the mtime fast-path when nothing changed', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const filePath = writeFile(workdir, 'a.ts', 'A');
    const input = {
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [filePath],
      referencedFileBytes: [fs.readFileSync(filePath)],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c.lookup(input);
    expect(miss.hit).toBe(false);
    if (miss.hit) return;
    c.put(input, miss.key, noDrift());
    const hit = c.lookup(input);
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      expect(hit.mtimeFastPath).toBe(true);
      expect(hit.verdict.verdict).toBe('no-drift');
    }
  });

  it('falls back to full-hash key when a file mtime moves but content matches', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const filePath = writeFile(workdir, 'a.ts', 'A');
    const input = () => ({
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [filePath],
      referencedFileBytes: [fs.readFileSync(filePath)],
      specBytes: fs.readFileSync(specPath),
    });
    const miss = c.lookup(input());
    if (miss.hit) throw new Error('expected miss');
    c.put(input(), miss.key, noDrift());
    // Touch the file (same content) to bump mtime.
    const ms = Date.now() / 1000 + 60; // 1 minute in the future
    fs.utimesSync(filePath, ms, ms);
    const hit = c.lookup(input());
    expect(hit.hit).toBe(true);
    if (hit.hit) {
      // Full-hash path matched because content is unchanged.
      expect(hit.mtimeFastPath).toBe(false);
    }
  });

  it('misses when file CONTENT changes (cache key shifts)', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const filePath = writeFile(workdir, 'a.ts', 'A');
    const v1 = () => ({
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [filePath],
      referencedFileBytes: [fs.readFileSync(filePath)],
      specBytes: fs.readFileSync(specPath),
    });
    const miss = c.lookup(v1());
    if (miss.hit) throw new Error();
    c.put(v1(), miss.key, noDrift());
    fs.writeFileSync(filePath, 'A_CHANGED');
    const result = c.lookup({
      ...v1(),
      referencedFileBytes: [fs.readFileSync(filePath)],
    });
    expect(result.hit).toBe(false);
  });

  it('misses when promptTemplateVersion bumps', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const base = {
      projectId: 'p',
      roundIndex: 0,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [],
      referencedFileBytes: [],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c.lookup({ ...base, promptTemplateVersion: 1 });
    if (miss.hit) throw new Error();
    c.put({ ...base, promptTemplateVersion: 1 }, miss.key, noDrift());
    const result = c.lookup({ ...base, promptTemplateVersion: 2 });
    expect(result.hit).toBe(false);
  });

  it('misses when modelId changes', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const base = {
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      specPath,
      referencedFilePaths: [],
      referencedFileBytes: [],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c.lookup({ ...base, modelId: 'fast' });
    if (miss.hit) throw new Error();
    c.put({ ...base, modelId: 'fast' }, miss.key, noDrift());
    const result = c.lookup({ ...base, modelId: 'capable' });
    expect(result.hit).toBe(false);
  });

  it('TTL expiry forces miss', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false, ttlMs: 5 });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const input = {
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [],
      referencedFileBytes: [],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c.lookup(input);
    if (miss.hit) throw new Error();
    c.put(input, miss.key, noDrift());
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = c.lookup(input);
        expect(result.hit).toBe(false);
        resolve();
      }, 50);
    });
  });

  it('invalidate() removes an entry', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const input = {
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [],
      referencedFileBytes: [],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c.lookup(input);
    if (miss.hit) throw new Error();
    c.put(input, miss.key, noDrift());
    expect(c.size()).toBe(1);
    c.invalidate('p', 0);
    expect(c.size()).toBe(0);
  });

  it('persists across instances when persist=true', () => {
    const c1 = new ProjectDriftCheckerCache({ stateDir: dir, persist: true });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const input = {
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [],
      referencedFileBytes: [],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c1.lookup(input);
    if (miss.hit) throw new Error();
    c1.put(input, miss.key, noDrift());

    // Snapshot file exists.
    expect(fs.existsSync(path.join(dir, SNAPSHOT_FILENAME))).toBe(true);

    // Fresh instance picks it up.
    const c2 = new ProjectDriftCheckerCache({ stateDir: dir, persist: true });
    const result = c2.lookup(input);
    expect(result.hit).toBe(true);
  });

  it('tolerates a corrupt snapshot on reload', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SNAPSHOT_FILENAME), 'not json');
    // Should not throw.
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: true });
    expect(c.size()).toBe(0);
  });

  it('invalidates the fast-path when referenced-file SET changes', () => {
    const c = new ProjectDriftCheckerCache({ stateDir: dir, persist: false });
    const specPath = writeFile(workdir, 'spec.md', '# spec');
    const fileA = writeFile(workdir, 'a.ts', 'A');
    const fileB = writeFile(workdir, 'b.ts', 'B');
    const v1 = {
      projectId: 'p',
      roundIndex: 0,
      promptTemplateVersion: 1,
      modelId: 'fast',
      specPath,
      referencedFilePaths: [fileA],
      referencedFileBytes: [fs.readFileSync(fileA)],
      specBytes: fs.readFileSync(specPath),
    };
    const miss = c.lookup(v1);
    if (miss.hit) throw new Error();
    c.put(v1, miss.key, noDrift());
    // Add a second file to the referenced set.
    const v2 = {
      ...v1,
      referencedFilePaths: [fileA, fileB],
      referencedFileBytes: [fs.readFileSync(fileA), fs.readFileSync(fileB)],
    };
    const result = c.lookup(v2);
    expect(result.hit).toBe(false);
  });
});

describe('computeCacheKey', () => {
  it('is deterministic across file-order permutations', () => {
    const spec = Buffer.from('# spec');
    const a = { relPath: 'a.ts', bytes: Buffer.from('A') };
    const b = { relPath: 'b.ts', bytes: Buffer.from('B') };
    const k1 = computeCacheKey(1, 'fast', spec, [a, b]);
    const k2 = computeCacheKey(1, 'fast', spec, [b, a]);
    expect(k1).toBe(k2);
  });

  it('changes when ANY input changes', () => {
    const spec = Buffer.from('# spec');
    const a = { relPath: 'a.ts', bytes: Buffer.from('A') };
    const baseline = computeCacheKey(1, 'fast', spec, [a]);
    expect(computeCacheKey(2, 'fast', spec, [a])).not.toBe(baseline);
    expect(computeCacheKey(1, 'capable', spec, [a])).not.toBe(baseline);
    expect(computeCacheKey(1, 'fast', Buffer.from('# different'), [a])).not.toBe(baseline);
    expect(
      computeCacheKey(1, 'fast', spec, [{ relPath: 'a.ts', bytes: Buffer.from('A_DIFF') }])
    ).not.toBe(baseline);
    // Renaming a file with same bytes still changes the key (path is part of input).
    expect(computeCacheKey(1, 'fast', spec, [{ relPath: 'renamed.ts', bytes: Buffer.from('A') }])).not.toBe(baseline);
  });
});
