import { createHash } from 'node:crypto';
import { canonicalJson } from './appMediaTypes.js';

interface PredecessorIdentity {
  stream: string;
  incarnation: string;
  writer: string;
  leaseEpoch: number;
}

export interface SealedJournalPrefix {
  agent: string;
  store: string;
  predecessor: PredecessorIdentity;
  transitionId: string;
  digestFormat: 'instar-journal-prefix-v1';
  terminalSequence: number;
  prefixDigest: string;
}

type ExpectedPredecessor = Pick<SealedJournalPrefix, 'agent' | 'store' | 'predecessor' | 'transitionId'>;

/** Verify bytes against an authenticated seal and predecessor resolved from lease history. */
export function verifySealedJournalPrefix(
  expected: ExpectedPredecessor,
  seal: SealedJournalPrefix,
  bytes: Buffer | null,
): 'verified' | 'pending' | 'unavailable' {
  const prior = seal.predecessor;
  const trusted = expected.predecessor;
  if (seal.agent !== expected.agent || seal.store !== expected.store ||
      seal.transitionId !== expected.transitionId || prior.stream !== trusted.stream ||
      prior.incarnation !== trusted.incarnation || prior.writer !== trusted.writer ||
      prior.leaseEpoch !== trusted.leaseEpoch || !Number.isSafeInteger(prior.leaseEpoch) || prior.leaseEpoch < 1 ||
      seal.digestFormat !== 'instar-journal-prefix-v1' ||
      !Number.isSafeInteger(seal.terminalSequence) || seal.terminalSequence < 0 ||
      !/^[a-f0-9]{64}$/.test(seal.prefixDigest)) return 'pending';
  if (bytes === null) return 'unavailable';

  const hash = createHash('sha256').update('instar-journal-prefix-v1\0');
  const frame = Buffer.alloc(16);
  let sequence = 0;
  let start = 0;
  try {
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      if (end === -1 || ++sequence > seal.terminalSequence) return 'pending';
      const line = bytes.subarray(start, end + 1);
      const record: unknown = JSON.parse(line.toString('utf8'));
      if (!record || typeof record !== 'object' || !('seq' in record) || record.seq !== sequence ||
          !line.equals(Buffer.from(canonicalJson(record) + '\n'))) return 'pending';
      frame.writeBigUInt64BE(BigInt(sequence), 0);
      frame.writeBigUInt64BE(BigInt(line.length), 8);
      hash.update(frame).update(line);
      start = end + 1;
    }
  } catch {
    return 'pending'; // Invalid or noncanonical journal bytes cannot complete the seal.
  }
  return sequence === seal.terminalSequence && hash.digest('hex') === seal.prefixDigest ? 'verified' : 'pending';
}
