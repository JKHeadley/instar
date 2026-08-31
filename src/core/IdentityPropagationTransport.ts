/** Production HTTP adapters for receiver-authenticated identity propagation. */
import { randomBytes } from 'node:crypto';
import type { MachineIdentity } from './types.js';
import type { MachineOperatorDelegation } from './MachineOperatorDelegation.js';
import { recoveryRootDelegationHash, signingAckDelegationHash } from './MachineOperatorDelegation.js';
import { acceptIdentityPropagationReceipt } from './IdentityPropagationReceipt.js';
import { signRequest } from '../server/machineAuth.js';
import type { AckDeliveryResult } from './IdentityAckPropagation.js';
import type { RecoveryRootDelivery } from './IdentityRecoveryRootPropagation.js';

interface Common {
  peerUrl: string;
  peerMachineId: string;
  selfMachineId: string;
  selfSigningPrivateKeyPem: string;
  peerSigningPublicKeyPem: string;
  operatorDelegation: MachineOperatorDelegation;
  fetchImpl?: typeof fetch;
  requestNonce?: string;
}

export async function sendIdentityAckPropagation(input: Common & {
  machineId: string;
  keyEpoch: number;
}): Promise<AckDeliveryResult> {
  const requestNonce = input.requestNonce ?? randomBytes(32).toString('hex');
  const contentHash = signingAckDelegationHash(input.machineId, input.keyEpoch);
  const body = { machineId: input.machineId, keyEpoch: input.keyEpoch, operatorDelegation: input.operatorDelegation, requestNonce };
  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.peerUrl.replace(/\/+$/, '')}/api/identity/reannounce/ack`, {
      method: 'POST', headers: { ...signRequest(input.selfMachineId, input.selfSigningPrivateKeyPem, body), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return 'pending';
    const receipt = await response.json().catch(() => null);
    const accepted = acceptIdentityPropagationReceipt({
      receipt,
      expected: {
        action: 'signing-ack', responderMachineId: input.peerMachineId,
        requesterMachineId: input.selfMachineId, requestNonce,
        subjectMachineId: input.machineId, epoch: input.keyEpoch, contentHash,
      },
      allowedStatuses: ['acknowledged', 'already-acknowledged'],
      responderSigningPublicKeyPem: input.peerSigningPublicKeyPem,
    });
    return accepted === 'acknowledged' || accepted === 'already-acknowledged' ? accepted : 'pending';
  } catch {
    return 'pending';
  }
}

export async function sendIdentityRecoveryRootPropagation(input: Common & {
  machineIdentity: MachineIdentity;
}): Promise<RecoveryRootDelivery> {
  const requestNonce = input.requestNonce ?? randomBytes(32).toString('hex');
  const contentHash = recoveryRootDelegationHash(input.machineIdentity);
  const body = { machineIdentity: input.machineIdentity, operatorDelegation: input.operatorDelegation, requestNonce };
  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.peerUrl.replace(/\/+$/, '')}/api/identity/recovery-root/establish`, {
      method: 'POST', headers: { ...signRequest(input.selfMachineId, input.selfSigningPrivateKeyPem, body), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return 'pending';
    const receipt = await response.json().catch(() => null);
    const accepted = acceptIdentityPropagationReceipt({
      receipt,
      expected: {
        action: 'recovery-root', responderMachineId: input.peerMachineId,
        requesterMachineId: input.selfMachineId, requestNonce,
        subjectMachineId: input.machineIdentity.machineId,
        epoch: input.machineIdentity.recoveryEpoch ?? 0, contentHash,
      },
      allowedStatuses: ['rotated', 'already-current'],
      responderSigningPublicKeyPem: input.peerSigningPublicKeyPem,
    });
    return accepted === 'rotated' || accepted === 'already-current' ? accepted : 'pending';
  } catch {
    return 'pending';
  }
}
