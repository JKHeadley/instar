import { X509Certificate, createHash } from 'node:crypto';
import { OWNER_RECORD_MAX_INPUT, ownerRecordEntryId, type OwnerRecordEntry } from '../core/ownerRecord.js';
import { normalizeHostedRelayHostname } from './clientHello.js';
import type { createHostedRelayOwnerEvidenceReader } from './ownerLeaseReader.js';
import type { HostedRelaySetupReceipt } from './setupReceipt.js';

const digest = /^[a-f0-9]{64}$/;

export interface HostedRelayAgentPin {
  readonly hostname: string;
  readonly agentId: string;
  readonly assignment: string;
  readonly genesis: string;
  readonly ownerHead: string;
  readonly holder: string;
  readonly leaseEpoch: number;
  readonly spkiSha256: string;
  readonly tlsFloors: Readonly<Record<string, Readonly<{ sequence: number; entryId: string }>>>;
}

function verifiedEntries(entries: unknown[], signatures: Record<string, string>): Map<string, OwnerRecordEntry> {
  const verified = new Map<string, OwnerRecordEntry>();
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== 'object') continue;
    const entry = candidate as OwnerRecordEntry;
    if (!Array.isArray(entry.parents) || typeof entry.sig !== 'string') continue;
    const id = ownerRecordEntryId(entry);
    if (Object.hasOwn(signatures, id) && signatures[id] === entry.sig) verified.set(id, entry);
  }
  return verified;
}

function descendsFrom(head: string, previous: string, entries: Map<string, OwnerRecordEntry>): boolean {
  const pending = [head], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === previous) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(entries.get(id)?.parents ?? []));
  }
  return false;
}

/** Authorize a candidate key only from an independently pinned owner record
 * and committed agent-scoped lease. The certificate must be the one observed
 * on the candidate TLS connection, before sending credentials or requests. */
export function readHostedRelayAgentPin(options: {
  locator: HostedRelaySetupReceipt;
  certificateDer: Buffer;
  trusted: Pick<HostedRelayAgentPin, 'agentId' | 'assignment' | 'genesis'>;
  previous?: HostedRelayAgentPin;
  currentEvidence: ReturnType<typeof createHostedRelayOwnerEvidenceReader>;
}): HostedRelayAgentPin | undefined {
  const { locator, trusted, previous } = options;
  if (!locator || locator.kind !== 'relay-locator' || typeof locator.hostname !== 'string'
    || normalizeHostedRelayHostname(locator.hostname) !== locator.hostname || locator.origin !== 'https://' + locator.hostname
    || !digest.test(trusted.genesis) || !digest.test(trusted.assignment)
    || !Buffer.isBuffer(options.certificateDer) || options.certificateDer.length > 32 * 1024) return undefined;
  try {
    const evidence = options.currentEvidence(locator.hostname);
    if (!evidence) return undefined;
    const { serving, agentId, record, entries } = evidence;
    const ownerHead = record.head[0];
    if (agentId !== trusted.agentId || serving.hostname !== locator.hostname || serving.assignment !== trusted.assignment
      || record.genesis !== trusted.genesis || record.head.length !== 1 || !digest.test(ownerHead)) return undefined;
    const certificate = new X509Certificate(options.certificateDer);
    const now = Date.now();
    if (!certificate.checkHost(locator.hostname) || !(Date.parse(certificate.validFrom) <= now && now < Date.parse(certificate.validTo))) {
      return undefined;
    }
    const spkiSha256 = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (record.tlsKeys[serving.holder] !== spkiSha256) return undefined;
    const graph = verifiedEntries(entries, record.signatures);
    const winnerId = record.effective.find(id => {
      const entry = graph.get(id);
      return entry?.kind === 'tls-key' && entry.body.machineId === serving.holder && entry.body.fingerprint === spkiSha256;
    });
    const sequence = winnerId && graph.get(winnerId)?.body.seq;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0 || !winnerId) return undefined;
    if (previous && (previous.hostname !== locator.hostname || previous.agentId !== agentId || previous.assignment !== trusted.assignment || previous.genesis !== trusted.genesis
      || !digest.test(previous.ownerHead) || !digest.test(previous.spkiSha256)
      || !Number.isSafeInteger(previous.leaseEpoch) || previous.leaseEpoch < 1
      || serving.epoch < previous.leaseEpoch || (serving.epoch === previous.leaseEpoch && serving.holder !== previous.holder)
      || !descendsFrom(ownerHead, previous.ownerHead, graph))) return undefined;
    const floors = previous ? Object.entries(previous.tlsFloors) : [];
    if ((previous && !Object.hasOwn(previous.tlsFloors, previous.holder)) || floors.length >= OWNER_RECORD_MAX_INPUT || floors.some(([holder, floor]) => !/^m_[0-9A-Za-z_-]{1,64}$/.test(holder)
      || !floor || !digest.test(floor.entryId) || !Number.isSafeInteger(floor.sequence) || floor.sequence < 0)) return undefined;
    const earlier = floors.find(([holder]) => holder === serving.holder)?.[1];
    if (earlier && (sequence < earlier.sequence || (sequence === earlier.sequence && winnerId !== earlier.entryId))) return undefined;
    const tlsFloors = Object.freeze(Object.fromEntries([
      ...floors.map(([holder, floor]) => [holder, Object.freeze({ ...floor })] as const),
      [serving.holder, Object.freeze({ sequence, entryId: winnerId })] as const,
    ]));
    return Object.freeze({ hostname: locator.hostname, agentId, assignment: trusted.assignment, genesis: trusted.genesis, ownerHead, holder: serving.holder,
      leaseEpoch: serving.epoch, spkiSha256, tlsFloors });
  } catch { return undefined; } // @silent-fallback-ok — unknown key changes confer no identity authority
}
