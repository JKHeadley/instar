import type { HostedRelayPhoneBindingReader } from '../server/mobilePairingRoutes.js';
import { normalizeHostedRelayHostname } from './clientHello.js';
import { createHostedRelayOwnerEvidenceReader } from './ownerLeaseReader.js';

/** Output from Identity's verifier of an already committed, current enrollment.
 * A caller must not construct this from a request, locator or unverified row. */
export interface VerifiedHostedRelayPhoneEnrollment {
  deviceId: string;
  deviceKeyHash: string;
  agentId: string;
  hostname: string;
  assignment: string;
  pinnedGenesis: string;
  ownerHead: string;
  authorizerEntry: string;
  holder: string;
  leaseEpoch: number;
  agentSpkiSha256: string;
}

const digest = /^[a-f0-9]{64}$/;

/** Join independent, read-only authorities. This adapter neither verifies an
 * enrollment signature itself nor creates, consumes or updates a grant. */
export function createHostedRelayPhoneBindingReader(options: {
  scope: { hostname: string; agentId: string; assignment: string; pinnedGenesis: string };
  ownerEvidence: Parameters<typeof createHostedRelayOwnerEvidenceReader>[0];
  readVerifiedEnrollment(deviceId: string): VerifiedHostedRelayPhoneEnrollment | undefined;
  readActiveNativePhoneKeyHash(deviceId: string): string | undefined;
}): HostedRelayPhoneBindingReader {
  const { hostname, agentId, assignment, pinnedGenesis } = options.scope;
  const readOwner = createHostedRelayOwnerEvidenceReader(options.ownerEvidence);
  if (normalizeHostedRelayHostname(hostname) !== hostname || !agentId
    || !digest.test(assignment) || !digest.test(pinnedGenesis)) return () => undefined;

  return deviceId => {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) return undefined;
    try {
      const enrollment = options.readVerifiedEnrollment(deviceId);
      if (!enrollment || enrollment.deviceId !== deviceId || enrollment.agentId !== agentId
        || enrollment.hostname !== hostname || enrollment.assignment !== assignment || enrollment.pinnedGenesis !== pinnedGenesis
        || !digest.test(enrollment.deviceKeyHash) || options.readActiveNativePhoneKeyHash(deviceId) !== enrollment.deviceKeyHash) return undefined;
      const current = readOwner(hostname);
      const now = (options.ownerEvidence.now ?? Date.now)();
      if (!current || !Number.isSafeInteger(now) || now < Date.parse(current.committed.acquiredAt)
        || now >= current.serving.expiresAt || current.agentId !== agentId || current.serving.assignment !== assignment
        || current.record.genesis !== pinnedGenesis || current.record.head.length !== 1
        || current.record.head[0] !== enrollment.ownerHead || current.serving.holder !== enrollment.holder
        || current.serving.epoch !== enrollment.leaseEpoch || !digest.test(enrollment.agentSpkiSha256)
        || current.record.tlsKeys[enrollment.holder] !== enrollment.agentSpkiSha256
        || !current.record.keys.some(key => key.type === 'owner-key' && key.addedBy === enrollment.authorizerEntry)) return undefined;
      return { hostname, assignment, keyHash: enrollment.deviceKeyHash };
    } catch { return undefined; } // @silent-fallback-ok — unavailable or unverifiable evidence grants nothing
  };
}
