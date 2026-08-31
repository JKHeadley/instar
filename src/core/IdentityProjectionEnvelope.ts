/** Signed, nonce-bound bulk identity projection views for divergence monitoring. */
import { verify } from './MachineIdentity.js';
import type { IdentityProjection } from './IdentityStore.js';

export interface IdentityProjectionBatchWire {
  projections?: unknown[];
  responderMachineId?: string;
  nonce?: string;
  signature?: string;
}

export function identityProjectionBatchMessage(nonce: string, responderMachineId: string, projections: unknown[]): string {
  return `instar-identity-projections-v1|${nonce}|${responderMachineId}|${JSON.stringify(projections)}`;
}

export function acceptIdentityProjectionBatch(input: {
  wire: IdentityProjectionBatchWire;
  expectedResponderMachineId: string;
  expectedNonce: string;
  responderSigningPublicKeyPem: string;
}): IdentityProjection[] | null {
  const { wire } = input;
  if (!Array.isArray(wire.projections) || wire.responderMachineId !== input.expectedResponderMachineId
    || wire.nonce !== input.expectedNonce || typeof wire.signature !== 'string') return null;
  if (!verify(identityProjectionBatchMessage(input.expectedNonce, input.expectedResponderMachineId, wire.projections),
    wire.signature, input.responderSigningPublicKeyPem)) return null;
  const valid = wire.projections.every((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const value = candidate as Partial<IdentityProjection>;
    return typeof value.machineId === 'string'
      && Number.isSafeInteger(value.keyEpoch) && (value.keyEpoch ?? -1) >= 0
      && typeof value.signingFingerprint === 'string'
      && Number.isSafeInteger(value.recoveryEpoch) && (value.recoveryEpoch ?? -1) >= 0
      && (value.recoveryFingerprint === undefined || typeof value.recoveryFingerprint === 'string');
  });
  return valid ? wire.projections as IdentityProjection[] : null;
}
