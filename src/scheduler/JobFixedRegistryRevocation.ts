/** A trusted pool machine reports an independently graded false routine to
 * the single registry writer. The report is signed with that machine's pinned
 * identity key; the writer still owns the epoch transition. */
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature,
  type MachineSigner } from '../core/AppRecordSignatures.js';

export interface FixedRevocationProof {
  version: 1;
  sourceMachineId: string;
  attemptId: string;
  certificateId: string;
  evidenceId: string;
  gradedAt: string;
  grade: 'incorrect';
  provider: 'fixed';
  verdict: 'routine';
  signature: MachineSignature;
}

type UnsignedProof = Omit<FixedRevocationProof, 'signature'>;

export function fixedRevocationPayload(proof: UnsignedProof): string {
  return `instar-fixed-registry-revocation-v1\n${JSON.stringify({
    version: proof.version, sourceMachineId: proof.sourceMachineId,
    attemptId: proof.attemptId, certificateId: proof.certificateId,
    evidenceId: proof.evidenceId, gradedAt: proof.gradedAt,
    grade: proof.grade, provider: proof.provider, verdict: proof.verdict,
  })}`;
}

export function signFixedRevocationProof(proof: UnsignedProof, signer: MachineSigner): FixedRevocationProof {
  if (proof.sourceMachineId !== signer.machineId()) throw new Error('fixed revocation source mismatch');
  return { ...proof, signature: signer.sign(fixedRevocationPayload(proof)) };
}

export function verifyFixedRevocationProof(proof: FixedRevocationProof, lookup: MachineKeyLookup,
  now = Date.now()): boolean {
  if (!proof || proof.version !== 1 || proof.grade !== 'incorrect' || proof.provider !== 'fixed'
    || proof.verdict !== 'routine' || !proof.sourceMachineId || !proof.attemptId
    || !proof.certificateId || !proof.evidenceId
    || proof.signature?.machineId !== proof.sourceMachineId) return false;
  const at = Date.parse(proof.gradedAt);
  if (!Number.isFinite(at) || at > now + 5 * 60_000) return false;
  return verifyMachineSignature(lookup, proof.signature, fixedRevocationPayload(proof), at) === 'ok';
}
