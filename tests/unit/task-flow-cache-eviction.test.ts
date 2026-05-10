/**
 * Tests for TaskFlow Phase 5 — LRU cache eviction tuning.
 * Spec: docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Phase 5 line 652.
 *
 * Real SQLite (no mocking). Verifies:
 *  - cache cap is enforced (size never exceeds maxEntries)
 *  - LRU order is updated on access (recently-accessed keys survive)
 *  - taskflow_cache_evictions_total metric increments on eviction
 *  - The LruCache helper preserves insertion order semantics on cold inserts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { LruCache } from '../../src/tasks/LruCache.js';
import { CreateFlowInput } from '../../src/tasks/task-flow-types.js';

interface TestRig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function rig(maxEntries = 3): Promise<TestRig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cache-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const clock = { now: 1_700_000_000_000 };
  const registry = new TaskFlowRegistry({
    store,
    now: () => clock.now,
    cache: { maxEntries },
    // Make rate limits permissive so they don't interfere.
    rateLimits: {
      createPerSecPerController: 1_000_000,
      maxActivePerController: 1_000_000,
      pingPerMinPerFlow: 1_000_000,
    },
  });
  return {
    dir,
    store,
    registry,
    clock,
    cleanup: async () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/task-flow-cache-eviction.test.ts' });
    },
  };
}

function inputFor(n: number): CreateFlowInput {
  return {
    ownerKey: `owner-${n}`,
    controllerId: 'CacheCtrl',
    controllerInstanceId: 'inst-1',
    idempotencyKey: `idem-${n}-aaaaaaaaaa`,
    goal: `g${n}`,
  };
}

describe('TaskFlowRegistry — Phase 5 LRU cache eviction', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(3); });
  afterEach(async () => { await r.cleanup(); });

  it('enforces cache cap (size never exceeds maxEntries)', async () => {
    for (let i = 0; i < 10; i++) {
      await r.registry.createFlow(inputFor(i));
    }
    expect(r.registry.cacheSize).toBeLessThanOrEqual(3);
  });

  it('increments taskflow_cache_evictions_total on eviction', async () => {
    expect(r.registry.cacheEvictionsTotal).toBe(0);
    for (let i = 0; i < 5; i++) {
      await r.registry.createFlow(inputFor(i));
    }
    // 5 inserts into a 3-slot cache → at least 2 evictions.
    expect(r.registry.cacheEvictionsTotal).toBeGreaterThanOrEqual(2);
  });

  it('emits a [metric] line on eviction with the eviction total', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 5; i++) {
        await r.registry.createFlow(inputFor(i));
      }
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      const metric = lines.find((l) => l.includes('taskflow_cache_evictions_total='));
      expect(metric).toBeDefined();
      expect(metric).toMatch(/taskflow_cache_evictions_total=\d+/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('LruCache — LRU order on access', () => {
  it('refreshes recency on get; oldest is evicted', () => {
    const cache = new LruCache<string>({ maxEntries: 3 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    expect(cache.keysInOrder()).toEqual(['a', 'b', 'c']);
    // Touch 'a' — moves it to the tail.
    cache.get('a');
    expect(cache.keysInOrder()).toEqual(['b', 'c', 'a']);
    // Insert 'd' — should evict 'b' (now oldest), NOT 'a'.
    cache.set('d', 'D');
    expect(cache.keysInOrder()).toEqual(['c', 'a', 'd']);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
  });

  it('counts evictions', () => {
    const cache = new LruCache<string>({ maxEntries: 2 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C'); // evict a
    cache.set('d', 'D'); // evict b
    expect(cache.evictionCount).toBe(2);
  });

  it('calls onEvict callback', () => {
    const evicted: Array<[string, string]> = [];
    const cache = new LruCache<string>({
      maxEntries: 2,
      onEvict: (k, v) => evicted.push([k, v]),
    });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    expect(evicted).toEqual([['a', 'A']]);
  });

  it('setMaxEntries shrinks immediately', () => {
    const cache = new LruCache<string>({ maxEntries: 5 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) cache.set(k, k.toUpperCase());
    expect(cache.size).toBe(5);
    cache.setMaxEntries(2);
    expect(cache.size).toBe(2);
    expect(cache.keysInOrder()).toEqual(['d', 'e']);
    expect(cache.evictionCount).toBe(3);
  });

  it('maxEntries=0 disables caching', () => {
    const cache = new LruCache<string>({ maxEntries: 0 });
    cache.set('a', 'A');
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });
});

describe('TaskFlowRegistry — cache reads use LRU order', () => {
  it('repeated getFlow on the same flowId keeps it hot', async () => {
    const r2 = await rig(2);
    try {
      const a = await r2.registry.createFlow(inputFor(0));
      const b = await r2.registry.createFlow(inputFor(1));
      // touch a
      r2.registry.getFlow(a.flow.flowId);
      // insert c → should evict b (older after a was touched), not a.
      const c = await r2.registry.createFlow(inputFor(2));
      // a should still be in cache; verify by checking it's still served:
      expect(r2.registry.getFlow(a.flow.flowId)?.flowId).toBe(a.flow.flowId);
      expect(r2.registry.getFlow(c.flow.flowId)?.flowId).toBe(c.flow.flowId);
    } finally {
      await r2.cleanup();
    }
  });
});
