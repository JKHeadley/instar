/**
 * Production construction of the per-topic fold lock
 * (context-budget-layered-summaries §9.3 step 1, §14 "Fold lock").
 *
 * Signs with this machine's own Ed25519 identity and verifies against the
 * paired machines' registered keys, exactly as the machine lease does in
 * server.ts, so a forged lock naming a peer never verifies. The `local`
 * medium (single machine, or a pool whose placement is not live) keeps one
 * file per topic under `<stateDir>/state/fold-leases/` (git-ignored, never
 * served). The `git` medium is a GitKeyedLeaseStore over the git-sync seams.
 */
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from './FencedLease.js';
import { KeyedLeaseLock, LocalKeyedLeaseStore, type KeyedLeaseStore } from './KeyedLease.js';
import { sign as signEd25519, verify as verifyEd25519, type MachineIdentityManager } from './MachineIdentity.js';

/** The fold lock's base TTL before Phase 0 measures the p99 fold duration (§9.3: floor ≥ p95). */
export const FOLD_LOCK_DEFAULT_TTL_MS = 10 * 60_000;

export function foldLeaseDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'fold-leases');
}

export function machineLeaseCrypto(selfMachineId: string, idMgr: MachineIdentityManager): LeaseCrypto {
  return {
    selfMachineId,
    sign: (canonical) => signEd25519(canonical, idMgr.loadSigningKey()),
    verify: (canonical, signature, holderMachineId) => {
      const pub = idMgr.getSigningPublicKeyPem(holderMachineId);
      if (!pub) return false;
      try { return verifyEd25519(canonical, signature, pub); } catch { return false; /* @silent-fallback-ok — an unverifiable signature is not a held lock (the safe direction) */ }
    },
  };
}

export function createFoldLeaseLock(opts: {
  stateDir: string;
  selfMachineId: string;
  idMgr: MachineIdentityManager;
  ttlMs?: number;
  /** Override the medium (the git medium on a live pool); default `local`. */
  store?: KeyedLeaseStore;
  now?: () => number;
}): KeyedLeaseLock {
  const ttlMs = opts.ttlMs ?? FOLD_LOCK_DEFAULT_TTL_MS;
  return new KeyedLeaseLock({
    fenced: new FencedLease(machineLeaseCrypto(opts.selfMachineId, opts.idMgr), { leaseTtlMs: ttlMs, failoverThresholdMs: 2 * ttlMs }),
    store: opts.store ?? new LocalKeyedLeaseStore(foldLeaseDir(opts.stateDir)),
    ttlMs,
    ...(opts.now ? { now: opts.now } : {}),
  });
}
