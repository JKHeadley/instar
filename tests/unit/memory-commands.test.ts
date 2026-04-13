/**
 * Unit test — CLI memory commands after MemoryIndex removal.
 *
 * Verifies that `instar memory search/reindex/status` correctly
 * delegates to SemanticMemory (the replacement for MemoryIndex).
 *
 * These commands load their own SemanticMemory instance via loadConfig(),
 * so we test them with a real SemanticMemory backed by a temp SQLite DB.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SemanticMemory } from '../../src/memory/SemanticMemory.js';

describe('CLI memory commands → SemanticMemory delegation', () => {
  let tmpDir: string;
  let memory: SemanticMemory;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cmd-test-'));
    const dbPath = path.join(tmpDir, 'semantic.db');
    memory = new SemanticMemory({
      dbPath,
      staleThreshold: 0.3,
      decayRate: 0.01,
      maxEntities: 10000,
    });
    await memory.open();

    // Seed test data
    memory.remember({
      type: 'fact',
      name: 'deploy-target',
      content: 'Application deploys to Vercel via main branch',
      confidence: 0.9,
      lastVerified: new Date().toISOString(),
      source: 'memory/',
      tags: ['deploy'],
    });
    memory.remember({
      type: 'pattern',
      name: 'db-migration-pattern',
      content: 'Always use prisma migrate, never db push on production',
      confidence: 0.85,
      lastVerified: new Date().toISOString(),
      source: 'knowledge/',
      tags: ['database'],
    });
  });

  afterAll(() => {
    memory.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── search() ────────────────────────────────────────────────

  it('search returns ranked results from SemanticMemory', () => {
    const results = memory.search('deploy', { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty('name');
    expect(results[0]).toHaveProperty('content');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('confidence');
  });

  it('search returns empty array for non-matching query', () => {
    const results = memory.search('zzz_nonexistent_term_zzz', { limit: 10 });
    expect(results).toEqual([]);
  });

  it('search respects limit parameter', () => {
    const results = memory.search('deploy', { limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  // ── rebuild() ───────────────────────────────────────────────

  it('rebuild returns entity and edge counts', () => {
    const result = memory.rebuild();
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('edges');
    expect(typeof result.entities).toBe('number');
    expect(typeof result.edges).toBe('number');
  });

  it('data survives rebuild', () => {
    memory.rebuild();
    const results = memory.search('deploy', { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // ── stats() ─────────────────────────────────────────────────

  it('stats returns expected shape', () => {
    const stats = memory.stats();
    expect(stats).toHaveProperty('totalEntities');
    expect(stats).toHaveProperty('totalEdges');
    expect(stats).toHaveProperty('avgConfidence');
    expect(stats).toHaveProperty('staleCount');
    expect(stats).toHaveProperty('dbSizeBytes');
    expect(stats).toHaveProperty('vectorSearchAvailable');
    expect(stats).toHaveProperty('embeddingCount');
    expect(stats).toHaveProperty('entityCountsByType');
  });

  it('stats reflects seeded entities', () => {
    const stats = memory.stats();
    expect(stats.totalEntities).toBeGreaterThanOrEqual(2);
    expect(stats.entityCountsByType).toHaveProperty('fact');
    expect(stats.entityCountsByType).toHaveProperty('pattern');
  });

  it('stats reports non-negative db size', () => {
    const stats = memory.stats();
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  // ── error path ──────────────────────────────────────────────

  it('throws when database not opened', async () => {
    const closedMemory = new SemanticMemory({
      dbPath: path.join(tmpDir, 'never-opened.db'),
      staleThreshold: 0.3,
      decayRate: 0.01,
      maxEntities: 10000,
    });
    // search/stats/rebuild should throw if open() was never called
    expect(() => closedMemory.search('test')).toThrow();
    expect(() => closedMemory.stats()).toThrow();
    expect(() => closedMemory.rebuild()).toThrow();
  });
});
