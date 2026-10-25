/** Production recovery-root rotation transaction, extracted so every durable
 * boundary can be fault-injected without duplicating server composition. */
import type { MachineIdentity } from './types.js';
import type { MachineOperatorDelegation } from './MachineOperatorDelegation.js';
import type { MachineRecoveryKey, RecoveryKeyMaterial } from './MachineRecoveryKey.js';
import type { IdentityRecoveryRootPropagationQueue, RecoveryRootPropagationJob } from './IdentityRecoveryRootPropagation.js';

export type RecoveryRootRotationBoundary =
  | 'prepared-key'
  | 'attached-keychain-intent'
  | 'prepared-file-outbox'
  | 'committed-public-identity'
  | 'committed-escrow'
  | 'remembered-identity-snapshot'
  | 'committed-file-outbox';

export async function executeRecoveryRootRotationTransaction(input: {
  current: MachineIdentity;
  peerIds: string[];
  recoveryKey: MachineRecoveryKey;
  propagation: IdentityRecoveryRootPropagationQueue;
  rotateLocalRecoveryKey: (material: RecoveryKeyMaterial) => MachineIdentity;
  mintDelegations: (proposed: MachineIdentity, peerIds: string[]) => Record<string, MachineOperatorDelegation>;
  afterBoundary?: (boundary: RecoveryRootRotationBoundary) => void | Promise<void>;
}): Promise<{ rotated: MachineIdentity; propagationJob: RecoveryRootPropagationJob }> {
  const boundary = async (name: RecoveryRootRotationBoundary): Promise<void> => input.afterBoundary?.(name);
  if (!input.current.recoveryPublicKey
    || !input.recoveryKey.has(input.current.machineId, input.current.recoveryPublicKey)) {
    throw new Error('Pinned OS-keychain recovery root is unavailable or mismatched');
  }
  const material = input.recoveryKey.prepareRotation(
    input.current.machineId,
    input.current.recoveryEpoch ?? 0,
    input.current.recoveryPublicKey,
  );
  if (!material) throw new Error('OS-keychain recovery escrow is unavailable');
  await boundary('prepared-key');
  const proposed = { ...input.current, recoveryPublicKey: material.recoveryPublicKey, recoveryEpoch: material.recoveryEpoch };
  const delegations = input.mintDelegations(proposed, input.peerIds);
  input.recoveryKey.attachRotationPropagationIntent(input.current.machineId, proposed, delegations);
  await boundary('attached-keychain-intent');
  const propagationJob = input.propagation.prepare(proposed, delegations);
  await boundary('prepared-file-outbox');
  const rotated = input.rotateLocalRecoveryKey(material);
  await boundary('committed-public-identity');
  if (!input.recoveryKey.commitRotation(input.current.machineId)) throw new Error('Recovery escrow commit failed');
  await boundary('committed-escrow');
  input.recoveryKey.rememberIdentity(rotated);
  await boundary('remembered-identity-snapshot');
  input.propagation.commit(propagationJob.id);
  await boundary('committed-file-outbox');
  return { rotated, propagationJob };
}
