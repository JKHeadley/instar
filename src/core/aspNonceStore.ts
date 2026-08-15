/**
 * Durable replay defence for Agent-Signature Provenance.
 *
 * The signature on a replayed message is genuine — it IS the original signature —
 * so cryptography alone cannot separate an original from a byte-identical copy.
 * Only single-use nonce state can, which means that state is load-bearing
 * security, not a cache. A process-local store loses replay defence at every
 * restart, and a restart is exactly when an attacker holding a captured message
 * would retry.
 *
 * Retention is bounded by the verifier's freshness window: a tag older than the
 * window is rejected on age alone, so a nonce that has aged out can be evicted
 * without weakening the guarantee. That is what keeps this file from growing
 * without limit.
 */

import fs from 'fs';
import path from 'path';
import type { SeenNonceStore } from './agentSignatureProvenance.js';
import { atomicWriteFileSync } from './hostSemaphoreCore.js';

interface NonceFile {
  version: 1;
  /** key -> expiry epoch ms */
  entries: Record<string, number>;
}

const EMPTY: NonceFile = { version: 1, entries: {} };

/**
 * Hard ceiling on retained nonces. Reaching it means entries are arriving faster
 * than the freshness window retires them; we drop the soonest-to-expire first,
 * because those are the ones age will reject anyway.
 */
const MAX_ENTRIES = 50_000;

export interface FileSeenNonceStoreOptions {
  /** Absolute path to the state file. */
  filePath: string;
  /** Test seam. Defaults to Date.now. */
  now?: () => number;
}

export class FileSeenNonceStore implements SeenNonceStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private entries: Map<string, number>;
  private dirty = false;

  constructor(opts: FileSeenNonceStoreOptions) {
    this.filePath = opts.filePath;
    this.now = opts.now ?? (() => Date.now());
    this.entries = new Map(Object.entries(this.read().entries));
  }

  has(key: string): boolean {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      // Aged out: the verifier's freshness check would reject this tag anyway.
      this.entries.delete(key);
      this.dirty = true;
      return false;
    }
    return true;
  }

  add(key: string, expiresAtMs: number): void {
    this.entries.set(key, expiresAtMs);
    this.dirty = true;
    this.evictIfNeeded();
    // Write through immediately. Batching would open a window in which an
    // accepted message is not yet recorded, and a crash inside that window
    // would silently restore replayability for that nonce.
    this.flush();
  }

  /** Persist pending changes. Safe to call when clean (no-op). */
  flush(): void {
    if (!this.dirty) return;
    const body: NonceFile = { version: 1, entries: Object.fromEntries(this.entries) };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(this.filePath, `${JSON.stringify(body)}\n`, {
      mode: 0o600,
      operation: 'asp-nonce-store:write',
    });
    this.dirty = false;
  }

  /** Number of live (unexpired) entries. Diagnostics only. */
  size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [k, exp] of this.entries) {
      if (exp <= now) {
        this.entries.delete(k);
        this.dirty = true;
      }
    }
  }

  private evictIfNeeded(): void {
    this.purgeExpired();
    if (this.entries.size <= MAX_ENTRIES) return;
    // Drop soonest-to-expire first: those are closest to being age-rejected.
    const sorted = [...this.entries.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of sorted.slice(0, this.entries.size - MAX_ENTRIES)) {
      this.entries.delete(k);
    }
    this.dirty = true;
  }

  /**
   * Read the backing file.
   *
   * FAIL-CLOSED on damage. A corrupt or unreadable store must not silently
   * become an empty store: an empty store accepts every replay, which is the
   * exact attack this file exists to stop. We surface the damage by throwing,
   * so a caller decides — rather than inheriting a silently disarmed guard.
   */
  private read(): NonceFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, entries: {} };
      throw new Error(
        `asp-nonce-store: cannot read ${this.filePath} (${(err as Error).message}). ` +
          `Refusing to start with no replay defence.`
      );
    }
    if (raw.trim() === '') return { ...EMPTY, entries: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `asp-nonce-store: ${this.filePath} is corrupt. Refusing to treat a damaged ` +
          `store as empty, because an empty store accepts every replay.`
      );
    }
    const file = parsed as Partial<NonceFile>;
    if (file?.version !== 1 || typeof file.entries !== 'object' || file.entries === null) {
      throw new Error(`asp-nonce-store: ${this.filePath} has an unrecognised shape.`);
    }
    const entries: Record<string, number> = {};
    for (const [k, v] of Object.entries(file.entries)) {
      if (typeof v === 'number' && Number.isFinite(v)) entries[k] = v;
    }
    return { version: 1, entries };
  }
}
