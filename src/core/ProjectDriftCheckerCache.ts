/**
 * ProjectDriftCheckerCache — verdict cache with mtime fast-path.
 *
 * Spec: docs/specs/PROJECT-SCOPE-SPEC.md § Phase 1.4 ("Cache key" + mtime
 * fast-path).
 *
 * Cache key:  sha256(promptTemplateVersion + modelId + specBodySha + sortedFileHashes)
 * TTL:        24h (cache entries older than this are treated as misses)
 *
 * Mtime fast-path:
 *   Before computing the cache key, the cache compares (specPath mtime,
 *   referencedFile mtimes) to the values it last saw associated with the
 *   stored entry. If every mtime matches, the cache key is REUSED without
 *   re-hashing — file contents haven't changed. If any mtime moved, full
 *   hashing falls back. This is the spec's stated optimization: hashing
 *   only happens when an mtime moved.
 *
 * Storage:
 *   In-memory Map keyed by `${projectId}:${roundIndex}` (the natural id
 *   for a drift check). Disk-backed snapshot at
 *   `.instar/drift-verdict-cache.json` so the cache survives restarts
 *   without a cold first-call penalty after a sleep/wake.
 *
 * Concurrency:
 *   This cache is consulted INSIDE the per-project mutex held by
 *   `POST /projects/:id/drift-check` (Phase 1.5 round runner has its own
 *   round-runner lock). Within a single process there's no race; across
 *   processes the JSON snapshot is read on construction and written on
 *   every put, atomically (tmp + rename).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { DriftVerdict } from './types.js';

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const SNAPSHOT_FILENAME = 'drift-verdict-cache.json';

export interface ProjectDriftCheckerCacheConfig {
  /** Absolute path to the agent's `.instar/` directory. */
  stateDir: string;
  /** Override the 24h TTL (tests dial this down). */
  ttlMs?: number;
  /** When false, the cache does not read/write disk (in-memory only). */
  persist?: boolean;
}

export interface CacheLookupInput {
  projectId: string;
  roundIndex: number;
  /** Bumped on every prompt-template edit; part of the cache key. */
  promptTemplateVersion: number;
  /** Resolved model id from the provider; part of the cache key. */
  modelId: string;
  /** Absolute path to the spec file (used for mtime fast-path). */
  specPath: string;
  /** Absolute paths to referenced files. Order matters for fast-path but
   *  not for the cache key (sortedFileHashes is order-stable). */
  referencedFilePaths: string[];
  /** Buffers, in the same order as `referencedFilePaths`. Used to compute
   *  sha256 inputs when mtime fast-path misses. */
  referencedFileBytes: Buffer[];
  /** Spec body bytes — sha256 input. */
  specBytes: Buffer;
}

export interface CacheHit {
  hit: true;
  verdict: DriftVerdict;
  computedAt: string;
  /** Cache key that matched. */
  key: string;
  /** True if served by the mtime fast-path (no re-hash performed). */
  mtimeFastPath: boolean;
}
export interface CacheMiss {
  hit: false;
  /** Cache key the caller should associate with the verdict on put(). */
  key: string;
}

export type CacheLookupResult = CacheHit | CacheMiss;

interface CacheEntry {
  key: string;
  verdict: DriftVerdict;
  computedAt: string; // ISO
  /** Captured at write time; the mtime fast-path requires both to match. */
  promptTemplateVersion: number;
  modelId: string;
  /** mtime in ms, captured at write time. Used by the fast-path on next read. */
  specMtimeMs: number;
  /** Map of relativeOrAbsolutePath → mtime ms at write time. */
  referencedFileMtimesMs: Record<string, number>;
}

export class ProjectDriftCheckerCache {
  private stateDir: string;
  private ttlMs: number;
  private persist: boolean;
  private entries = new Map<string, CacheEntry>();

  constructor(config: ProjectDriftCheckerCacheConfig) {
    this.stateDir = config.stateDir;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.persist = config.persist ?? true;
    if (this.persist) this.loadSnapshot();
  }

  /**
   * Look up an entry for `(projectId, roundIndex)`. Returns a hit ONLY if:
   *   (a) an entry exists, AND
   *   (b) the entry is within the TTL, AND
   *   (c) either the mtime fast-path matches (no re-hash needed) OR the
   *       full sha256 cache key matches.
   *
   * On miss, the returned `key` is the freshly-computed sha256, which the
   * caller should pass back to `put()` after running drift.
   */
  lookup(input: CacheLookupInput): CacheLookupResult {
    const entryId = `${input.projectId}:${input.roundIndex}`;
    const existing = this.entries.get(entryId);
    const now = Date.now();

    // ── Mtime fast-path ──────────────────────────────────────────
    // Cheap: verify the non-content cache-key inputs (templateVersion,
    // modelId) match, then stat() each file and compare mtimes to the
    // recorded mtimes. If everything matches, the cached entry is still
    // valid and the cache key the entry holds is the one that matches
    // the current bytes — we don't need to re-hash.
    if (
      existing &&
      now - Date.parse(existing.computedAt) < this.ttlMs &&
      existing.promptTemplateVersion === input.promptTemplateVersion &&
      existing.modelId === input.modelId
    ) {
      try {
        const specMtime = fs.statSync(input.specPath).mtimeMs;
        if (specMtime === existing.specMtimeMs) {
          const allMatch = input.referencedFilePaths.every((p) => {
            const recorded = existing.referencedFileMtimesMs[p];
            if (recorded === undefined) return false;
            try {
              return fs.statSync(p).mtimeMs === recorded;
            } catch {
              return false;
            }
          });
          // Also require referenced set hasn't shrunk OR grown
          const sameSet =
            Object.keys(existing.referencedFileMtimesMs).length === input.referencedFilePaths.length;
          if (allMatch && sameSet) {
            return {
              hit: true,
              verdict: existing.verdict,
              computedAt: existing.computedAt,
              key: existing.key,
              mtimeFastPath: true,
            };
          }
        }
      } catch {
        // statSync failure on the spec or a referenced file = treat as miss.
      }
    }

    // ── Full hash path ───────────────────────────────────────────
    const key = computeCacheKey(
      input.promptTemplateVersion,
      input.modelId,
      input.specBytes,
      input.referencedFilePaths.map((p, i) => ({
        relPath: p,
        bytes: input.referencedFileBytes[i] ?? Buffer.alloc(0),
      }))
    );
    if (existing && existing.key === key && now - Date.parse(existing.computedAt) < this.ttlMs) {
      return {
        hit: true,
        verdict: existing.verdict,
        computedAt: existing.computedAt,
        key,
        mtimeFastPath: false,
      };
    }
    return { hit: false, key };
  }

  /**
   * Store `verdict` under `(projectId, roundIndex)` keyed by `key`. Captures
   * file mtimes for the next mtime fast-path lookup.
   *
   * `manual-review-required` verdicts ARE cached too — re-running drift
   * immediately won't change a deterministic over-budget or
   * empty-spec answer. The TTL still expires them after 24h.
   */
  put(
    input: CacheLookupInput,
    key: string,
    verdict: DriftVerdict
  ): void {
    const entryId = `${input.projectId}:${input.roundIndex}`;
    const referencedFileMtimesMs: Record<string, number> = {};
    let specMtimeMs = 0;
    try {
      specMtimeMs = fs.statSync(input.specPath).mtimeMs;
    } catch {
      // Spec gone — caller will probably get an `empty-spec` verdict
      // anyway; record a zero so the next fast-path correctly invalidates.
    }
    for (const p of input.referencedFilePaths) {
      try {
        referencedFileMtimesMs[p] = fs.statSync(p).mtimeMs;
      } catch {
        referencedFileMtimesMs[p] = -1; // Forces a future miss.
      }
    }
    this.entries.set(entryId, {
      key,
      verdict,
      computedAt: new Date().toISOString(),
      promptTemplateVersion: input.promptTemplateVersion,
      modelId: input.modelId,
      specMtimeMs,
      referencedFileMtimesMs,
    });
    if (this.persist) this.saveSnapshot();
  }

  /** Remove an entry for `(projectId, roundIndex)`. */
  invalidate(projectId: string, roundIndex: number): void {
    this.entries.delete(`${projectId}:${roundIndex}`);
    if (this.persist) this.saveSnapshot();
  }

  /** For tests / digest. */
  size(): number {
    return this.entries.size;
  }

  // ── Snapshot persistence (atomic write) ───────────────────────────

  private snapshotPath(): string {
    return path.join(this.stateDir, SNAPSHOT_FILENAME);
  }

  private loadSnapshot(): void {
    const p = this.snapshotPath();
    if (!fs.existsSync(p)) return;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const obj = JSON.parse(raw) as { entries: Array<[string, CacheEntry]> };
      if (!obj || !Array.isArray(obj.entries)) return;
      for (const [id, entry] of obj.entries) {
        if (typeof id !== 'string') continue;
        if (!entry || typeof entry !== 'object') continue;
        if (typeof entry.key !== 'string') continue;
        this.entries.set(id, entry);
      }
    } catch {
      // Corrupt snapshot → start fresh, will be overwritten on next put.
    }
  }

  private saveSnapshot(): void {
    if (!fs.existsSync(this.stateDir)) fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = this.snapshotPath() + '.tmp';
    const body = JSON.stringify({ entries: Array.from(this.entries.entries()) });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.snapshotPath());
  }
}

/**
 * Compute the deterministic cache key. Exported for tests and for the
 * `cacheKeyInputs` helper in ProjectDriftChecker.ts (which produces the
 * same inputs — this function hashes them into a stable string).
 */
export function computeCacheKey(
  promptTemplateVersion: number,
  modelId: string,
  specBytes: Buffer,
  referencedFileBytes: Array<{ relPath: string; bytes: Buffer }>
): string {
  const sortedFileEntries = referencedFileBytes
    .map((f) => `${f.relPath}:${crypto.createHash('sha256').update(f.bytes).digest('hex')}`)
    .sort();
  const h = crypto.createHash('sha256');
  h.update(`v=${promptTemplateVersion}\n`);
  h.update(`m=${modelId}\n`);
  h.update(`s=${crypto.createHash('sha256').update(specBytes).digest('hex')}\n`);
  for (const entry of sortedFileEntries) h.update(`f=${entry}\n`);
  return h.digest('hex');
}
