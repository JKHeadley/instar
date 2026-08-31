/**
 * IdentityStore — the single serialized mutation funnel for machine trust anchors.
 *
 * Every stored peer-identity write must pass this class. It owns the independent
 * signing/recovery epochs, tombstones, sticky revocation, first-establishment
 * authority rule, and append-only identity-change audit.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineIdentity, MachineRegistry } from './types.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const IDENTITY_AUTO_ACCEPT_PROTECTED_PATHS = [
  '.instar/machine/',
  '.instar/state/identity-epochs.json',
  '.instar/state/identity-issued-refusals.json',
  '.instar/state/identity-reannounce.json',
  '.instar/state/identity-reannounce-claimant.json',
  '.instar/state/identity-unacked-rotations.json',
  '.instar/state/identity-rotation-ack-propagation.json',
  '.instar/state/identity-recovery-establishment.json',
  '.instar/state/identity-transaction.json',
  '.instar/state/machine-identity-migration-attestation.json',
  '.instar/state/machine-identity-activation-proof.json',
  '.instar/state/observed-endpoints.json',
  '.instar/secrets/',
  '.instar/state/rope-health.json',
  'logs/identity-changes.jsonl',
] as const;

/** Exact per-peer trust anchor files. The sibling registry remains eligible for
 * its purpose-built convergence path and is protected from the generic file API
 * separately. */
export function isRemoteIdentityAuthorityPath(relativePath: string): boolean {
  const normalized = path.normalize(relativePath).replaceAll('\\', '/').toLowerCase();
  return /^\.instar\/machines\/[a-z0-9_-]{1,64}\/identity\.json$/.test(normalized);
}

export type IdentityMutationActor =
  | 'self-bootstrap'
  | 'pairing-trust'
  | 'operator'
  | 'reannounce'
  | 'replication-apply';

export type IdentityMutationPath =
  | 'bootstrap'
  | 'pair'
  | 'signing-rotation'
  | 'recovery-establishment'
  | 'recovery-rotation'
  | 'replication'
  | 'revocation';

export interface IdentityEpochEntry {
  keyEpoch: number;
  recoveryEpoch: number;
  signingTombstones: Array<{ epoch: number; fingerprint: string }>;
  recoveryTombstones: Array<{ epoch: number; fingerprint: string }>;
  revokedAt?: string;
}

interface IdentityEpochFile {
  version: 1;
  machines: Record<string, IdentityEpochEntry>;
}

export interface UnacknowledgedRotation {
  machineId: string;
  keyEpoch: number;
  signingFingerprint: string;
  acceptedAt: string;
  acceptedBy?: string;
  path: IdentityMutationPath;
}

interface UnacknowledgedRotationFile {
  version: 1;
  rotations: Record<string, UnacknowledgedRotation>;
}

export interface IdentityChangeRow {
  transactionId?: string;
  at: string;
  machineId: string;
  path: IdentityMutationPath;
  actor: IdentityMutationActor;
  oldSigningFingerprint?: string;
  newSigningFingerprint: string;
  oldRecoveryFingerprint?: string;
  newRecoveryFingerprint?: string;
  keyEpoch: number;
  recoveryEpoch: number;
  acceptedBy?: string;
  corroboration?: string[];
}

interface IdentityTransactionJournal {
  version: 1;
  kind?: 'identity';
  id: string;
  machineId: string;
  scope: 'local' | 'remote';
  identity: MachineIdentity;
  epochs: IdentityEpochFile;
  unacknowledged?: UnacknowledgedRotationFile;
  ledgerRow: IdentityChangeRow;
  privateKeyReplacements?: PrivateKeyReplacement[];
  registryAfterIdentity?: MachineRegistry;
}

interface IdentityRevocationJournal {
  version: 1;
  kind: 'revocation';
  id: string;
  machineId: string;
  epochs: IdentityEpochFile;
  registry: MachineRegistry;
  ledgerRow: IdentityChangeRow;
}

export interface PrivateKeyReplacement {
  targetPath: string;
  stagedPath: string;
  backupPath?: string;
}

export interface IdentityProjection {
  machineId: string;
  keyEpoch: number;
  signingFingerprint: string;
  recoveryEpoch: number;
  recoveryFingerprint?: string;
  recoveryAnchorProvenance?: MachineIdentity['recoveryAnchorProvenance'];
  registryStatus: 'active' | 'pending' | 'revoked' | 'missing' | 'unreadable';
}

export interface IdentityMutation {
  identity: MachineIdentity;
  scope: 'local' | 'remote';
  actor: IdentityMutationActor;
  path: IdentityMutationPath;
  acceptedBy?: string;
  corroboration?: string[];
  /** Pairing-trust may deliberately restore a revoked machine. No other actor may. */
  clearRevocation?: boolean;
  /** Local escrow recovery only: the public key lost with identity.json, used
   * to tombstone the superseded signing generation. */
  previousSigningPublicKey?: string;
  /** Local-only staged private-key replacements committed before identity.json
   * becomes visible. Paths are validated under `.instar/machine/`. */
  privateKeyReplacements?: PrivateKeyReplacement[];
  /** Pairing-code-authorized local preparation of a revoked same-principal
   * re-pair. Both signing and recovery generations must advance exactly once. */
  freshPairingReplacement?: boolean;
}

export class IdentityStoreRefusal extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IdentityStoreRefusal';
  }
}

export const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertValidMachineId(machineId: string): void {
  if (typeof machineId !== 'string' || !MACHINE_ID_PATTERN.test(machineId)) {
    throw new IdentityStoreRefusal('invalid-machine-id', 'Machine ID must be 1-64 URL-safe identifier characters');
  }
}

function fingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function epochOf(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function sameCapabilities(a: MachineIdentity['capabilities'], b: MachineIdentity['capabilities']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class IdentityStore {
  private applying = false;
  private readonly stateDir: string;
  private readonly now: () => number;
  private readonly faultInjector?: (step: 'after-journal' | 'after-epoch' | 'after-unacknowledged' | 'after-ledger' | 'after-private-keys' | 'after-identity' | 'after-registry') => void;

  constructor(options: {
    stateDir: string;
    now?: () => number;
    /** Test-only crash seam. Production callers omit it. */
    faultInjector?: IdentityStore['faultInjector'];
  }) {
    this.stateDir = options.stateDir;
    this.now = options.now ?? Date.now;
    this.faultInjector = options.faultInjector;
    this.recoverPendingTransaction();
  }

  get epochPath(): string {
    return path.join(this.stateDir, 'state', 'identity-epochs.json');
  }

  get ledgerPath(): string {
    return path.join(this.stateDir, '..', 'logs', 'identity-changes.jsonl');
  }

  get unacknowledgedPath(): string {
    return path.join(this.stateDir, 'state', 'identity-unacked-rotations.json');
  }

  get transactionPath(): string {
    return path.join(this.stateDir, 'state', 'identity-transaction.json');
  }

  identityPath(machineId: string, scope: 'local' | 'remote'): string {
    assertValidMachineId(machineId);
    return scope === 'local'
      ? path.join(this.stateDir, 'machine', 'identity.json')
      : path.join(this.stateDir, 'machines', machineId, 'identity.json');
  }

  loadIdentity(machineId: string, scope: 'local' | 'remote'): MachineIdentity | null {
    const file = this.identityPath(machineId, scope);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as MachineIdentity;
    } catch { // @silent-fallback-ok: unreadable identity fails closed as absent; no trust projection or mutation is authorized
      return null;
    }
  }

  /** Current promoted identity projection; no historical ledger inference. */
  projection(machineId: string): IdentityProjection | null {
    assertValidMachineId(machineId);
    const identity = this.loadIdentity(machineId, 'remote') ?? this.loadIdentity(machineId, 'local');
    if (!identity) return null;
    let registryStatus: IdentityProjection['registryStatus'] = 'unreadable';
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'machines', 'registry.json'), 'utf8')) as MachineRegistry;
      const entry = registry?.machines?.[machineId];
      registryStatus = !entry ? 'missing' : entry.revokedAt || entry.status === 'revoked' ? 'revoked' : entry.status;
    } catch {
      registryStatus = 'unreadable';
    }
    return {
      machineId,
      keyEpoch: epochOf(identity.keyEpoch),
      signingFingerprint: fingerprint(identity.signingPublicKey)!,
      recoveryEpoch: epochOf(identity.recoveryEpoch),
      recoveryFingerprint: fingerprint(identity.recoveryPublicKey),
      recoveryAnchorProvenance: identity.recoveryAnchorProvenance,
      registryStatus,
    };
  }

  listProjections(): IdentityProjection[] {
    const ids = new Set<string>();
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'machines', 'registry.json'), 'utf8')) as MachineRegistry;
      for (const id of Object.keys(registry?.machines ?? {})) if (MACHINE_ID_PATTERN.test(id)) ids.add(id);
    } catch { /* projection rows below remain fail-closed/unreadable */ }
    try {
      const local = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'machine', 'identity.json'), 'utf8')) as MachineIdentity;
      if (MACHINE_ID_PATTERN.test(local.machineId)) ids.add(local.machineId);
    } catch { /* no local identity */ }
    return [...ids].flatMap((id) => {
      const row = this.projection(id);
      return row ? [row] : [];
    });
  }

  loadEpochs(): IdentityEpochFile {
    if (!fs.existsSync(this.epochPath)) return { version: 1, machines: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.epochPath, 'utf8')) as IdentityEpochFile;
      if (parsed?.version === 1 && parsed.machines && typeof parsed.machines === 'object') return parsed;
    } catch {
      // A corrupt authority file cannot be treated as epoch zero.
    }
    throw new IdentityStoreRefusal('epoch-store-corrupt', 'Identity epoch/tombstone store is unreadable');
  }

  getEpoch(machineId: string): IdentityEpochEntry {
    assertValidMachineId(machineId);
    const stored = this.loadEpochs().machines[machineId];
    return stored ?? { keyEpoch: 0, recoveryEpoch: 0, signingTombstones: [], recoveryTombstones: [] };
  }

  /**
   * Apply one identity mutation. Synchronous by design: Node's event loop plus the
   * re-entrancy refusal makes one process a single writer; atomic rename prevents
   * torn files. All invariant checks happen before either authority file is changed.
   */
  apply(mutation: IdentityMutation): MachineIdentity {
    if (this.applying) {
      throw new IdentityStoreRefusal('concurrent-writer', 'Identity mutation already in progress');
    }
    this.recoverPendingTransaction();
    this.applying = true;
    try {
      return this.applyInside(mutation);
    } finally {
      this.applying = false;
    }
  }

  /** Run the exact live invariant checks without committing any authority
   * surface. Used by dry-run verdicts so rollout evidence cannot certify a
   * mutation that live mode would later refuse. */
  validate(mutation: IdentityMutation): MachineIdentity {
    if (this.applying) throw new IdentityStoreRefusal('concurrent-writer', 'Identity mutation already in progress');
    this.recoverPendingTransaction();
    this.applying = true;
    try {
      return this.applyInside(mutation, true);
    } finally {
      this.applying = false;
    }
  }

  private applyInside(mutation: IdentityMutation, validateOnly = false): MachineIdentity {
    const next = { ...mutation.identity };
    if (!next.machineId || !next.signingPublicKey || !next.encryptionPublicKey) {
      throw new IdentityStoreRefusal('malformed-identity', 'Machine identity is missing required public-key fields');
    }
    assertValidMachineId(next.machineId);
    if (mutation.privateKeyReplacements?.length) {
      if (mutation.scope !== 'local') {
        throw new IdentityStoreRefusal('remote-private-key-replacement', 'Private-key replacement is local-only');
      }
      this.validatePrivateKeyReplacements(mutation.privateKeyReplacements);
    }

    // Pair/bootstrap are the enrollment authorities. Every later remote trust
    // mutation requires a readable, explicitly-active registry row; a missing
    // or corrupt registry can never be interpreted as permission.
    if (mutation.scope === 'remote' && mutation.path !== 'pair' && mutation.path !== 'bootstrap') {
      this.assertActive(next.machineId);
    }

    const loadedAtPath = this.loadIdentity(next.machineId, mutation.scope);
    // A forced local re-identity writes the same local path under a NEW
    // machineId. That is genesis for the new principal, not a key rotation of
    // the old principal; epochs remain keyed by machineId and never bleed.
    const current = loadedAtPath?.machineId === next.machineId ? loadedAtPath : null;
    const epochs = this.loadEpochs();
    const priorEpoch = epochs.machines[next.machineId] ?? {
      keyEpoch: epochOf(current?.keyEpoch),
      recoveryEpoch: epochOf(current?.recoveryEpoch),
      signingTombstones: [],
      recoveryTombstones: [],
    };
    const registryEntry = this.registryEntry(next.machineId);
    const revoked = Boolean(registryEntry?.revokedAt || registryEntry?.status === 'revoked' || priorEpoch.revokedAt);
    const freshRevocationRepair = revoked
      && mutation.actor === 'pairing-trust'
      && mutation.path === 'pair'
      && mutation.clearRevocation === true;
    const freshLocalPairingReplacement = mutation.scope === 'local'
      && mutation.actor === 'pairing-trust'
      && mutation.path === 'pair'
      && mutation.freshPairingReplacement === true;
    if (revoked && !(mutation.actor === 'pairing-trust' && mutation.clearRevocation === true)) {
      throw new IdentityStoreRefusal('sticky-revocation', 'Revoked machine identity requires a fresh operator pairing');
    }

    const currentKeyEpoch = Math.max(priorEpoch.keyEpoch, epochOf(current?.keyEpoch));
    const currentRecoveryEpoch = Math.max(priorEpoch.recoveryEpoch, epochOf(current?.recoveryEpoch));
    const nextKeyEpoch = epochOf(next.keyEpoch);
    const nextRecoveryEpoch = epochOf(next.recoveryEpoch);
    const signingChanged = Boolean(current && current.signingPublicKey !== next.signingPublicKey);
    const encryptionChanged = Boolean(current && current.encryptionPublicKey !== next.encryptionPublicKey);
    const recoveryChanged = Boolean(current && current.recoveryPublicKey !== next.recoveryPublicKey);
    const firstRecovery = !current?.recoveryPublicKey && Boolean(next.recoveryPublicKey);

    const localRecovery = !current
      && mutation.scope === 'local'
      && mutation.actor === 'self-bootstrap'
      && mutation.path === 'signing-rotation'
      && Boolean(epochs.machines[next.machineId]);

    if (!current) {
      if (localRecovery) {
        if (nextKeyEpoch !== priorEpoch.keyEpoch + 1) {
          throw new IdentityStoreRefusal('key-epoch-not-next', 'Recovered local signing key requires keyEpoch == stored + 1');
        }
        if (next.recoveryPublicKey !== undefined && nextRecoveryEpoch !== priorEpoch.recoveryEpoch) {
          throw new IdentityStoreRefusal('recovery-epoch-without-rotation', 'Local signing recovery cannot change recoveryEpoch');
        }
      } else if (nextKeyEpoch !== 0) {
        throw new IdentityStoreRefusal('genesis-key-epoch', 'A new machine identity must begin at keyEpoch 0');
      }
      if (!localRecovery && next.recoveryPublicKey) {
        if (nextRecoveryEpoch !== 1) {
          throw new IdentityStoreRefusal('genesis-recovery-epoch', 'First recovery-key establishment must use recoveryEpoch 1');
        }
        if (mutation.actor !== 'pairing-trust' && mutation.actor !== 'self-bootstrap') {
          throw new IdentityStoreRefusal('recovery-first-establishment-auth', 'First recovery-key establishment requires pairing authority');
        }
      } else if (!localRecovery && nextRecoveryEpoch !== 0) {
        throw new IdentityStoreRefusal('recovery-key-missing', 'recoveryEpoch cannot advance without a recovery public key');
      }
    } else {
      if (mutation.path !== 'pair') {
        const baseMetadataChanged = current.name !== next.name
          || current.platform !== next.platform
          || current.createdAt !== next.createdAt
          || !sameCapabilities(current.capabilities, next.capabilities);
        if (baseMetadataChanged) {
          throw new IdentityStoreRefusal('identity-metadata-mutation', 'Trust mutation cannot replace machine identity metadata');
        }
      }
      if (encryptionChanged && !signingChanged) {
        throw new IdentityStoreRefusal('encryption-key-without-signing-rotation', 'Encryption key can change only with a signing-key rotation');
      }
      if (mutation.path === 'signing-rotation') {
        if (!signingChanged) throw new IdentityStoreRefusal('signing-key-unchanged', 'Signing-rotation path requires a replacement signing key');
        if (current.recoveryPublicKey !== next.recoveryPublicKey
          || epochOf(current.recoveryEpoch) !== epochOf(next.recoveryEpoch)
          || current.recoveryAnchorProvenance !== next.recoveryAnchorProvenance) {
          throw new IdentityStoreRefusal('signing-rotation-trust-field-mutation', 'Signing rotation cannot alter recovery trust fields');
        }
      }
      if (signingChanged && recoveryChanged && !freshRevocationRepair && !freshLocalPairingReplacement) {
        throw new IdentityStoreRefusal('coupled-key-rotation', 'Signing and recovery keys must rotate in separate mutations');
      }
      if (signingChanged) {
        if (nextKeyEpoch !== currentKeyEpoch + 1) {
          throw new IdentityStoreRefusal('key-epoch-not-next', 'Signing-key rotation requires keyEpoch == stored + 1');
        }
      } else if (nextKeyEpoch !== currentKeyEpoch) {
        throw new IdentityStoreRefusal('key-epoch-without-rotation', 'keyEpoch changed without a signing-key change');
      }

      if (firstRecovery) {
        if (mutation.path !== 'recovery-establishment'
          && !(mutation.path === 'pair' && mutation.actor === 'pairing-trust')) {
          throw new IdentityStoreRefusal('recovery-establishment-path', 'First recovery root requires the recovery-establishment path');
        }
        if (nextRecoveryEpoch !== currentRecoveryEpoch + 1) {
          throw new IdentityStoreRefusal('recovery-epoch-not-next', 'First recovery-key establishment requires recoveryEpoch == stored + 1');
        }
        if (mutation.actor !== 'pairing-trust') {
          throw new IdentityStoreRefusal('recovery-first-establishment-auth', 'First recovery-key establishment requires pairing authority');
        }
      } else if (recoveryChanged) {
        if (!freshRevocationRepair && !freshLocalPairingReplacement
          && (mutation.path !== 'recovery-rotation' || mutation.actor !== 'operator')) {
          throw new IdentityStoreRefusal('recovery-rotation-auth', 'Recovery-key replacement is a separate operator-only mutation');
        }
        if (!next.recoveryPublicKey || nextRecoveryEpoch !== currentRecoveryEpoch + 1) {
          throw new IdentityStoreRefusal('recovery-epoch-not-next', 'Recovery-key rotation requires recoveryEpoch == stored + 1');
        }
      } else if (nextRecoveryEpoch !== currentRecoveryEpoch) {
        throw new IdentityStoreRefusal('recovery-epoch-without-rotation', 'recoveryEpoch changed without a recovery-key change');
      }

      if ((mutation.path === 'recovery-establishment' || mutation.path === 'recovery-rotation')
        && (signingChanged || encryptionChanged || nextKeyEpoch !== currentKeyEpoch)) {
        throw new IdentityStoreRefusal('recovery-path-signing-mutation', 'Recovery-key mutation cannot alter signing or encryption trust fields');
      }
      if (!freshRevocationRepair && mutation.path !== 'recovery-establishment' && mutation.path !== 'recovery-rotation'
        && current.recoveryAnchorProvenance !== next.recoveryAnchorProvenance) {
        throw new IdentityStoreRefusal('recovery-provenance-mutation', 'Recovery provenance can change only with an authorized recovery mutation');
      }
    }

    const oldSigningFp = fingerprint(current?.signingPublicKey ?? mutation.previousSigningPublicKey);
    const newSigningFp = fingerprint(next.signingPublicKey)!;
    const oldRecoveryFp = fingerprint(current?.recoveryPublicKey);
    const newRecoveryFp = fingerprint(next.recoveryPublicKey);
    if (priorEpoch.signingTombstones.some((t) => t.fingerprint === newSigningFp)) {
      throw new IdentityStoreRefusal('signing-key-tombstoned', 'Announced signing key was previously superseded');
    }
    if (newRecoveryFp && priorEpoch.recoveryTombstones.some((t) => t.fingerprint === newRecoveryFp)) {
      throw new IdentityStoreRefusal('recovery-key-tombstoned', 'Announced recovery key was previously superseded');
    }

    const epochEntry: IdentityEpochEntry = {
      ...priorEpoch,
      keyEpoch: nextKeyEpoch,
      recoveryEpoch: nextRecoveryEpoch,
      signingTombstones: [...priorEpoch.signingTombstones],
      recoveryTombstones: [...priorEpoch.recoveryTombstones],
      ...(revoked && mutation.clearRevocation ? { revokedAt: undefined } : {}),
    };
    if ((signingChanged || localRecovery) && oldSigningFp && !epochEntry.signingTombstones.some((row) => row.fingerprint === oldSigningFp)) {
      epochEntry.signingTombstones.push({ epoch: currentKeyEpoch, fingerprint: oldSigningFp });
    }
    if (recoveryChanged && oldRecoveryFp && !epochEntry.recoveryTombstones.some((row) => row.fingerprint === oldRecoveryFp)) {
      epochEntry.recoveryTombstones.push({ epoch: currentRecoveryEpoch, fingerprint: oldRecoveryFp });
    }

    next.keyEpoch = nextKeyEpoch;
    next.recoveryEpoch = nextRecoveryEpoch;
    if (validateOnly) {
      if (signingChanged || localRecovery) this.loadUnacknowledged();
      return next;
    }
    const nextEpochFile: IdentityEpochFile = {
      version: 1,
      machines: { ...epochs.machines, [next.machineId]: epochEntry },
    };

    const acceptedAt = new Date(this.now()).toISOString();
    let nextUnacknowledged: UnacknowledgedRotationFile | undefined;
    if (signingChanged || localRecovery) {
      const unacknowledged = this.loadUnacknowledged();
      unacknowledged.rotations[next.machineId] = {
        machineId: next.machineId,
        keyEpoch: nextKeyEpoch,
        signingFingerprint: newSigningFp,
        acceptedAt,
        acceptedBy: mutation.acceptedBy,
        path: mutation.path,
      };
      nextUnacknowledged = unacknowledged;
    }
    const transactionId = crypto.randomUUID();
    const ledgerRow: IdentityChangeRow = {
      transactionId,
      at: acceptedAt,
      machineId: next.machineId,
      path: mutation.path,
      actor: mutation.actor,
      oldSigningFingerprint: oldSigningFp,
      newSigningFingerprint: newSigningFp,
      oldRecoveryFingerprint: oldRecoveryFp,
      newRecoveryFingerprint: newRecoveryFp,
      keyEpoch: nextKeyEpoch,
      recoveryEpoch: nextRecoveryEpoch,
      acceptedBy: mutation.acceptedBy,
      corroboration: mutation.corroboration,
    };
    let registryAfterIdentity: MachineRegistry | undefined;
    if (revoked && mutation.clearRevocation) {
      const registryPath = path.join(this.stateDir, 'machines', 'registry.json');
      try {
        registryAfterIdentity = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as MachineRegistry;
      } catch {
        throw new IdentityStoreRefusal('registry-unreadable', 'Cannot clear revocation in an unreadable registry');
      }
      const entry = registryAfterIdentity.machines?.[next.machineId];
      if (!entry) throw new IdentityStoreRefusal('registry-machine-missing', 'Cannot clear revocation for a missing machine');
      entry.status = 'active';
      delete entry.revokedAt;
      delete entry.revokedBy;
      delete entry.revokeReason;
    }
    const journal: IdentityTransactionJournal = {
      version: 1,
      kind: 'identity',
      id: transactionId,
      machineId: next.machineId,
      scope: mutation.scope,
      identity: next,
      epochs: nextEpochFile,
      unacknowledged: nextUnacknowledged,
      ledgerRow,
      privateKeyReplacements: mutation.privateKeyReplacements,
      registryAfterIdentity,
    };
    atomicWrite(this.transactionPath, JSON.stringify(journal, null, 2));
    this.faultInjector?.('after-journal');
    this.completeTransaction(journal, true);
    return next;
  }

  markRevoked(machineId: string, at = new Date(this.now()).toISOString()): void {
    assertValidMachineId(machineId);
    const epochs = this.loadEpochs();
    const current = epochs.machines[machineId] ?? this.getEpoch(machineId);
    const identity = this.loadIdentity(machineId, 'remote') ?? this.loadIdentity(machineId, 'local');
    const signing = fingerprint(identity?.signingPublicKey);
    const recovery = fingerprint(identity?.recoveryPublicKey);
    const next: IdentityEpochEntry = {
      ...current,
      signingTombstones: [...current.signingTombstones],
      recoveryTombstones: [...current.recoveryTombstones],
      revokedAt: at,
    };
    if (signing && !next.signingTombstones.some((row) => row.fingerprint === signing)) next.signingTombstones.push({ epoch: current.keyEpoch, fingerprint: signing });
    if (recovery && !next.recoveryTombstones.some((row) => row.fingerprint === recovery)) next.recoveryTombstones.push({ epoch: current.recoveryEpoch, fingerprint: recovery });
    epochs.machines[machineId] = next;
    atomicWrite(this.epochPath, JSON.stringify(epochs, null, 2));
  }

  /** Revoke in security-first order. The independent epoch tombstone is
   * committed before the human-facing registry row, so a crash between writes
   * can only fail closed (the principal is already untrusted). */
  revoke(machineId: string, revokedBy: string, reason: string): void {
    assertValidMachineId(machineId);
    if (this.applying) throw new IdentityStoreRefusal('concurrent-writer', 'Identity mutation already in progress');
    this.applying = true;
    try {
      const registryPath = path.join(this.stateDir, 'machines', 'registry.json');
      let registry: MachineRegistry;
      try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as MachineRegistry; }
      catch { throw new IdentityStoreRefusal('registry-unreadable', 'Machine registry is unreadable'); }
      const entry = registry.machines?.[machineId];
      if (!entry) throw new IdentityStoreRefusal('machine-not-found', `Machine not found: ${machineId}`);
      if (entry.status === 'revoked' || entry.revokedAt) throw new IdentityStoreRefusal('already-revoked', 'Machine is already revoked');

      const at = new Date(this.now()).toISOString();
      const epochs = this.loadEpochs();
      const prior = epochs.machines[machineId] ?? this.getEpoch(machineId);
      const identity = this.loadIdentity(machineId, 'remote') ?? this.loadIdentity(machineId, 'local');
      const signing = fingerprint(identity?.signingPublicKey) ?? 'unknown';
      const recovery = fingerprint(identity?.recoveryPublicKey);
      const revokedEpoch: IdentityEpochEntry = {
        ...prior,
        signingTombstones: [...prior.signingTombstones],
        recoveryTombstones: [...prior.recoveryTombstones],
        revokedAt: at,
      };
      if (signing !== 'unknown' && !revokedEpoch.signingTombstones.some((row) => row.fingerprint === signing)) {
        revokedEpoch.signingTombstones.push({ epoch: prior.keyEpoch, fingerprint: signing });
      }
      if (recovery && !revokedEpoch.recoveryTombstones.some((row) => row.fingerprint === recovery)) {
        revokedEpoch.recoveryTombstones.push({ epoch: prior.recoveryEpoch, fingerprint: recovery });
      }
      epochs.machines[machineId] = revokedEpoch;
      entry.status = 'revoked';
      entry.role = 'standby';
      entry.revokedAt = at;
      entry.revokedBy = revokedBy;
      entry.revokeReason = reason;

      const transactionId = crypto.randomUUID();
      const ledgerRow: IdentityChangeRow = {
        transactionId,
        at,
        machineId,
        path: 'revocation',
        actor: 'operator',
        oldSigningFingerprint: signing,
        newSigningFingerprint: signing,
        oldRecoveryFingerprint: recovery,
        newRecoveryFingerprint: recovery,
        keyEpoch: prior.keyEpoch,
        recoveryEpoch: prior.recoveryEpoch,
        acceptedBy: revokedBy,
        corroboration: [reason],
      };
      const journal: IdentityRevocationJournal = {
        version: 1,
        kind: 'revocation',
        id: transactionId,
        machineId,
        epochs,
        registry,
        ledgerRow,
      };
      atomicWrite(this.transactionPath, JSON.stringify(journal, null, 2));
      this.faultInjector?.('after-journal');
      this.completeRevocation(journal, true);
    } finally {
      this.applying = false;
    }
  }

  readChanges(limit = 200): IdentityChangeRow[] {
    if (!fs.existsSync(this.ledgerPath)) return [];
    return fs.readFileSync(this.ledgerPath, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, limit)).flatMap((line) => {
      try { return [JSON.parse(line) as IdentityChangeRow]; } catch { return []; /* @silent-fallback-ok: a malformed audit row supplies no affirmative acknowledgement evidence */ }
    });
  }

  listUnacknowledged(): UnacknowledgedRotation[] {
    return Object.values(this.loadUnacknowledged().rotations)
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  }

  hasUnacknowledged(machineId: string): boolean {
    assertValidMachineId(machineId);
    return Boolean(this.loadUnacknowledged().rotations[machineId]);
  }

  acknowledge(machineId: string, keyEpoch: number): boolean {
    assertValidMachineId(machineId);
    const data = this.loadUnacknowledged();
    const row = data.rotations[machineId];
    if (!row || row.keyEpoch !== keyEpoch) return false;
    delete data.rotations[machineId];
    atomicWrite(this.unacknowledgedPath, JSON.stringify(data, null, 2));
    return true;
  }

  acknowledgementStatus(machineId: string, keyEpoch: number): 'pending' | 'acknowledged' | 'unknown' {
    assertValidMachineId(machineId);
    const pending = this.loadUnacknowledged().rotations[machineId];
    if (pending?.keyEpoch === keyEpoch) return 'pending';
    const accepted = this.readChanges(10_000).some((row) =>
      row.machineId === machineId && row.keyEpoch === keyEpoch && row.path === 'signing-rotation');
    return accepted ? 'acknowledged' : 'unknown';
  }

  private appendLedger(row: IdentityChangeRow): void {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    if (row.transactionId && fs.existsSync(this.ledgerPath)) {
      const alreadyPresent = fs.readFileSync(this.ledgerPath, 'utf8').split('\n').some((line) => {
        if (!line) return false;
        try { return (JSON.parse(line) as IdentityChangeRow).transactionId === row.transactionId; } catch { return false; /* @silent-fallback-ok: malformed history cannot prove idempotent completion, so the durable row is appended */ }
      });
      if (alreadyPresent) return;
    }
    fs.appendFileSync(this.ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  }

  private completeTransaction(journal: IdentityTransactionJournal, injectFaults: boolean): void {
    // Supporting monotonic state becomes durable first; the identity file—the
    // key read by authentication—is the visibility/commit point.
    atomicWrite(this.epochPath, JSON.stringify(journal.epochs, null, 2));
    if (injectFaults) this.faultInjector?.('after-epoch');
    if (journal.unacknowledged) {
      atomicWrite(this.unacknowledgedPath, JSON.stringify(journal.unacknowledged, null, 2));
    }
    if (injectFaults) this.faultInjector?.('after-unacknowledged');
    this.appendLedger(journal.ledgerRow);
    if (injectFaults) this.faultInjector?.('after-ledger');
    let identityCommitted = false;
    try {
      for (const replacement of journal.privateKeyReplacements ?? []) {
        const staged = fs.readFileSync(replacement.stagedPath, 'utf8');
        atomicWrite(replacement.targetPath, staged);
      }
      if (injectFaults) this.faultInjector?.('after-private-keys');
      atomicWrite(this.identityPath(journal.machineId, journal.scope), JSON.stringify(journal.identity, null, 2));
      identityCommitted = true;
      if (injectFaults) this.faultInjector?.('after-identity');
      if (journal.registryAfterIdentity) {
        atomicWrite(path.join(this.stateDir, 'machines', 'registry.json'), JSON.stringify(journal.registryAfterIdentity, null, 2));
      }
      if (injectFaults) this.faultInjector?.('after-registry');
    } catch (err) {
      if (!identityCommitted) {
        for (const replacement of journal.privateKeyReplacements ?? []) {
          if (!replacement.backupPath || !fs.existsSync(replacement.backupPath)) continue;
          atomicWrite(replacement.targetPath, fs.readFileSync(replacement.backupPath, 'utf8'));
        }
      }
      throw err;
    }
    for (const replacement of journal.privateKeyReplacements ?? []) {
      for (const candidate of [replacement.stagedPath, replacement.backupPath].filter(Boolean) as string[]) {
        if (fs.existsSync(candidate)) SafeFsExecutor.safeUnlinkSync(candidate, { operation: 'IdentityStore.privateKeyStageCleanup' });
      }
    }
    SafeFsExecutor.safeUnlinkSync(this.transactionPath, { operation: 'IdentityStore.completeTransaction' });
  }

  private completeRevocation(journal: IdentityRevocationJournal, injectFaults: boolean): void {
    // Epoch tombstone is the security commit point. The journal then guarantees
    // registry visibility and the attributable ledger converge after a crash.
    atomicWrite(this.epochPath, JSON.stringify(journal.epochs, null, 2));
    if (injectFaults) this.faultInjector?.('after-epoch');
    atomicWrite(path.join(this.stateDir, 'machines', 'registry.json'), JSON.stringify(journal.registry, null, 2));
    if (injectFaults) this.faultInjector?.('after-registry');
    this.appendLedger(journal.ledgerRow);
    if (injectFaults) this.faultInjector?.('after-ledger');
    SafeFsExecutor.safeUnlinkSync(this.transactionPath, { operation: 'IdentityStore.completeRevocation' });
  }

  private recoverPendingTransaction(): void {
    if (!fs.existsSync(this.transactionPath)) return;
    let raw: IdentityTransactionJournal | IdentityRevocationJournal;
    try {
      raw = JSON.parse(fs.readFileSync(this.transactionPath, 'utf8')) as IdentityTransactionJournal | IdentityRevocationJournal;
      if (raw?.kind === 'revocation') {
        const epoch = raw.epochs?.version === 1 ? raw.epochs.machines?.[raw.machineId] : undefined;
        const entry = raw.registry?.machines?.[raw.machineId];
        if (!raw.id || !MACHINE_ID_PATTERN.test(raw.machineId) || !epoch?.revokedAt
          || !entry || entry.status !== 'revoked' || !entry.revokedAt
          || raw.ledgerRow.transactionId !== raw.id || raw.ledgerRow.machineId !== raw.machineId
          || raw.ledgerRow.path !== 'revocation' || raw.ledgerRow.actor !== 'operator') {
          throw new Error('malformed-revocation');
        }
        this.completeRevocation(raw, false);
        return;
      }
      const journal = raw;
      if (journal?.version !== 1 || !journal.id || !journal.identity || !journal.epochs || !journal.ledgerRow
        || journal.machineId !== journal.identity.machineId || (journal.scope !== 'local' && journal.scope !== 'remote')) {
        throw new Error('malformed');
      }
      assertValidMachineId(journal.machineId);
      const epoch = journal.epochs.version === 1 ? journal.epochs.machines?.[journal.machineId] : undefined;
      if (!epoch
        || epoch.keyEpoch !== epochOf(journal.identity.keyEpoch)
        || epoch.recoveryEpoch !== epochOf(journal.identity.recoveryEpoch)
        || !Array.isArray(epoch.signingTombstones)
        || !Array.isArray(epoch.recoveryTombstones)
        || journal.ledgerRow.transactionId !== journal.id
        || journal.ledgerRow.machineId !== journal.machineId
        || journal.ledgerRow.keyEpoch !== epoch.keyEpoch
        || journal.ledgerRow.recoveryEpoch !== epoch.recoveryEpoch
        || journal.ledgerRow.newSigningFingerprint !== fingerprint(journal.identity.signingPublicKey)
        || journal.ledgerRow.newRecoveryFingerprint !== fingerprint(journal.identity.recoveryPublicKey)) {
        throw new Error('authority-mismatch');
      }
      if (journal.unacknowledged) {
        const row = journal.unacknowledged.version === 1
          ? journal.unacknowledged.rotations?.[journal.machineId]
          : undefined;
        if (!row || row.keyEpoch !== epoch.keyEpoch || row.signingFingerprint !== journal.ledgerRow.newSigningFingerprint) {
          throw new Error('unacknowledged-mismatch');
        }
      }
      if (journal.registryAfterIdentity) {
        const entry = journal.registryAfterIdentity.machines?.[journal.machineId];
        if (!entry || entry.status !== 'active' || entry.revokedAt) throw new Error('registry-mismatch');
      }
      this.validatePrivateKeyReplacements(journal.privateKeyReplacements ?? []);
      this.completeTransaction(journal, false);
    } catch {
      throw new IdentityStoreRefusal('identity-transaction-corrupt', 'Pending identity transaction journal is unreadable');
    }
  }

  private validatePrivateKeyReplacements(replacements: PrivateKeyReplacement[]): void {
    const machineDir = path.resolve(this.stateDir, 'machine');
    for (const replacement of replacements) {
      for (const candidate of [replacement.targetPath, replacement.stagedPath, replacement.backupPath].filter(Boolean) as string[]) {
        const resolved = path.resolve(candidate);
        if (resolved !== machineDir && !resolved.startsWith(`${machineDir}${path.sep}`)) {
          throw new IdentityStoreRefusal('private-key-path-outside-machine', 'Private-key transaction path escaped the local machine directory');
        }
      }
    }
  }

  private loadUnacknowledged(): UnacknowledgedRotationFile {
    if (!fs.existsSync(this.unacknowledgedPath)) return { version: 1, rotations: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.unacknowledgedPath, 'utf8')) as UnacknowledgedRotationFile;
      if (parsed?.version === 1 && parsed.rotations && typeof parsed.rotations === 'object') return parsed;
    } catch {
      // A corrupt must-ack index must fail closed: further automatic rotations
      // stay suspended until the operator repairs/acknowledges the index.
    }
    throw new IdentityStoreRefusal('unacknowledged-store-corrupt', 'Unacknowledged rotation index is unreadable');
  }

  private registryEntry(machineId: string): MachineRegistry['machines'][string] | undefined {
    const registryPath = path.join(this.stateDir, 'machines', 'registry.json');
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as MachineRegistry;
      return registry.machines?.[machineId];
    } catch {
      return undefined;
    }
  }

  /** Fail closed unless the registry is readable and names an active principal. */
  assertActive(machineId: string): MachineRegistry['machines'][string] {
    assertValidMachineId(machineId);
    const registryPath = path.join(this.stateDir, 'machines', 'registry.json');
    let registry: MachineRegistry;
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as MachineRegistry;
    } catch {
      throw new IdentityStoreRefusal('registry-unreadable', 'Machine registry is missing or unreadable');
    }
    if (!registry || typeof registry !== 'object' || !registry.machines || typeof registry.machines !== 'object') {
      throw new IdentityStoreRefusal('registry-unreadable', 'Machine registry is malformed');
    }
    const entry = registry.machines[machineId];
    if (!entry) throw new IdentityStoreRefusal('registry-machine-missing', 'Machine is absent from the active registry');
    if (entry.status === 'revoked' || entry.revokedAt) {
      throw new IdentityStoreRefusal('sticky-revocation', 'Revoked machine identity requires a fresh operator pairing');
    }
    if (entry.status !== 'active') {
      throw new IdentityStoreRefusal('registry-machine-inactive', 'Machine is not active in the registry');
    }
    return entry;
  }
}
