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
import fs from 'node:fs';
import { sign as signEd25519, verify as verifyEd25519, generateSigningKeyPair, MachineIdentityManager } from './MachineIdentity.js';

/** The fold lock's base TTL before Phase 0 measures the p99 fold duration (§9.3: floor ≥ p95). */
export const FOLD_LOCK_DEFAULT_TTL_MS = 10 * 60_000;
/** The lock TTL ceiling (§9.3: every step's hard maximum is 3× its bound): bounds a last-known fold hold under store faults. */
export const FOLD_LOCK_TTL_CEILING_MS = 3 * FOLD_LOCK_DEFAULT_TTL_MS;

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

/** The holder id a machine without a paired identity signs fold locks as. */
export const LOCAL_FOLD_HOLDER = 'local-fold-key';

/**
 * Signing for a machine with NO machine identity (a single-machine agent that
 * never paired): a per-agent Ed25519 key kept at
 * `<stateDir>/state/fold-leases/.local-key.pem` (0600, created once). It can
 * only ever verify its own locks, which is all a single machine needs.
 */
export function localFoldLeaseCrypto(stateDir: string): LeaseCrypto {
  const dir = foldLeaseDir(stateDir);
  const privFile = path.join(dir, '.local-key.pem');
  const pubFile = path.join(dir, '.local-key.pub.pem');
  if (!fs.existsSync(privFile) || !fs.existsSync(pubFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const kp = generateSigningKeyPair();
    fs.writeFileSync(pubFile, kp.publicKey, { mode: 0o600 });
    fs.writeFileSync(privFile, kp.privateKey, { mode: 0o600 });
  }
  const priv = fs.readFileSync(privFile, 'utf-8');
  const pub = fs.readFileSync(pubFile, 'utf-8');
  return {
    selfMachineId: LOCAL_FOLD_HOLDER,
    sign: (canonical) => signEd25519(canonical, priv),
    verify: (canonical, signature, holder) => {
      if (holder !== LOCAL_FOLD_HOLDER) return false;
      try { return verifyEd25519(canonical, signature, pub); } catch { return false; /* @silent-fallback-ok — an unverifiable signature is not a held lock (the safe direction) */ }
    },
  };
}

/**
 * The fold lock for this agent: signed with the machine identity when the
 * machine has one, else with the local fold key. Returns the holder id used.
 */
export function createFoldLeaseLockForAgent(stateDir: string, opts: { ttlMs?: number; now?: () => number } = {}): { lock: KeyedLeaseLock; holderId: string } {
  const idMgr = new MachineIdentityManager(stateDir);
  if (idMgr.hasIdentity()) {
    const selfMachineId = idMgr.loadIdentity().machineId;
    return { lock: createFoldLeaseLock({ stateDir, selfMachineId, idMgr, ...opts }), holderId: selfMachineId };
  }
  const ttlMs = opts.ttlMs ?? FOLD_LOCK_DEFAULT_TTL_MS;
  const lock = new KeyedLeaseLock({
    fenced: new FencedLease(localFoldLeaseCrypto(stateDir), { leaseTtlMs: ttlMs, failoverThresholdMs: 2 * ttlMs }),
    store: new LocalKeyedLeaseStore(foldLeaseDir(stateDir)),
    ttlMs,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { lock, holderId: LOCAL_FOLD_HOLDER };
}
