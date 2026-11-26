import { createHash } from 'node:crypto';
import { verifySealedJournalPrefix, type SealedJournalPrefix } from './SealedJournalPrefix.js';

type Scope = Pick<SealedJournalPrefix, 'agent' | 'store' | 'predecessor'>;
type ExpectedPredecessor = Parameters<typeof verifySealedJournalPrefix>[0];

interface Attempt {
  operationId: string;
  attemptedSequence: number;
}

interface Intent extends Scope, Attempt {
  attemptedRecordDigest: string;
}

interface Reconciliation extends Scope, Attempt {
  recordDigest: string;
  successorGeneration: number;
  intentDigest: string;
  sealDigest: string;
  manifestDigest: string;
}

/** The digest covers the authenticated envelope, including its signature. */
interface VerifiedEnvelope<T> {
  payload: T;
  digest: string;
}

interface ActivationManifest {
  agent: string;
  store: string;
  generation: number;
  predecessorSealDigest: string;
  unresolvedIntentDigest: string;
}

const digestPattern = /^[a-f0-9]{64}$/;

function sameScope(left: Scope, right: Scope): boolean {
  return left.agent === right.agent && left.store === right.store &&
    left.predecessor.stream === right.predecessor.stream &&
    left.predecessor.incarnation === right.predecessor.incarnation &&
    left.predecessor.writer === right.predecessor.writer &&
    left.predecessor.leaseEpoch === right.predecessor.leaseEpoch;
}

/**
 * Check exact positive evidence after the caller authenticates the envelopes
 * and resolves the live activation generation and predecessor independently.
 */
export function verifySealedAppendReconciliation(input: {
  activeGeneration: number;
  activeManifestDigest: string;
  predecessor: ExpectedPredecessor;
  manifest: VerifiedEnvelope<ActivationManifest>;
  seal: VerifiedEnvelope<SealedJournalPrefix>;
  intent: VerifiedEnvelope<Intent>;
  reconciliation: Reconciliation | null;
  bytes: Buffer | null;
}): 'reconciled' | 'pending' | 'unavailable' {
  const { activeGeneration, activeManifestDigest, predecessor, manifest, seal, intent, reconciliation, bytes } = input;
  const attempt = intent.payload;
  if (!Number.isSafeInteger(activeGeneration) || activeGeneration < 1 ||
      manifest.payload.generation !== activeGeneration || manifest.digest !== activeManifestDigest ||
      manifest.payload.agent !== predecessor.agent || manifest.payload.store !== predecessor.store ||
      !sameScope(attempt, predecessor) ||
      ![manifest.digest, intent.digest, seal.digest, attempt.attemptedRecordDigest].every(value => digestPattern.test(value)) ||
      manifest.payload.unresolvedIntentDigest !== intent.digest ||
      manifest.payload.predecessorSealDigest !== seal.digest ||
      !attempt.operationId || !Number.isSafeInteger(attempt.attemptedSequence) || attempt.attemptedSequence < 1) return 'pending';

  const prefix = verifySealedJournalPrefix(predecessor, seal.payload, bytes);
  if (prefix !== 'verified' || bytes === null) return prefix === 'unavailable' ? 'unavailable' : 'pending';
  if (!reconciliation || !sameScope(attempt, reconciliation) ||
      reconciliation.successorGeneration !== activeGeneration ||
      reconciliation.operationId !== attempt.operationId ||
      reconciliation.attemptedSequence !== attempt.attemptedSequence ||
      reconciliation.recordDigest !== attempt.attemptedRecordDigest ||
      reconciliation.intentDigest !== intent.digest || reconciliation.sealDigest !== seal.digest ||
      reconciliation.manifestDigest !== manifest.digest ||
      attempt.attemptedSequence > seal.payload.terminalSequence) return 'pending';

  // Prefix verification has already established one LF per canonical record.
  let start = 0;
  for (let sequence = 1; sequence < attempt.attemptedSequence; sequence++) {
    start = bytes.indexOf(10, start) + 1;
  }
  const line = bytes.subarray(start, bytes.indexOf(10, start) + 1);
  const record = JSON.parse(line.toString('utf8')) as { operationId?: string };
  return record.operationId === attempt.operationId &&
    createHash('sha256').update(line).digest('hex') === attempt.attemptedRecordDigest ? 'reconciled' : 'pending';
}
