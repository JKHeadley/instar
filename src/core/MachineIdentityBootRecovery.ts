/** Pre-coordinator machine-identity recovery composition used by server boot. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InstarConfig } from './types.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { MachineIdentityManager } from './MachineIdentity.js';
import { MachineRecoveryKey, type RecoverySecretStore } from './MachineRecoveryKey.js';
import { SecretStore } from './SecretStore.js';
import { hasFreshMachineIdentityActivationProof, type IdentityFeatureMode } from './MachineIdentityActivationGate.js';

export type MachineIdentityBootRecoveryOutcome =
  | 'disabled'
  | 'dry-run'
  | 'coherence-held'
  | 'unchanged'
  | 'keys-recovered'
  | 'identity-recovered';

function privateKeyMatchesIdentity(privateKeyPem: string, expectedPublicKeyBase64: string): boolean {
  try {
    const actual = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'der' });
    const expected = Buffer.from(expectedPublicKeyBase64, 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { // @silent-fallback-ok: malformed key material is a negative cryptographic match, never recovery authority
    return false;
  }
}

function localPrivateKeysMatchIdentity(manager: MachineIdentityManager): boolean {
  try {
    const identity = manager.loadIdentity();
    return privateKeyMatchesIdentity(manager.loadSigningKey(), identity.signingPublicKey)
      && privateKeyMatchesIdentity(manager.loadEncryptionKey(), identity.encryptionPublicKey);
  } catch { // @silent-fallback-ok: unreadable local identity/key files force the recovery-or-fail-closed boot path
    return false;
  }
}

/** Fail-closed boot barrier. The server must pass this before it is allowed to
 * construct/start MultiMachineCoordinator; live recovery faults can therefore
 * never collapse into the coordinator's ordinary single-machine `awake` path. */
export async function enforceMachineIdentityBootRecovery(input: {
  config: InstarConfig;
  manager?: MachineIdentityManager;
  recoveryStore?: RecoverySecretStore;
  now?: number;
  log?: (message: string) => void;
  run?: typeof runMachineIdentityBootRecovery;
}): Promise<MachineIdentityBootRecoveryOutcome> {
  const liveExpected = resolveDevAgentGate(input.config.multiMachine?.recoveryKeyEscrow?.enabled, input.config)
    && input.config.multiMachine?.recoveryKeyEscrow?.dryRun === false;
  const manager = input.manager ?? new MachineIdentityManager(input.config.stateDir);
  try {
    const outcome = await (input.run ?? runMachineIdentityBootRecovery)({ ...input, manager });
    if (liveExpected) {
      const identityPresent = manager.hasIdentity();
      const privateKeysValid = identityPresent && localPrivateKeysMatchIdentity(manager);
      const registryHasEstablishedMachine = Object.values(manager.loadRegistry().machines ?? {})
        .some((entry) => entry.status === 'active' && !entry.revokedAt);
      let epochHasEstablishedMachine = false;
      try {
        const epochs = JSON.parse(fs.readFileSync(path.join(input.config.stateDir, 'state', 'identity-epochs.json'), 'utf8')) as { machines?: Record<string, unknown> };
        epochHasEstablishedMachine = !!epochs.machines && Object.keys(epochs.machines).length > 0;
      } catch { /* absent epoch authority is normal for a genuinely unpaired install */ }
      if (!identityPresent && (registryHasEstablishedMachine || epochHasEstablishedMachine)) {
        throw new Error('established machine identity remains absent after live recovery');
      }
      if (identityPresent && !privateKeysValid) {
        throw new Error('machine identity private key material remains invalid or incomplete after live recovery');
      }
    }
    return outcome;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (liveExpected) throw new Error(`Live machine identity recovery failed closed before coordinator start: ${detail}`);
    input.log?.(`[identity-recovery] boot recovery unavailable: ${detail}`);
    return 'disabled';
  }
}

export async function runMachineIdentityBootRecovery(input: {
  config: InstarConfig;
  manager?: MachineIdentityManager;
  recoveryStore?: RecoverySecretStore;
  now?: number;
  log?: (message: string) => void;
}): Promise<MachineIdentityBootRecoveryOutcome> {
  const { config } = input;
  if (!resolveDevAgentGate(config.multiMachine?.recoveryKeyEscrow?.enabled, config)) return 'disabled';
  if (config.multiMachine?.recoveryKeyEscrow?.dryRun !== false) return 'dry-run';
  const manager = input.manager ?? new MachineIdentityManager(config.stateDir);
  const store = input.recoveryStore ?? new SecretStore({ stateDir: config.stateDir, forceFileKey: config.secrets?.forceFileKey });
  const recovery = new MachineRecoveryKey(store);
  const recoverableSnapshot = manager.hasIdentity() ? null : recovery.recoverIdentitySnapshot();
  let localRecoveryOutcome: MachineIdentityBootRecoveryOutcome = 'unchanged';
  if (manager.hasIdentity()) {
    const current = manager.loadIdentity();
    const recoveryMaterial = recovery.ensure(current.machineId, current.recoveryEpoch ?? 0, current.recoveryPublicKey);
    recovery.rememberIdentity(current);
    const privateKeysValid = localPrivateKeysMatchIdentity(manager);
    const recoveryAuthorityMatches = !!current.recoveryPublicKey
      && recoveryMaterial?.recoveryPublicKey === current.recoveryPublicKey
      && recovery.has(current.machineId, current.recoveryPublicKey);
    if (recoveryAuthorityMatches && !privateKeysValid) {
      const rotated = manager.rotateLocalKeys('automatic recovery: local private key material missing, invalid, or mismatched at boot');
      recovery.rememberIdentity(rotated);
      input.log?.(`[identity-recovery] rebuilt invalid or missing private keys at epoch ${rotated.keyEpoch}`);
      localRecoveryOutcome = 'keys-recovered';
    }
  } else {
    const snapshot = recoverableSnapshot ?? recovery.recoverIdentitySnapshot();
    if (snapshot?.machineId && snapshot.recoveryPublicKey
      && recovery.has(snapshot.machineId, snapshot.recoveryPublicKey)) {
      const recovered = manager.recoverLocalIdentity(snapshot, 'automatic recovery: .instar/machine directory missing at boot');
      recovery.rememberIdentity(recovered);
      input.log?.(`[identity-recovery] rebuilt machine identity ${recovered.machineId.slice(0, 12)}… at epoch ${recovered.keyEpoch}`);
      localRecoveryOutcome = 'identity-recovered';
    }
  }

  // Pool coherence gates REMOTE trust mutation, not recovery of this machine's
  // own keychain-authenticated principal. Restore local material first so the
  // coordinator can start, authenticate a presence pull, and refresh an expired
  // activation proof instead of deadlocking behind the proof it must obtain.
  const registry = manager.loadRegistry();
  const localMachineId = manager.hasIdentity() ? manager.loadIdentity().machineId : recoverableSnapshot?.machineId;
  const activePeerMachineIds = Object.entries(registry.machines ?? {})
    .filter(([machineId, entry]) => machineId !== localMachineId && entry.status === 'active' && !entry.revokedAt)
    .map(([machineId]) => machineId).sort();
  if (activePeerMachineIds.length > 0) {
    const mode = (enabled: boolean, value: boolean | undefined): IdentityFeatureMode => !enabled ? 'off' : value === false ? 'live' : 'dry-run';
    const proved = hasFreshMachineIdentityActivationProof(config.stateDir, {
      'identityReannounce.enabled': mode(resolveDevAgentGate(config.multiMachine?.identityReannounce?.enabled, config), config.multiMachine?.identityReannounce?.dryRun),
      'observedEndpoints.enabled': mode(resolveDevAgentGate(config.multiMachine?.observedEndpoints?.enabled, config), config.multiMachine?.observedEndpoints?.dryRun),
      'recoveryKeyEscrow.enabled': mode(true, config.multiMachine?.recoveryKeyEscrow?.dryRun),
    }, activePeerMachineIds, input.now);
    if (!proved) return 'coherence-held';
  }
  return localRecoveryOutcome;
}
