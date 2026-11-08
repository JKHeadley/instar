/** A trusted pool machine reports an independently graded false routine to
 * the single registry writer. The report is signed with that machine's pinned
 * identity key; the writer still owns the epoch transition. */
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature,
  type MachineSigner } from '../core/AppRecordSignatures.js';

export interface FixedRevocationProof {
  version: 2;
  sourceMachineId: string;
  attemptId: string;
  certificateId: string;
  evidenceId: string;
  gradedAt: string;
  /** Machine signing time; the key lookup must use this, not the earlier grade time. */
  signedAt: string;
  grade: 'incorrect';
  provider: 'fixed';
  verdict: 'routine';
  signature: MachineSignature;
}

type UnsignedProof = Omit<FixedRevocationProof, 'signature'>;

export function fixedRevocationPayload(proof: UnsignedProof): string {
  return `instar-fixed-registry-revocation-v2\n${JSON.stringify({
    version: proof.version, sourceMachineId: proof.sourceMachineId,
    attemptId: proof.attemptId, certificateId: proof.certificateId,
    evidenceId: proof.evidenceId, gradedAt: proof.gradedAt, signedAt: proof.signedAt,
    grade: proof.grade, provider: proof.provider, verdict: proof.verdict,
  })}`;
}

export function signFixedRevocationProof(proof: Omit<UnsignedProof, 'signedAt'> & { signedAt?: string },
  signer: MachineSigner): FixedRevocationProof {
  if (proof.sourceMachineId !== signer.machineId()) throw new Error('fixed revocation source mismatch');
  const unsigned: UnsignedProof = { ...proof, signedAt: proof.signedAt ?? new Date().toISOString() };
  return { ...unsigned, signature: signer.sign(fixedRevocationPayload(unsigned)) };
}

export function verifyFixedRevocationProof(proof: FixedRevocationProof, lookup: MachineKeyLookup,
  now = Date.now()): boolean {
  if (!proof || proof.version !== 2 || proof.grade !== 'incorrect' || proof.provider !== 'fixed'
    || proof.verdict !== 'routine' || !proof.sourceMachineId || !proof.attemptId
    || !proof.certificateId || !proof.evidenceId
    || proof.signature?.machineId !== proof.sourceMachineId) return false;
  const gradedAt = Date.parse(proof.gradedAt);
  const signedAt = Date.parse(proof.signedAt);
  if (!Number.isFinite(gradedAt) || !Number.isFinite(signedAt)
    || gradedAt > now + 5 * 60_000 || signedAt > now + 5 * 60_000
    || signedAt < gradedAt) return false;
  return verifyMachineSignature(lookup, proof.signature, fixedRevocationPayload(proof), signedAt) === 'ok';
}
