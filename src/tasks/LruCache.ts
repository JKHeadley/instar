/**
 * LruCache — bounded LRU for TaskFlowRegistry.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Phase 5 line 652
 * ("LRU cache eviction tuning").
 *
 * Implementation: leans on JavaScript Map's insertion-order iteration. On `get`
 * we delete-then-set to refresh recency. On `set` overflow we evict the oldest
 * key (Map iterator first). Eviction count is exposed for metric emission.
 */

export interface LruCacheOptions<V> {
  maxEntries: number;
  /** Optional eviction observer for metric emission. */
  onEvict?: (key: string, value: V) => void;
}

export class LruCache<V> {
  private maxEntries: number;
  private readonly map = new Map<string, V>();
  private readonly onEvict?: (key: string, value: V) => void;
  private evictions = 0;

  constructor(opts: LruCacheOptions<V>) {
    this.maxEntries = Math.max(0, opts.maxEntries | 0);
    this.onEvict = opts.onEvict;
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // refresh recency: re-insert at tail.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.maxEntries <= 0) {
      // disabled — no caching.
      return;
    }
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value as string | undefined;
      if (!firstKey) break;
      const v = this.map.get(firstKey)!;
      this.map.delete(firstKey);
      this.evictions++;
      if (this.onEvict) {
        try { this.onEvict(firstKey, v); } catch { /* swallow */ }
      }
    }
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  get evictionCount(): number {
    return this.evictions;
  }

  /** Test-only: iterate keys in LRU order (oldest first). */
  keysInOrder(): string[] {
    return Array.from(this.map.keys());
  }

  /** Resize cap; immediately evict overflow if shrinking. */
  setMaxEntries(n: number): void {
    this.maxEntries = Math.max(0, n | 0);
    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value as string | undefined;
      if (!firstKey) break;
      const v = this.map.get(firstKey)!;
      this.map.delete(firstKey);
      this.evictions++;
      if (this.onEvict) {
        try { this.onEvict(firstKey, v); } catch { /* swallow */ }
      }
    }
  }
}
