/** Keychain-only recovery-key escrow and domain-separated continuity proofs. */

import crypto from 'node:crypto';
import { base64ToSigningPem, generateSigningKeyPair, pemToBase64, sign, verify } from './MachineIdentity.js';
import type { MachineIdentity } from './types.js';
import {
  machineOperatorGrantMessage,
  verifyMachineOperatorDelegation,
  type MachineOperatorDelegation,
  type MachineOperatorGrantUnsigned,
} from './MachineOperatorDelegation.js';

export interface RecoverySecretStore {
  readonly isKeychainBacked: boolean;
  get(keyPath: string): unknown;
  set(keyPath: string, value: unknown): void;
  delete(keyPath: string): void;
}

export interface RotationBinding {
  nonce: string;
  claimantMachineId: string;
  newSigningPublicKey: string;
  newEncryptionPublicKey: string;
  challengerMachineId: string;
  keyEpoch: number;
  recoveryEpoch: number;
  newRecoveryPublicKey?: string;
}

export interface RecoveryKeyMaterial {
  recoveryPublicKey: string;
  recoveryEpoch: number;
}

export interface RecoveryRotationPropagationIntent {
  machineIdentity: MachineIdentity;
  operatorDelegations: Record<string, MachineOperatorDelegation>;
}

const SECRET_PREFIX = 'machineIdentityRecovery';

function hashField(value: string | undefined): string {
  return crypto.createHash('sha256').update(value ?? '').digest('hex');
}

function privateMatchesPublic(privateKeyPem: string, publicKeyBase64: string): boolean {
  try {
    const derived = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
    const left = Buffer.from(derived);
    const right = Buffer.from(publicKeyBase64);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch { // @silent-fallback-ok: invalid key material is a negative match and cannot authorize recovery
    return false;
  }
}

/** New-key possession binding: exactly the six protocol fields, domain separated. */
export function signingRotationMessage(binding: RotationBinding): string {
  return [
    'instar-identity-signing-rotation-v1',
    binding.nonce,
    binding.claimantMachineId,
    hashField(binding.newSigningPublicKey),
    hashField(binding.newEncryptionPublicKey),
    binding.challengerMachineId,
    String(binding.keyEpoch),
  ].join('|');
}

/** Recovery continuity binding: nonce + both epochs + both key fingerprints. */
export function recoveryContinuityMessage(binding: RotationBinding): string {
  return [
    'instar-identity-recovery-continuity-v1',
    binding.nonce,
    binding.claimantMachineId,
    String(binding.keyEpoch),
    hashField(binding.newSigningPublicKey),
    hashField(binding.newRecoveryPublicKey),
    String(binding.recoveryEpoch),
  ].join('|');
}

export function verifySigningPossession(binding: RotationBinding, signature: string): boolean {
  try {
    return verify(signingRotationMessage(binding), signature, base64ToSigningPem(binding.newSigningPublicKey));
  } catch { // @silent-fallback-ok: malformed signing material fails possession verification closed
    return false;
  }
}

export function verifyRecoveryContinuity(
  binding: RotationBinding,
  signature: string,
  recoveryPublicKey: string,
): boolean {
  try {
    return verify(recoveryContinuityMessage(binding), signature, base64ToSigningPem(recoveryPublicKey));
  } catch { // @silent-fallback-ok: malformed recovery material fails continuity verification closed
    return false;
  }
}

export class MachineRecoveryKey {
  private readonly store: RecoverySecretStore;

  constructor(store: RecoverySecretStore) {
    this.store = store;
  }

  private secretPath(machineId: string): string {
    return `${SECRET_PREFIX}.${machineId}.privateKeyPem`;
  }

  private publicPath(machineId: string): string {
    return `${SECRET_PREFIX}.${machineId}.publicKey`;
  }

  private epochPath(machineId: string): string {
    return `${SECRET_PREFIX}.${machineId}.recoveryEpoch`;
  }

  private pendingRotationPath(machineId: string): string {
    return `${SECRET_PREFIX}.${machineId}.pendingRotation`;
  }

  private finishPendingRotation(machineId: string): RecoveryKeyMaterial | null {
    const pending = this.store.get(this.pendingRotationPath(machineId)) as {
      privateKeyPem?: unknown; recoveryPublicKey?: unknown; recoveryEpoch?: unknown;
      propagationIntent?: unknown;
    } | undefined;
    if (!pending || typeof pending.privateKeyPem !== 'string' || typeof pending.recoveryPublicKey !== 'string'
      || !Number.isSafeInteger(pending.recoveryEpoch)
      || !privateMatchesPublic(pending.privateKeyPem, pending.recoveryPublicKey)) return null;
    this.store.set(this.secretPath(machineId), pending.privateKeyPem);
    this.store.set(this.publicPath(machineId), pending.recoveryPublicKey);
    this.store.set(this.epochPath(machineId), Number(pending.recoveryEpoch));
    this.store.set(`${SECRET_PREFIX}.lastMachineId`, machineId);
    // Keep the old-root-signed propagation intent as a redundant durable
    // outbox until a later rotation supersedes it. This lets boot repair a
    // missing/corrupt file queue without ever needing the retired private root.
    if (pending.propagationIntent) {
      this.store.set(this.pendingRotationPath(machineId), { ...pending, committed: true });
    } else {
      this.store.delete(this.pendingRotationPath(machineId));
    }
    return { recoveryPublicKey: pending.recoveryPublicKey, recoveryEpoch: Number(pending.recoveryEpoch) };
  }

  /**
   * Mint once only when the live SecretStore proves its master key is OS-keychain
   * backed. The ciphertext lives in `.instar/secrets/`, outside `.instar/machine/**`.
   */
  ensure(machineId: string, currentEpoch = 0, expectedPublicKey?: string): RecoveryKeyMaterial | null {
    if (!this.store.isKeychainBacked) return null;
    const pending = this.store.get(this.pendingRotationPath(machineId)) as {
      recoveryPublicKey?: unknown; priorPublicKey?: unknown; propagationIntent?: unknown;
    } | undefined;
    if (pending) {
      if (expectedPublicKey && pending.recoveryPublicKey === expectedPublicKey) {
        this.finishPendingRotation(machineId);
      } else if (expectedPublicKey && pending.priorPublicKey === expectedPublicKey) {
        // Identity never reached its public-key commit point; keep the old
        // working escrow pair. Once a signed propagation intent exists, retain
        // it until the file outbox reconciles; deleting it here would make a
        // prepared crash journal unauthenticatable later in the same boot.
        if (!pending.propagationIntent) this.store.delete(this.pendingRotationPath(machineId));
      }
    }
    const existingPrivate = this.store.get(this.secretPath(machineId));
    const existingPublic = this.store.get(this.publicPath(machineId));
    const existingEpoch = this.store.get(this.epochPath(machineId));
    if (typeof existingPrivate === 'string' && typeof existingPublic === 'string') {
      if (!privateMatchesPublic(existingPrivate, existingPublic)) return null;
      if (expectedPublicKey && existingPublic !== expectedPublicKey) return null;
      this.store.set(`${SECRET_PREFIX}.lastMachineId`, machineId);
      return {
        recoveryPublicKey: existingPublic,
        recoveryEpoch: Number.isSafeInteger(existingEpoch) ? Number(existingEpoch) : Math.max(1, currentEpoch),
      };
    }
    // Once a public recovery root is established, losing its private half is a
    // visible downgrade. Minting a replacement here would create a secret that
    // can never satisfy peers' established anchor and could look deceptively
    // healthy merely because some recovery private key exists.
    if (expectedPublicKey) return null;
    const pair = generateSigningKeyPair();
    const recoveryEpoch = Math.max(1, currentEpoch + 1);
    const recoveryPublicKey = pemToBase64(pair.publicKey);
    this.store.set(this.secretPath(machineId), pair.privateKey);
    this.store.set(this.publicPath(machineId), recoveryPublicKey);
    this.store.set(this.epochPath(machineId), recoveryEpoch);
    this.store.set(`${SECRET_PREFIX}.lastMachineId`, machineId);
    return { recoveryPublicKey, recoveryEpoch };
  }

  /** Prepare a fresh recovery generation for an operator-authenticated re-pair
   * or recovery-root rotation. A vault-resident pending record makes the
   * multi-key SecretStore update replayable after interruption. */
  prepareRotation(machineId: string, currentEpoch: number, expectedPublicKey: string): RecoveryKeyMaterial | null {
    if (!this.store.isKeychainBacked || !this.has(machineId, expectedPublicKey)) return null;
    const existingPending = this.store.get(this.pendingRotationPath(machineId)) as {
      recoveryPublicKey?: unknown; recoveryEpoch?: unknown;
    } | undefined;
    if (typeof existingPending?.recoveryPublicKey === 'string' && Number(existingPending.recoveryEpoch) === currentEpoch + 1) {
      return { recoveryPublicKey: existingPending.recoveryPublicKey, recoveryEpoch: Number(existingPending.recoveryEpoch) };
    }
    const pair = generateSigningKeyPair();
    const priorPublicKey = this.store.get(this.publicPath(machineId));
    const pending = {
      privateKeyPem: pair.privateKey,
      recoveryPublicKey: pemToBase64(pair.publicKey),
      recoveryEpoch: Math.max(1, currentEpoch + 1),
      priorPublicKey: typeof priorPublicKey === 'string' ? priorPublicKey : undefined,
    };
    this.store.set(this.pendingRotationPath(machineId), pending);
    return { recoveryPublicKey: pending.recoveryPublicKey, recoveryEpoch: pending.recoveryEpoch };
  }

  attachRotationPropagationIntent(
    machineId: string,
    machineIdentity: MachineIdentity,
    operatorDelegations: Record<string, MachineOperatorDelegation>,
  ): void {
    const path = this.pendingRotationPath(machineId);
    const pending = this.store.get(path) as {
      privateKeyPem?: unknown; recoveryPublicKey?: unknown; recoveryEpoch?: unknown;
      priorPublicKey?: unknown; propagationIntent?: unknown;
    } | undefined;
    if (!pending || pending.recoveryPublicKey !== machineIdentity.recoveryPublicKey
      || pending.recoveryEpoch !== machineIdentity.recoveryEpoch
      || machineIdentity.machineId !== machineId) {
      throw new Error('recovery rotation propagation intent does not match pending key');
    }
    const priorPrivateKeyPem = this.store.get(this.secretPath(machineId));
    const priorRecoveryPublicKey = this.store.get(this.publicPath(machineId));
    if (typeof priorPrivateKeyPem !== 'string' || typeof priorRecoveryPublicKey !== 'string'
      || !privateMatchesPublic(priorPrivateKeyPem, priorRecoveryPublicKey)) {
      throw new Error('prior recovery signing root unavailable for durable propagation');
    }
    this.store.set(path, {
      ...pending,
      priorPrivateKeyPem,
      priorRecoveryPublicKey,
      propagationIntent: { machineIdentity: { ...machineIdentity }, operatorDelegations: { ...operatorDelegations } },
    });
  }

  /** Reauthorize the same interrupted propagation under the retained prior
   * root. It cannot be used for a new epoch or any unrelated action. */
  signRetainedOperatorGrant(machineId: string, grant: MachineOperatorGrantUnsigned): string | null {
    if (!this.store.isKeychainBacked || grant.issuerMachineId !== machineId) return null;
    const pending = this.store.get(this.pendingRotationPath(machineId)) as {
      priorPrivateKeyPem?: unknown;
      priorRecoveryPublicKey?: unknown;
      propagationIntent?: { machineIdentity?: MachineIdentity };
    } | undefined;
    const identity = pending?.propagationIntent?.machineIdentity;
    if (!identity || identity.machineId !== machineId || grant.action !== 'rotate-recovery-root'
      || grant.subjectMachineId !== machineId || grant.epoch !== identity.recoveryEpoch
      || typeof pending?.priorPrivateKeyPem !== 'string'
      || typeof pending.priorRecoveryPublicKey !== 'string'
      || !privateMatchesPublic(pending.priorPrivateKeyPem, pending.priorRecoveryPublicKey)) return null;
    try { return sign(machineOperatorGrantMessage(grant), pending.priorPrivateKeyPem); } catch { return null; /* @silent-fallback-ok: signing failure with retained authority produces no grant */ }
  }

  /** Authenticate a durable rotation outbox with the retired recovery root
   * retained in the keychain transaction. The project-file journal alone is
   * never sufficient authority. */
  validateRetainedOperatorDelegation(machineId: string, grant: MachineOperatorDelegation): boolean {
    if (!this.store.isKeychainBacked || grant.issuerMachineId !== machineId) return false;
    const pending = this.store.get(this.pendingRotationPath(machineId)) as {
      priorPrivateKeyPem?: unknown;
      priorRecoveryPublicKey?: unknown;
      propagationIntent?: { machineIdentity?: MachineIdentity };
    } | undefined;
    const identity = pending?.propagationIntent?.machineIdentity;
    return !!pending && identity?.machineId === machineId
      && grant.action === 'rotate-recovery-root'
      && grant.subjectMachineId === machineId
      && grant.epoch === identity.recoveryEpoch
      && typeof pending.priorPrivateKeyPem === 'string'
      && typeof pending.priorRecoveryPublicKey === 'string'
      && privateMatchesPublic(pending.priorPrivateKeyPem, pending.priorRecoveryPublicKey)
      && verifyMachineOperatorDelegation(grant, pending.priorRecoveryPublicKey);
  }

  finalizeRotationPropagation(machineId: string, recoveryEpoch: number): boolean {
    const path = this.pendingRotationPath(machineId);
    const pending = this.store.get(path) as {
      recoveryPublicKey?: unknown;
      recoveryEpoch?: unknown;
      propagationIntent?: { machineIdentity?: MachineIdentity };
      committed?: unknown;
    } | undefined;
    if (!pending || pending.committed !== true || pending.recoveryEpoch !== recoveryEpoch
      || pending.propagationIntent?.machineIdentity?.recoveryEpoch !== recoveryEpoch
      || this.store.get(this.publicPath(machineId)) !== pending.recoveryPublicKey) return false;
    // The active private key remains at secretPath. Removing the transaction
    // record erases the retired private root and redundant grant outbox only
    // after every peer has authenticated the new generation.
    this.store.delete(path);
    return true;
  }

  loadRotationPropagationIntent(machineId: string): RecoveryRotationPropagationIntent | null {
    if (!this.store.isKeychainBacked) return null;
    const pending = this.store.get(this.pendingRotationPath(machineId)) as {
      propagationIntent?: { machineIdentity?: unknown; operatorDelegations?: unknown };
    } | undefined;
    const intent = pending?.propagationIntent;
    if (!intent || !intent.machineIdentity || typeof intent.machineIdentity !== 'object'
      || !intent.operatorDelegations || typeof intent.operatorDelegations !== 'object') return null;
    const identity = intent.machineIdentity as MachineIdentity;
    if (identity.machineId !== machineId || !identity.recoveryPublicKey
      || !Number.isSafeInteger(identity.recoveryEpoch)) return null;
    return {
      machineIdentity: { ...identity },
      operatorDelegations: { ...(intent.operatorDelegations as Record<string, MachineOperatorDelegation>) },
    };
  }

  commitRotation(machineId: string): RecoveryKeyMaterial | null {
    return this.finishPendingRotation(machineId);
  }

  /** Complete an interrupted escrow commit only when the already-committed
   * public identity names the exact pending generation. */
  reconcileRotationCommit(identity: MachineIdentity): boolean {
    if (!identity.recoveryPublicKey || !Number.isSafeInteger(identity.recoveryEpoch)) return false;
    const activePublic = this.store.get(this.publicPath(identity.machineId));
    const activeEpoch = this.store.get(this.epochPath(identity.machineId));
    const activePrivate = this.store.get(this.secretPath(identity.machineId));
    if (activePublic === identity.recoveryPublicKey && activeEpoch === identity.recoveryEpoch
      && typeof activePrivate === 'string' && privateMatchesPublic(activePrivate, identity.recoveryPublicKey)) return true;
    const pending = this.store.get(this.pendingRotationPath(identity.machineId)) as {
      recoveryPublicKey?: unknown; recoveryEpoch?: unknown;
    } | undefined;
    if (pending?.recoveryPublicKey !== identity.recoveryPublicKey
      || pending.recoveryEpoch !== identity.recoveryEpoch) return false;
    return !!this.commitRotation(identity.machineId);
  }

  rotate(machineId: string, currentEpoch: number, expectedPublicKey: string): RecoveryKeyMaterial | null {
    const material = this.prepareRotation(machineId, currentEpoch, expectedPublicKey);
    return material ? this.commitRotation(machineId) : null;
  }

  rememberIdentity(identity: MachineIdentity): void {
    if (!this.store.isKeychainBacked || !identity.recoveryPublicKey
      || !this.has(identity.machineId, identity.recoveryPublicKey)) return;
    this.store.set(`${SECRET_PREFIX}.lastMachineId`, identity.machineId);
    this.store.set(`${SECRET_PREFIX}.${identity.machineId}.identitySnapshot`, {
      machineId: identity.machineId,
      name: identity.name,
      platform: identity.platform,
      createdAt: identity.createdAt,
      capabilities: identity.capabilities,
      signingPublicKey: identity.signingPublicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
      recoveryPublicKey: identity.recoveryPublicKey,
      recoveryEpoch: identity.recoveryEpoch ?? 0,
      recoveryAnchorProvenance: identity.recoveryAnchorProvenance,
    });
  }

  recoverIdentitySnapshot(): Partial<MachineIdentity> | null {
    if (!this.store.isKeychainBacked) return null;
    const machineId = this.store.get(`${SECRET_PREFIX}.lastMachineId`);
    if (typeof machineId !== 'string') return null;
    const snapshot = this.store.get(`${SECRET_PREFIX}.${machineId}.identitySnapshot`);
    if (!snapshot || typeof snapshot !== 'object') return null;
    const identity = { ...(snapshot as Partial<MachineIdentity>), machineId };
    if (typeof identity.recoveryPublicKey !== 'string'
      || !this.has(machineId, identity.recoveryPublicKey)) return null;
    return identity;
  }

  has(machineId: string, expectedPublicKey?: string): boolean {
    if (!this.store.isKeychainBacked) return false;
    const privateKey = this.store.get(this.secretPath(machineId));
    const publicKey = this.store.get(this.publicPath(machineId));
    return typeof privateKey === 'string'
      && typeof publicKey === 'string'
      && (!expectedPublicKey || publicKey === expectedPublicKey)
      && privateMatchesPublic(privateKey, publicKey);
  }

  signContinuity(machineId: string, binding: RotationBinding): string | null {
    if (!this.store.isKeychainBacked) return null;
    const key = this.store.get(this.secretPath(machineId));
    const publicKey = this.store.get(this.publicPath(machineId));
    if (typeof key !== 'string' || typeof publicKey !== 'string' || !privateMatchesPublic(key, publicKey)) return null;
    try {
      return sign(recoveryContinuityMessage(binding), key);
    } catch { // @silent-fallback-ok: continuity signing failure produces no signature, and the claimant refuses to submit
      return null;
    }
  }

  /** Domain-separated receiver-verifiable proof for a dashboard-PIN-authorized
   * identity control action. This is deliberately unavailable without the
   * separately pinned, keychain-backed recovery root. */
  signOperatorGrant(machineId: string, expectedPublicKey: string, grant: MachineOperatorGrantUnsigned): string | null {
    if (!this.store.isKeychainBacked || grant.issuerMachineId !== machineId) return null;
    const key = this.store.get(this.secretPath(machineId));
    const publicKey = this.store.get(this.publicPath(machineId));
    if (typeof key !== 'string' || publicKey !== expectedPublicKey || !privateMatchesPublic(key, publicKey)) return null;
    try { return sign(machineOperatorGrantMessage(grant), key); } catch { return null; /* @silent-fallback-ok: signing failure produces no operator grant and no mutation */ }
  }

  destroy(machineId: string): void {
    this.store.delete(this.secretPath(machineId));
    this.store.delete(this.publicPath(machineId));
    this.store.delete(this.epochPath(machineId));
    this.store.delete(this.pendingRotationPath(machineId));
    this.store.delete(`${SECRET_PREFIX}.${machineId}.identitySnapshot`);
    if (this.store.get(`${SECRET_PREFIX}.lastMachineId`) === machineId) {
      this.store.delete(`${SECRET_PREFIX}.lastMachineId`);
    }
  }
}
