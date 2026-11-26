import { createPublicKey, verify } from 'node:crypto';
import { FencedLease } from '../core/FencedLease.js';
import { evaluateOwnerRecord, type EvaluateOptions } from '../core/ownerRecord.js';
import type { LeaseRecord } from '../core/types.js';
import type { HostedRelayLease } from './leaseAdmission.js';

interface Registration {
  agentId: string;
  assignment: string;
  pinnedGenesis: string;
  entries: unknown[];
}

/** All inputs come from the relay's own registration and committed evidence
 * sources. None may be taken from the connection being admitted. */
export function createHostedRelayOwnerEvidenceReader(options: {
  registration(hostname: string): Registration | undefined;
  /** Resolve a committed record in this agent's authority domain. The legacy
   * mesh lease signature does not include the agent ID. */
  committedLease(agentId: string): LeaseRecord | undefined;
  verifyFirstOwnerProof: NonNullable<EvaluateOptions['verifyFirstOwnerProof']>;
  now?: () => number;
}) {
  return (hostname: string) => {
    try {
      const registration = options.registration(hostname);
      if (!registration || !/^[a-f0-9]{64}$/.test(registration.pinnedGenesis)
        || !/^[a-f0-9]{64}$/.test(registration.assignment)) return undefined;
      const record = evaluateOwnerRecord(registration.entries, {
        agentId: registration.agentId,
        pinnedGenesis: registration.pinnedGenesis,
        verifyFirstOwnerProof: options.verifyFirstOwnerProof,
      });
      if (record.status !== 'ok' || record.genesis !== registration.pinnedGenesis
        || record.forked || !record.keys.some(key => key.type === 'owner-key')) return undefined;
      const lease = options.committedLease(registration.agentId);
      if (!lease || lease.released || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
        || !Number.isSafeInteger(lease.nonce) || lease.nonce < 0) return undefined;
      const acquiredAt = Date.parse(lease.acquiredAt), expiresAt = Date.parse(lease.expiresAt);
      const now = (options.now ?? Date.now)();
      if (![acquiredAt, expiresAt, now].every(Number.isSafeInteger) || acquiredAt >= expiresAt || now >= expiresAt) return undefined;
      const machine = record.keys.find(key => key.type === 'machine' && key.keyId === lease.holder);
      if (!machine) return undefined;
      const key = createPublicKey(machine.publicKey);
      if (key.asymmetricKeyType !== 'ed25519'
        || !verify(null, Buffer.from(FencedLease.canonicalize(lease)), key, Buffer.from(lease.signature, 'base64'))) return undefined;
      const serving: HostedRelayLease & { publicKeyPem: string } = Object.freeze({
        hostname, assignment: registration.assignment, holder: lease.holder,
        epoch: lease.epoch, expiresAt, publicKeyPem: machine.publicKey,
      });
      return { serving, agentId: registration.agentId, record, entries: registration.entries, committed: { ...lease } };
    } catch { return undefined; } // @silent-fallback-ok — unreadable owner or lease evidence confers no routing authority
  };
}

export function createHostedRelayOwnerLeaseReader(options: Parameters<typeof createHostedRelayOwnerEvidenceReader>[0]) {
  const evidence = createHostedRelayOwnerEvidenceReader(options);
  return (hostname: string) => evidence(hostname)?.serving;
}
