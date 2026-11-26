import {syncNativeLeaseFile} from './NativeLeaseDurability.js';
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
  /**
   * planned-restart-keeps-lead §1 step 4 — the pending marker: the id of the restart episode whose
   * window renewal this record is. A record carrying it is a *window lease* at the next boot (rule 1b
   * applies); cleared by the confirmed boot renewal, by relinquish and at an episode's end. Carried
   * through every write path (casWrite, refresh, relinquish) so no write drops it mid-episode.
   */
  private pendingEpisodeId: string | null = null;
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
        const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8')) as { lease?: unknown; pendingEpisodeId?: unknown };
        const lease = raw?.lease as LeaseRecord | undefined;
        if (lease && typeof lease.epoch === 'number' && typeof lease.holder === 'string') {
          this.cached = lease;
          this.pendingEpisodeId = typeof raw.pendingEpisodeId === 'string' && raw.pendingEpisodeId ? raw.pendingEpisodeId : null;
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

  private persist(lease: LeaseRecord | null, pendingEpisodeId: string | null = this.pendingEpisodeId): void {
    this.cached = lease;
    this.pendingEpisodeId = lease ? pendingEpisodeId : null;
    try {
      const dir = path.dirname(this.d.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.d.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.pendingEpisodeId ? { lease, pendingEpisodeId: this.pendingEpisodeId } : { lease }, null, 2));
      fs.renameSync(tmp, this.d.filePath); // atomic swap
    } catch (err) {
      this.log(`persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Explicit native-owner administration only; verifies disk, not cache. */
  syncDurably(expected:LeaseRecord|null=this.read().lease):void{syncNativeLeaseFile(this.d.filePath,expected,document=>(document as {lease?:LeaseRecord}).lease??null);}
  get durabilityPath():string{return this.d.filePath;}
  hasNoSharedMedium(): boolean {
    return true;
  }

  read(): { lease: LeaseRecord | null; epoch: number } {
    this.load();
    return { lease: this.cached, epoch: this.cached?.epoch ?? 0 };
  }

  /** The pending marker on the stored record, or null (planned-restart-keeps-lead §1 step 4). */
  readPendingEpisodeId(): string | null {
    this.load();
    return this.cached ? this.pendingEpisodeId : null;
  }

  /** Refresh the same-epoch lease AND set or clear the pending marker in the same atomic write. */
  refreshWithPending(lease: LeaseRecord, pendingEpisodeId: string | null): boolean {
    this.load();
    const committedEpoch = this.cached?.epoch ?? 0;
    if (committedEpoch > lease.epoch) {
      this.log(`refresh declined: superseded (committed ${committedEpoch} > ${lease.epoch})`);
      return false;
    }
    this.persist(lease, pendingEpisodeId);
    return true;
  }

  /** Clear the pending marker without touching the lease (an episode ended, nothing to renew yet). */
  clearPendingEpisodeId(): void {
    this.load();
    if (!this.cached || !this.pendingEpisodeId) return;
    this.persist(this.cached, null);
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

  /**
   * Relinquish THIS machine's local self-lease to break a same-epoch contested
   * tie (spec §Problem A). The deterministic loser forces its persisted lease to
   * read as EXPIRED — so it stops being a "live holder at epoch N" (the winner's
   * canAcquire() unblocks; holdsLease() returns false) — while KEEPING the
   * committed epoch as the CAS/replay floor. (Clearing to epoch 0 would drop the
   * floor and let a replayed stale lease win; expiring-in-place preserves it.)
   * The winner then advances to N+1, which the loser adopts via the strict-`>`
   * tunnel fold in effectiveView(). No-op if there is no local lease.
   */
  forceLocalExpiry(): void {
    this.load();
    if (!this.cached) return;
    const expired: LeaseRecord = { ...this.cached, expiresAt: new Date(0).toISOString() };
    this.persist(expired, null); // keep epoch + holder as the floor; expiresAt deep-past; a relinquished lease is no window lease
    this.log(`local self-lease forced expired (epoch ${expired.epoch} retained as floor) → relinquished`);
  }
}
