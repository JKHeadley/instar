/**
 * ProcessedIdStore — small persistent set of recently-processed a2a marker `id`s, so
 * Telegram retries / adapter restarts can't double-inject the same prompt (spec
 * MENTOR-LIVE-READINESS §Fix 2a "Processed-id ledger" + Codey's round-2 design point).
 *
 * Bounded by `maxEntries` (default 10_000) AND `maxAgeMs` (default 30 days) — whichever
 * evicts first. **Bounded eviction is the same surface adversarial F2 worried about**:
 * an `id` that ages out is no longer "duplicate" and could be re-injected by a replayer
 * who captured it. The marker's `ts` + skew-window (24h default) is the defense at the
 * primitive layer; this store's eviction policy is set generously so legitimate retries
 * within hours/days are still de-duped.
 *
 * Convention note: instar prefers SQLite for durable dedup ledgers (MessageProcessingLedger,
 * CommitmentTracker). This store uses a small JSON file because the working set is small
 * (per-mentee processed-ids over 30d), the file is rewritten atomically on every mark, and
 * there's no concurrent-writer story to need WAL. A future bump to SQLite is a drop-in
 * replacement at the class boundary.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface ProcessedIdStoreOptions {
  /** Absolute path to the JSON file backing the store. */
  filePath: string;
  /** Max entries to retain before evicting the oldest (default 10_000). */
  maxEntries?: number;
  /** Max age (ms) before an entry is evicted (default 30 days). */
  maxAgeMs?: number;
  /** Injected for testability. Default: Date.now. */
  now?: () => number;
}

interface ProcessedRecord {
  ts: number;
}

interface PersistedFile {
  /** Schema version of the JSON layout (bumps are explicit). */
  v: 1;
  /** id → first-seen-ts. */
  entries: Record<string, number>;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class ProcessedIdStore {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private entries: Map<string, ProcessedRecord>;

  constructor(opts: ProcessedIdStoreOptions) {
    this.filePath = opts.filePath;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = opts.now ?? Date.now;
    this.entries = new Map();
    this.load();
  }

  /** True if the id has been marked + has not been evicted. */
  hasProcessed(id: string): boolean {
    this.evictExpired();
    return this.entries.has(id);
  }

  /** Mark this id processed at now() and persist. Idempotent (re-marking is a no-op
   *  beyond refreshing the persisted snapshot). */
  markProcessed(id: string): void {
    if (!this.entries.has(id)) {
      this.entries.set(id, { ts: this.now() });
    }
    this.evictExpired();
    this.evictOverflow();
    this.persist();
  }

  /** Test helper: current entry count. */
  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedFile;
      if (parsed && parsed.v === 1 && parsed.entries && typeof parsed.entries === 'object') {
        for (const [id, ts] of Object.entries(parsed.entries)) {
          if (typeof ts === 'number' && Number.isFinite(ts)) {
            this.entries.set(id, { ts });
          }
        }
      }
    } catch {
      // Corrupted store → start fresh (full re-allow). Better than crashing the recipient
      // — duplicate prompts are recoverable; a dead recipient isn't.
      this.entries = new Map();
    }
  }

  private persist(): void {
    const file: PersistedFile = {
      v: 1,
      entries: Object.fromEntries([...this.entries].map(([id, r]) => [id, r.ts])),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      SafeFsExecutor.atomicWriteJsonSync(this.filePath, file, { operation: 'ProcessedIdStore.persist' });
    } catch (err) {
      // Best-effort persistence; on the next mark we retry.
      // eslint-disable-next-line no-console
      console.warn(`[a2a-processed-id] persist failed (non-fatal) at ${this.filePath}:`, err instanceof Error ? err.message : String(err));
    }
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, r] of this.entries) {
      if (r.ts < cutoff) this.entries.delete(id);
    }
  }

  private evictOverflow(): void {
    if (this.entries.size <= this.maxEntries) return;
    // Drop oldest first.
    const sorted = [...this.entries].sort((a, b) => a[1].ts - b[1].ts);
    const dropCount = this.entries.size - this.maxEntries;
    for (let i = 0; i < dropCount; i++) {
      this.entries.delete(sorted[i][0]);
    }
  }
}
