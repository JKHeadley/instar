import { createHash } from 'node:crypto';

export type SshHostKeyState = 'current' | 'quarantined' | 'overlap' | 'retired' | 'rollback-rejected';

export interface SignedHostKeyProposal {
  agentId: string;
  machineId: string;
  pairingEpoch: number;
  generation: number;
  previousGeneration: number;
  publicKey: string;
  issuedAt: string;
  machineSignature: string;
  previousHostSignature?: string;
}

export interface HostKeyProposalVerifier {
  verifyMachine(proposal: SignedHostKeyProposal): boolean;
  verifyPreviousHost(proposal: SignedHostKeyProposal): boolean;
}

export interface HostKeyGeneration {
  generation: number;
  fingerprint: string;
  publicKey: string;
  state: SshHostKeyState;
  quarantinedAt?: number;
}

export function canonicalHostKeyProposal(proposal: Omit<SignedHostKeyProposal, 'machineSignature' | 'previousHostSignature'>): string {
  return JSON.stringify({
    agentId: proposal.agentId, machineId: proposal.machineId, pairingEpoch: proposal.pairingEpoch,
    generation: proposal.generation, previousGeneration: proposal.previousGeneration,
    publicKey: proposal.publicKey, issuedAt: proposal.issuedAt,
  });
}

/** Monotonic, fail-closed host-key rotation state machine. */
export class SshHostKeyLifecycle {
  private current: HostKeyGeneration;
  private candidate?: HostKeyGeneration;

  constructor(initial: { generation: number; publicKey: string }, private readonly overlapCeilingMs = 600_000) {
    this.current = { ...initial, fingerprint: keyFingerprint(initial.publicKey), state: 'current' };
  }

  propose(proposal: SignedHostKeyProposal, verifier: HostKeyProposalVerifier, now = Date.now()): HostKeyGeneration {
    const fp = keyFingerprint(proposal.publicKey);
    if (!verifier.verifyMachine(proposal)) throw new Error('host-key-machine-signature-invalid');
    if (proposal.generation <= this.current.generation || proposal.previousGeneration !== this.current.generation) {
      throw new Error('host-key-rollback-rejected');
    }
    if (proposal.generation !== this.current.generation + 1) throw new Error('host-key-generation-gap');
    if (this.candidate) {
      if (this.candidate.generation === proposal.generation && this.candidate.fingerprint === fp) return this.candidate;
      throw new Error('host-key-competing-proposal');
    }
    this.candidate = { generation: proposal.generation, publicKey: proposal.publicKey, fingerprint: fp, state: 'quarantined', quarantinedAt: now };
    if (proposal.previousHostSignature && verifier.verifyPreviousHost(proposal)) this.candidate.state = 'overlap';
    return this.candidate;
  }

  proveCandidate(generation: number): HostKeyGeneration {
    if (!this.candidate || this.candidate.generation !== generation) throw new Error('host-key-not-quarantined');
    this.candidate.state = 'overlap';
    return this.candidate;
  }

  promote(generation: number, allRequiredInboundProofs: boolean, now = Date.now()): HostKeyGeneration {
    if (!this.candidate || this.candidate.generation !== generation || this.candidate.state !== 'overlap') throw new Error('host-key-not-in-overlap');
    if (now - (this.candidate.quarantinedAt ?? now) > this.overlapCeilingMs) throw new Error('host-key-overlap-expired');
    if (!allRequiredInboundProofs) throw new Error('host-key-proofs-incomplete');
    this.current = { ...this.candidate, state: 'current', quarantinedAt: undefined };
    this.candidate = undefined;
    return this.current;
  }

  expire(now = Date.now()): void {
    if (this.candidate && now - (this.candidate.quarantinedAt ?? now) > this.overlapCeilingMs) this.candidate = undefined;
  }

  snapshot(): { current: HostKeyGeneration; candidate?: HostKeyGeneration } {
    return { current: { ...this.current }, candidate: this.candidate ? { ...this.candidate } : undefined };
  }
}

function keyFingerprint(publicKey: string): string {
  const body = publicKey.trim().split(/\s+/)[1];
  if (!body) throw new Error('host-key-invalid');
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex');
}
