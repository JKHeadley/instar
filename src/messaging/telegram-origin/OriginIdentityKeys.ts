import type { IdentityStore } from '../../core/IdentityStore.js';
import type { OriginVerificationKey } from './OriginAttestation.js';

/** Epoch-aware resolver. Registry authority is checked by callers for fresh
 * remote acceptance; historical lookup deliberately retains revoked keys. */
export function resolveIdentityOriginKey(store: IdentityStore, machineId: string, agentId: string,
  epoch?: number): OriginVerificationKey | null {
  const authority = store.loadEpochs().machines[machineId];
  const history = store.signingKeyHistory(machineId);
  const key = history.find(value => value.epoch === (epoch ?? authority?.keyEpoch ?? history.at(-1)?.epoch));
  if (!key) return null;
  const publicKey = key.publicKey.startsWith('-----BEGIN PUBLIC KEY-----') ? key.publicKey
    : `-----BEGIN PUBLIC KEY-----\n${key.publicKey.match(/.{1,64}/g)?.join('\n') ?? key.publicKey}\n-----END PUBLIC KEY-----\n`;
  const validFrom = key.validFrom === null ? null : Date.parse(key.validFrom);
  const validUntil = key.validUntil === null ? null : Date.parse(key.validUntil);
  const revokedAt = key.revokedAt === null ? null : Date.parse(key.revokedAt);
  if ([validFrom, validUntil, revokedAt].some(value => value !== null && !Number.isFinite(value))) return null;
  return { machineId, agentId, keyId: `${machineId}:${key.epoch}`, keyEpoch: key.epoch,
    publicKey, validFrom, validUntil, revokedAt };
}
