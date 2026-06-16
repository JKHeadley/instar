/**
 * LocalSessionOwnershipStore — a DURABLE per-session ownership store that survives
 * restarts, replacing the in-memory-only `InMemorySessionOwnershipStore` for the
 * cross-machine session pool.
 *
 * Spec: docs/specs/live-user-channel-proof-standard.md §7.2 (transfer fix). The
 * registry/FSM/CAS logic in SessionOwnershipRegistry is store-agnostic; this swaps
 * the substrate from a process-lifetime Map to per-session JSON files (atomic
 * tmp+rename, mirroring LocalLeaseStore) PLUS an in-memory cache so the routing hot
 * path stays an in-memory read.
 *
 * Why durable matters (the live bug, 2026-06-15): a transfer wrote the target's
 * ownership record into the SOURCE machine's in-memory Map; the record vanished on
 * restart and never crossed machines. Persisting per-session lets the cross-machine
 * `OwnershipApplier` (which materializes records from the REPLICATED coherence-journal
 * placement entries) land a durable record the target machine reads as owner=self.
 *
 * This store alone is single-machine-durable. Cross-machine replication is carried
 * by the coherence-journal placement stream + OwnershipApplier (off the hot path) —
 * exactly the boundary the spec draws: durable LOCALLY here, REPLICATED there.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SessionOwnershipRecord } from './SessionOwnership.js';
import type { SessionOwnershipStore } from './SessionOwnershipRegistry.js';

export interface LocalSessionOwnershipStoreDeps {
  /** Absolute directory holding one JSON file per session ownership record. */
  dir: string;
  logger?: (msg: string) => void;
}

/** Filesystem-safe filename for a session key (topic ids are numeric, but be safe). */
function sessionFileName(sessionKey: string): string {
  // Keep it reversible-enough for debugging while jailing path traversal: any
  // char outside [A-Za-z0-9._-] becomes '_'. (A '..' sessionKey can never escape dir.)
  return `${sessionKey.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

export class LocalSessionOwnershipStore implements SessionOwnershipStore {
  private readonly d: LocalSessionOwnershipStoreDeps;
  /** Hot-path read cache: sessionKey → record. Authoritative-on-disk, cached here. */
  private readonly cache = new Map<string, SessionOwnershipRecord>();
  /** Whether the full directory has been scanned into the cache (for all()). */
  private scanned = false;

  constructor(deps: LocalSessionOwnershipStoreDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[local-ownership] ${m}`);
  }

  private filePathFor(sessionKey: string): string {
    return path.join(this.d.dir, sessionFileName(sessionKey));
  }

  /** Load one session's record from disk into the cache (idempotent). */
  private loadOne(sessionKey: string): SessionOwnershipRecord | null {
    if (this.cache.has(sessionKey)) return this.cache.get(sessionKey)!;
    try {
      const fp = this.filePathFor(sessionKey);
      if (fs.existsSync(fp)) {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf-8')) as SessionOwnershipRecord;
        if (rec && typeof rec.ownershipEpoch === 'number' && typeof rec.ownerMachineId === 'string' && rec.sessionKey === sessionKey) {
          this.cache.set(sessionKey, rec);
          return rec;
        }
      }
    } catch {
      // @silent-fallback-ok — a corrupt single-session file reads as "no record"
      // (null), so routing treats the topic as unowned and re-places. Ownership is
      // re-established by the next place/claim or by replication; a lost local copy
      // is self-healing, never authoritative-loss (same posture as LocalLeaseStore).
    }
    return null;
  }

  private persist(rec: SessionOwnershipRecord): void {
    this.cache.set(rec.sessionKey, rec);
    try {
      if (!fs.existsSync(this.d.dir)) fs.mkdirSync(this.d.dir, { recursive: true });
      const fp = this.filePathFor(rec.sessionKey);
      const tmp = `${fp}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
      fs.renameSync(tmp, fp); // atomic swap
    } catch (err) {
      // NOT silent: a persist failure is logged. The in-memory cache still reflects
      // the write so this process stays correct; durability across restart is what's
      // at risk, and the next successful write (or replication) re-establishes it.
      this.log(`persist failed for ${rec.sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  read(sessionKey: string): SessionOwnershipRecord | null {
    return this.loadOne(sessionKey);
  }

  /**
   * Fast-forward CAS: the candidate lands only if it MONOTONICALLY advances the
   * committed epoch (`candidate.ownershipEpoch > current.epoch`) — identical to
   * InMemorySessionOwnershipStore + GitLeaseStore, so SessionOwnershipRegistry's FSM
   * is unchanged regardless of substrate. Synchronous, so within this process a stale
   * competing candidate (computed from the same `current`) still loses.
   */
  casWrite(candidate: SessionOwnershipRecord): { ok: boolean; observed: SessionOwnershipRecord | null } {
    const current = this.loadOne(candidate.sessionKey);
    const curEpoch = current?.ownershipEpoch ?? 0;
    if (candidate.ownershipEpoch > curEpoch) {
      this.persist(candidate);
      return { ok: true, observed: candidate };
    }
    return { ok: false, observed: current };
  }

  /** Every known ownership record (cache + a one-time disk scan). */
  all(): SessionOwnershipRecord[] {
    if (!this.scanned) {
      try {
        if (fs.existsSync(this.d.dir)) {
          for (const f of fs.readdirSync(this.d.dir)) {
            if (!f.endsWith('.json')) continue;
            try {
              const rec = JSON.parse(fs.readFileSync(path.join(this.d.dir, f), 'utf-8')) as SessionOwnershipRecord;
              if (rec && typeof rec.ownershipEpoch === 'number' && typeof rec.sessionKey === 'string') {
                // Cache only if fresher than (or absent in) the in-memory copy.
                const existing = this.cache.get(rec.sessionKey);
                if (!existing || rec.ownershipEpoch >= existing.ownershipEpoch) this.cache.set(rec.sessionKey, rec);
              }
            } catch { /* @silent-fallback-ok — skip a corrupt single file in the scan; others still load */ }
          }
        }
      } catch { /* @silent-fallback-ok — an unreadable dir yields the cache-only view, never a throw */ }
      this.scanned = true;
    }
    return [...this.cache.values()];
  }
}
