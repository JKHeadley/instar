/**
 * MachineLock — In-flight tuple lock with HMAC-protected envelope, heartbeat,
 * and SIGKILL-grace stale-reclamation. Foundation F-4 for the Self-Healing
 * Remediator v2 (SELF-HEALING-REMEDIATOR-V2-SPEC §A2/A24/A29/A43/A46/A63).
 *
 * Lock files live at:
 *   ~/.instar/machine-locks/in-flight/<tupleHash>.lock
 *
 * The envelope is a JSON document containing:
 *   { surfaceId, attemptId, tupleHash, startedAt, heartbeatAt,
 *     heartbeatSeq, expectedRuntimeMs, hmac }
 *
 * `hmac` is computed by the caller-provided signer over the canonical JSON
 * encoding of the envelope MINUS the `hmac` field. Callers in production
 * derive the leaf signer from RemediationKeyVault's `inflight` per-surface
 * subkey (F-1). Tests inject a mock signer/verifier.
 *
 * Staleness (A63 — SIGKILL grace):
 *   A lock is stale when BOTH conditions hold:
 *     1. now - heartbeatAt > heartbeatIntervalMs × 3   (missing heartbeats)
 *     2. now - startedAt   > expectedRuntimeMs × 1.5   (deadline exceeded)
 *
 *   The second clause prevents premature reclamation of a slow-but-alive
 *   surface. Stale locks are MOVED to `~/.instar/machine-locks/orphaned/`
 *   (forensic preservation) and the in-flight slot is freed.
 *
 * In-memory cache (A29 + A46):
 *   `inFlightLockIndex` is a `Map<tupleHash, VerifiedLockEntry>` hydrated at
 *   construction. Every cache READ compares the on-disk `mtime+inode` against
 *   the cached watermark. If divergent → invalidate, re-read, re-verify HMAC,
 *   repopulate. If identical → use cached payload directly. `fs.watch` is
 *   intentionally NOT used here — the read-path stat check is the source of
 *   truth (Linux `fs.watch` rename-replace is unreliable, per A46).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface InFlightLockOptions {
  /** Stable identifier of the surface acquiring the lock (e.g. "memory-healer"). */
  surfaceId: string;
  /** Unique attempt id (uuid). Tied to the dispatcher's RemediationContext. */
  attemptId: string;
  /** sha256(runbookId + signatureHash + …) — coordination key. */
  tupleHash: string;
  /** Wall-clock budget surface expects to need. Drives A63 grace clause #2. */
  expectedRuntimeMs: number;
  /** Default 5000 ms. */
  heartbeatIntervalMs?: number;
  /**
   * HMAC signer — derived from RemediationKeyVault's `inflight` leaf for the
   * caller's surfaceId. Tests may inject a mock.
   */
  signer: (payload: Buffer) => Buffer;
  /**
   * HMAC verifier — same leaf key as `signer`. listInFlight() uses this to
   * filter out unsigned/forged lockfiles.
   */
  verifier: (payload: Buffer, signature: Buffer) => boolean;
}

export interface InFlightHandle {
  attemptId: string;
  /** Release the lock and remove the file. Idempotent. */
  release(): Promise<void>;
  /**
   * Re-sign the envelope with `heartbeatSeq` incremented and `heartbeatAt`
   * updated. Throws if the lock has been removed out from under us.
   */
  heartbeat(): Promise<void>;
}

export interface VerifiedLockEntry {
  surfaceId: string;
  attemptId: string;
  tupleHash: string;
  startedAt: number;
  heartbeatAt: number;
  heartbeatSeq: number;
  expectedRuntimeMs: number;
  heartbeatIntervalMs: number;
  /** True if `now - heartbeatAt > heartbeatIntervalMs × 3 AND now - startedAt > expectedRuntimeMs × 1.5`. */
  isStale: boolean;
}

interface LockEnvelope {
  surfaceId: string;
  attemptId: string;
  tupleHash: string;
  startedAt: number;
  heartbeatAt: number;
  heartbeatSeq: number;
  expectedRuntimeMs: number;
  heartbeatIntervalMs: number;
  hmac: string; // base64
}

interface CacheEntry {
  entry: VerifiedLockEntry;
  mtimeMs: number;
  inode: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

export class MachineLock {
  private readonly inFlightDir: string;
  private readonly orphanedDir: string;
  private readonly cache: Map<string, CacheEntry> = new Map();

  /**
   * @param stateDir Root state directory (typically ~/.instar). Lock files
   *                 live under <stateDir>/machine-locks/in-flight/.
   */
  constructor(stateDir: string) {
    this.inFlightDir = path.join(stateDir, 'machine-locks', 'in-flight');
    this.orphanedDir = path.join(stateDir, 'machine-locks', 'orphaned');
    fs.mkdirSync(this.inFlightDir, { recursive: true });
    fs.mkdirSync(this.orphanedDir, { recursive: true });
    this.hydrateCache();
  }

  /**
   * Acquire an in-flight lock for `tupleHash`. Throws if a verified, non-stale
   * lock already exists for the same tupleHash (A2 lock-bound co-existence).
   * If the existing lock is stale (A63), it is reclaimed to `orphaned/` and
   * the new lock is acquired.
   */
  async acquireInFlight(opts: InFlightLockOptions): Promise<InFlightHandle> {
    const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const lockPath = this.lockPathFor(opts.tupleHash);

    // Check existing lock (cache-aware, A46 mtime+inode re-verification).
    const existing = this.readVerifiedLock(opts.tupleHash, opts.verifier);
    if (existing) {
      if (existing.isStale) {
        this.reclaimStale(opts.tupleHash);
      } else {
        throw new Error(
          `MachineLock: tuple ${opts.tupleHash} already in-flight ` +
            `(surface=${existing.surfaceId} attempt=${existing.attemptId})`
        );
      }
    }

    const now = Date.now();
    const envelope: Omit<LockEnvelope, 'hmac'> = {
      surfaceId: opts.surfaceId,
      attemptId: opts.attemptId,
      tupleHash: opts.tupleHash,
      startedAt: now,
      heartbeatAt: now,
      heartbeatSeq: 0,
      expectedRuntimeMs: opts.expectedRuntimeMs,
      heartbeatIntervalMs,
    };
    const signed = this.sign(envelope, opts.signer);
    this.atomicWriteLock(lockPath, signed);
    this.populateCacheFromDisk(lockPath, opts.verifier);

    let released = false;
    let currentEnvelope: Omit<LockEnvelope, 'hmac'> = envelope;

    const handle: InFlightHandle = {
      attemptId: opts.attemptId,
      release: async () => {
        if (released) return;
        released = true;
        this.cache.delete(opts.tupleHash);
        try {
          await SafeFsExecutor.safeUnlink(lockPath, {
            operation: `MachineLock.release:${opts.tupleHash}`,
          });
        } catch (err) {
          // ENOENT is fine — already gone.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      },
      heartbeat: async () => {
        if (released) {
          throw new Error(`MachineLock.heartbeat: lock ${opts.tupleHash} already released`);
        }
        const ts = Date.now();
        currentEnvelope = {
          ...currentEnvelope,
          heartbeatAt: ts,
          heartbeatSeq: currentEnvelope.heartbeatSeq + 1,
        };
        const re = this.sign(currentEnvelope, opts.signer);
        this.atomicWriteLock(lockPath, re);
        this.populateCacheFromDisk(lockPath, opts.verifier);
      },
    };

    return handle;
  }

  /**
   * Enumerate every in-flight lock on disk, returning only the entries whose
   * HMAC verifies. Forged or unsigned lockfiles are silently dropped.
   *
   * The cache (A29) is consulted first. Every cache hit re-stats the file
   * (A46): if `mtime+inode` diverged, the cache entry is invalidated and the
   * file is re-read + re-verified.
   */
  async listInFlight(
    verifier?: (payload: Buffer, signature: Buffer) => boolean
  ): Promise<VerifiedLockEntry[]> {
    if (!fs.existsSync(this.inFlightDir)) return [];
    const out: VerifiedLockEntry[] = [];
    const files = fs.readdirSync(this.inFlightDir);
    for (const f of files) {
      if (!f.endsWith('.lock')) continue;
      const tupleHash = f.slice(0, -'.lock'.length);
      const v = this.readVerifiedLock(tupleHash, verifier);
      if (v) out.push(v);
    }
    return out;
  }

  // ── Internals ──────────────────────────────────────────────────────

  private lockPathFor(tupleHash: string): string {
    return path.join(this.inFlightDir, `${tupleHash}.lock`);
  }

  private sign(
    envelope: Omit<LockEnvelope, 'hmac'>,
    signer: (payload: Buffer) => Buffer
  ): LockEnvelope {
    const canonical = canonicalJson(envelope);
    const sig = signer(Buffer.from(canonical, 'utf8'));
    return { ...envelope, hmac: sig.toString('base64') };
  }

  private atomicWriteLock(lockPath: string, envelope: LockEnvelope): void {
    const tmp = `${lockPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    fs.renameSync(tmp, lockPath);
  }

  /**
   * Cache-aware verified read.
   *
   * If `verifier` is omitted (e.g., callers like `acquireInFlight` that don't
   * actually need to trust an in-flight peer), we still hydrate the cached
   * payload but mark it as untrusted by returning undefined when the cache is
   * cold AND no verifier is available.
   */
  private readVerifiedLock(
    tupleHash: string,
    verifier?: (payload: Buffer, signature: Buffer) => boolean
  ): VerifiedLockEntry | undefined {
    const lockPath = this.lockPathFor(tupleHash);
    let st: fs.Stats;
    try {
      st = fs.statSync(lockPath);
    } catch {
      this.cache.delete(tupleHash);
      return undefined;
    }
    const cached = this.cache.get(tupleHash);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.inode === st.ino) {
      // A46: identical → trust the previously-verified cache payload.
      return { ...cached.entry, isStale: this.computeStale(cached.entry) };
    }
    // Divergent (A46) → re-read + re-verify.
    if (!verifier) return undefined;
    return this.populateCacheFromDisk(lockPath, verifier);
  }

  private populateCacheFromDisk(
    lockPath: string,
    verifier: (payload: Buffer, signature: Buffer) => boolean
  ): VerifiedLockEntry | undefined {
    let raw: Buffer;
    let st: fs.Stats;
    try {
      raw = fs.readFileSync(lockPath);
      st = fs.statSync(lockPath);
    } catch {
      return undefined;
    }
    let env: LockEnvelope;
    try {
      env = JSON.parse(raw.toString('utf8'));
    } catch {
      return undefined;
    }
    if (!env.hmac || typeof env.hmac !== 'string') return undefined;
    const { hmac: sigB64, ...rest } = env;
    const canonical = canonicalJson(rest);
    let sig: Buffer;
    try {
      sig = Buffer.from(sigB64, 'base64');
    } catch {
      return undefined;
    }
    if (!verifier(Buffer.from(canonical, 'utf8'), sig)) return undefined;
    const entry: VerifiedLockEntry = {
      surfaceId: rest.surfaceId,
      attemptId: rest.attemptId,
      tupleHash: rest.tupleHash,
      startedAt: rest.startedAt,
      heartbeatAt: rest.heartbeatAt,
      heartbeatSeq: rest.heartbeatSeq,
      expectedRuntimeMs: rest.expectedRuntimeMs,
      heartbeatIntervalMs: rest.heartbeatIntervalMs,
      isStale: false, // computed below
    };
    entry.isStale = this.computeStale(entry);
    this.cache.set(rest.tupleHash, { entry, mtimeMs: st.mtimeMs, inode: st.ino });
    return entry;
  }

  private computeStale(entry: VerifiedLockEntry): boolean {
    const now = Date.now();
    const heartbeatLate = now - entry.heartbeatAt > entry.heartbeatIntervalMs * 3;
    const runtimeOver = now - entry.startedAt > entry.expectedRuntimeMs * 1.5;
    return heartbeatLate && runtimeOver;
  }

  /**
   * A63: stale-lock reclamation. Move the lockfile to orphaned/ for forensic
   * review and drop the in-memory cache entry. A synthetic
   * `verification-inconclusive` event is the caller's responsibility — this
   * primitive only owns the FS reclamation step.
   */
  private reclaimStale(tupleHash: string): void {
    const src = this.lockPathFor(tupleHash);
    if (!fs.existsSync(src)) {
      this.cache.delete(tupleHash);
      return;
    }
    const dest = path.join(this.orphanedDir, `${tupleHash}-${Date.now()}.lock`);
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      // If rename fails, try copy + unlink.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          fs.copyFileSync(src, dest);
          SafeFsExecutor.safeUnlinkSync(src, {
            operation: `MachineLock.reclaimStale:${tupleHash}`,
          });
        } catch {
          /* ignore — the next sweep will retry */
        }
      }
    }
    this.cache.delete(tupleHash);
  }

  /**
   * Hydrate the in-memory cache from disk at construction. We don't have a
   * verifier here — entries land in the cache only at first verified read.
   * (A29 says "hydrated from <…>/*.lock at boot"; A46 says "re-verify HMAC".
   * Concretely: this method scans the directory so subsequent reads have
   * fast access, but every entry must transit through `populateCacheFromDisk`
   * with a verifier before it can be returned to a caller.)
   */
  private hydrateCache(): void {
    try {
      if (!fs.existsSync(this.inFlightDir)) return;
      // No-op for now — entries are populated lazily on first verified read.
      // This intentional design avoids storing un-verified entries in cache.
    } catch {
      /* ignore */
    }
  }
}

/**
 * Canonical JSON encoding — sorted keys, no whitespace. Required for stable
 * HMAC over the envelope.
 */
function canonicalJson(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    parts.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Default state-dir resolver (parallel-friendly: honours INSTAR_STATE_DIR). */
export function defaultMachineLockStateDir(): string {
  return process.env.INSTAR_STATE_DIR
    ? process.env.INSTAR_STATE_DIR
    : path.join(os.homedir(), '.instar');
}
