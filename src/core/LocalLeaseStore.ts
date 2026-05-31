/**
 * LocalLeaseStore — a git-less LeaseStore for LeaseCoordinator.
 *
 * The git-backed GitLeaseStore is the durable CAS substrate WHEN a machine has
 * git-sync available. But two real deployments have no git medium yet still need
 * lease coordination:
 *   1. A credential-less standby (the HTTP-transport "Build B" design): it joins
 *      the pool and must learn the holder WITHOUT pulling/pushing git.
 *   2. An agent whose home IS the instar source tree (e.g. the instar developer's
 *      agent home), where the SourceTreeGuard refuses GitSyncManager — so the
 *      git medium is unavailable even though gitBackup is enabled.
 *
 * Without lease coordination, a machine's `coordinator.leaseHolder` is null, so
 * MeshRpc rejects the holder's router-only commands (deliverMessage/place/
 * transfer) as `not-router` — which blocks cross-machine session transfer
 * entirely. (Found live, 2026-05-31: the lease block was nested inside the
 * git-gated try, so a gitSync throw skipped the HTTP lease transport too.)
 *
 * This store persists THIS machine's own view of the lease to a local JSON file
 * (durable across restarts) and implements the LeaseStore CAS locally. It is NOT
 * a shared substrate: cross-machine propagation is carried by HttpLeaseTransport
 * (broadcast/observe), which LeaseCoordinator folds into its effectiveView. The
 * fenced-lease acquire/observe rules prevent split-brain over the tunnel (a
 * machine that observes a valid peer lease declines to acquire). When git-sync
 * IS available, GitLeaseStore remains the stronger shared-CAS substrate.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { LeaseStore } from './LeaseCoordinator.js';
import type { LeaseRecord } from './types.js';

export interface LocalLeaseStoreDeps {
  /** Absolute path of the local lease file (persisted across restarts). */
  filePath: string;
  logger?: (msg: string) => void;
}

export class LocalLeaseStore implements LeaseStore {
  private readonly d: LocalLeaseStoreDeps;
  private cached: LeaseRecord | null = null;
  private loaded = false;

  constructor(deps: LocalLeaseStoreDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[local-lease] ${m}`);
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.d.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8')) as { lease?: unknown };
        const lease = raw?.lease as LeaseRecord | undefined;
        if (lease && typeof lease.epoch === 'number' && typeof lease.holder === 'string') {
          this.cached = lease;
        }
      }
    } catch {
      // @silent-fallback-ok — corrupt local lease file: start clean. The lease is
      // re-acquired (holder) or re-observed over the tunnel (standby), so a lost
      // local copy is self-healing, never authoritative-loss.
      this.cached = null;
    }
    this.loaded = true;
  }

  private persist(lease: LeaseRecord | null): void {
    this.cached = lease;
    try {
      const dir = path.dirname(this.d.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.d.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ lease }, null, 2));
      fs.renameSync(tmp, this.d.filePath); // atomic swap
    } catch (err) {
      this.log(`persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  read(): { lease: LeaseRecord | null; epoch: number } {
    this.load();
    return { lease: this.cached, epoch: this.cached?.epoch ?? 0 };
  }

  casWrite(candidate: LeaseRecord): { ok: boolean; observed: { lease: LeaseRecord | null; epoch: number } } {
    this.load();
    const committedEpoch = this.cached?.epoch ?? 0;
    // Only a strict advance over the locally-committed epoch is a valid CAS —
    // mirrors GitLeaseStore so LeaseCoordinator's acquire/yield logic is identical
    // regardless of which store backs it.
    if (candidate.epoch <= committedEpoch) {
      this.log(`CAS pre-check failed: candidate epoch ${candidate.epoch} <= committed ${committedEpoch}`);
      return { ok: false, observed: { lease: this.cached, epoch: committedEpoch } };
    }
    this.persist(candidate);
    this.log(`lease epoch ${candidate.epoch} committed locally → ${candidate.holder}`);
    return { ok: true, observed: { lease: candidate, epoch: candidate.epoch } };
  }

  refresh(lease: LeaseRecord): boolean {
    this.load();
    const committedEpoch = this.cached?.epoch ?? 0;
    // Don't overwrite a higher epoch with a same-epoch refresh (superseded).
    if (committedEpoch > lease.epoch) {
      this.log(`refresh declined: superseded (committed ${committedEpoch} > ${lease.epoch})`);
      return false;
    }
    this.persist(lease); // same epoch, fresh expiry + nonce
    return true;
  }
}
