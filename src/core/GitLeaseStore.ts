/**
 * GitLeaseStore — the durable (git-backed) LeaseStore for LeaseCoordinator.
 *
 * Implements the lease CAS over git: git has no native compare-and-swap, so we
 * do optimistic concurrency — pull-rebase to minimize the reject window, re-read
 * the committed epoch, refuse to write unless our candidate strictly advances
 * it, then commit+push. A non-fast-forward push (a peer advanced first) returns
 * ok:false with the freshly-observed lease so LeaseCoordinator re-evaluates and
 * either yields or retries with a higher epoch. We NEVER force-push.
 *
 * The write also bumps the holder's own registry entry (syncSequence +
 * authoredUnderEpoch) so the lease commit passes peers' registryReplayGuard.
 */

import type { LeaseStore } from './LeaseCoordinator.js';
import type { LeaseRecord, MachineRegistry } from './types.js';

export interface GitLeaseStoreDeps {
  /** This machine's id (the only entry we bump syncSequence on). */
  machineId: string;
  loadRegistry: () => MachineRegistry;
  saveRegistry: (r: MachineRegistry) => void;
  /** Absolute path of the registry file to stage. */
  registryAbsPath: string;
  /** Pull-rebase (best-effort) before reading/writing. */
  pullRebase: () => boolean;
  /** Commit + push the registry; false on non-ff/no-op. */
  commitAndPush: (message: string, paths: string[]) => boolean;
  logger?: (msg: string) => void;
}

export class GitLeaseStore implements LeaseStore {
  private readonly d: GitLeaseStoreDeps;

  constructor(deps: GitLeaseStoreDeps) {
    this.d = deps;
  }

  private log(m: string): void {
    this.d.logger?.(`[git-lease] ${m}`);
  }

  read(): { lease: LeaseRecord | null; epoch: number } {
    const reg = this.d.loadRegistry();
    return { lease: reg.lease ?? null, epoch: reg.lease?.epoch ?? 0 };
  }

  /**
   * Pull the latest durable state into the local working tree WITHOUT writing,
   * so a subsequent loadRegistry() (incl. the presumedDeadHolders liveness
   * check) sees the holder's CURRENT heartbeat rather than a stale seed
   * timestamp. Used to prime a freshly-booted/joined machine before its first
   * failover decision (the fresh-join-grabs-lease bug, 2026-05-28).
   */
  syncDown(): void {
    try {
      this.d.pullRebase();
    } catch {
      // @silent-fallback-ok — best-effort prime; the CAS in casWrite still pulls.
    }
  }

  casWrite(candidate: LeaseRecord): { ok: boolean; observed: { lease: LeaseRecord | null; epoch: number } } {
    // 1. Pull-rebase to shrink the reject window, then re-read the committed epoch.
    this.d.pullRebase();
    let reg = this.d.loadRegistry();
    const committedEpoch = reg.lease?.epoch ?? 0;

    // 2. CAS pre-check: only a strict +1 advance over the committed epoch is valid.
    if (candidate.epoch <= committedEpoch) {
      this.log(`CAS pre-check failed: candidate epoch ${candidate.epoch} <= committed ${committedEpoch}`);
      return { ok: false, observed: { lease: reg.lease ?? null, epoch: committedEpoch } };
    }

    // 3. Write the lease + bump the holder's own freshness fields so peers'
    //    replay guard accepts it.
    reg.lease = candidate;
    const entry = reg.machines[this.d.machineId];
    if (entry) {
      entry.syncSequence = (entry.syncSequence ?? 0) + 1;
      entry.authoredUnderEpoch = candidate.epoch;
    }
    this.d.saveRegistry(reg);

    // 4. Commit + push. On success the CAS landed.
    const pushed = this.d.commitAndPush(
      `chore(mesh): lease epoch ${candidate.epoch} → ${candidate.holder}`,
      [this.d.registryAbsPath],
    );
    if (pushed) {
      this.log(`lease epoch ${candidate.epoch} committed + pushed`);
      return { ok: true, observed: { lease: candidate, epoch: candidate.epoch } };
    }

    // 5. Push rejected (a peer advanced) or no-op. Re-read after a pull and
    //    report the observed state so the caller re-evaluates / retries.
    this.d.pullRebase();
    reg = this.d.loadRegistry();
    const observedEpoch = reg.lease?.epoch ?? 0;
    this.log(`push rejected/no-op; observed epoch now ${observedEpoch}`);
    return { ok: false, observed: { lease: reg.lease ?? null, epoch: observedEpoch } };
  }

  refresh(lease: LeaseRecord): boolean {
    // Pull first; if a peer has advanced past our epoch we've been superseded —
    // do NOT overwrite a higher epoch with a same-epoch refresh.
    this.d.pullRebase();
    const reg = this.d.loadRegistry();
    const committedEpoch = reg.lease?.epoch ?? 0;
    if (committedEpoch > lease.epoch) {
      this.log(`refresh declined: superseded (committed ${committedEpoch} > ${lease.epoch})`);
      return false;
    }
    reg.lease = lease; // same epoch, fresh expiry + nonce
    const entry = reg.machines[this.d.machineId];
    if (entry) {
      entry.syncSequence = (entry.syncSequence ?? 0) + 1;
      entry.authoredUnderEpoch = lease.epoch;
    }
    this.d.saveRegistry(reg);
    return this.d.commitAndPush(`chore(mesh): lease renew epoch ${lease.epoch}`, [this.d.registryAbsPath]);
  }
}
