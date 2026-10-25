/** Receiver-signed proof that a durable identity propagation actually committed. */
import { verify } from './MachineIdentity.js';

export type IdentityPropagationAction = 'recovery-root' | 'signing-ack';
export type IdentityPropagationStatus =
  | 'rotated'
  | 'already-current'
  | 'acknowledged'
  | 'already-acknowledged'
  | 'would-rotate'
  | 'would-acknowledge';

export interface IdentityPropagationReceiptUnsigned {
  version: 1;
  action: IdentityPropagationAction;
  responderMachineId: string;
  requesterMachineId: string;
  requestNonce: string;
  subjectMachineId: string;
  epoch: number;
  contentHash: string;
  status: IdentityPropagationStatus;
}

export interface IdentityPropagationReceipt extends IdentityPropagationReceiptUnsigned {
  signature: string;
}

export function identityPropagationReceiptMessage(receipt: IdentityPropagationReceiptUnsigned): string {
  return [
    'instar-identity-propagation-receipt-v1', receipt.action,
    receipt.responderMachineId, receipt.requesterMachineId, receipt.requestNonce,
    receipt.subjectMachineId, String(receipt.epoch), receipt.contentHash, receipt.status,
  ].join('|');
}

export function acceptIdentityPropagationReceipt(input: {
  receipt: unknown;
  expected: Omit<IdentityPropagationReceiptUnsigned, 'version' | 'status'>;
  allowedStatuses: readonly IdentityPropagationStatus[];
  responderSigningPublicKeyPem: string;
}): IdentityPropagationStatus | null {
  const receipt = input.receipt as IdentityPropagationReceipt;
  const expected = input.expected;
  const exact = receipt?.version === 1
    && receipt.action === expected.action
    && receipt.responderMachineId === expected.responderMachineId
    && receipt.requesterMachineId === expected.requesterMachineId
    && receipt.requestNonce === expected.requestNonce
    && receipt.subjectMachineId === expected.subjectMachineId
    && receipt.epoch === expected.epoch
    && receipt.contentHash === expected.contentHash
    && /^[a-f0-9]{64}$/i.test(receipt.requestNonce ?? '')
    && /^[a-f0-9]{64}$/i.test(receipt.contentHash ?? '')
    && typeof receipt.signature === 'string'
    && input.allowedStatuses.includes(receipt.status);
  if (!exact) return null;
  try {
    const { signature, ...unsigned } = receipt;
    return verify(identityPropagationReceiptMessage(unsigned), signature, input.responderSigningPublicKeyPem)
      ? receipt.status
      : null;
  } catch { // @silent-fallback-ok: malformed/unverifiable peer input is an expected authentication refusal, never degraded acceptance
    return null;
  }
}
