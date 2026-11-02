/** @self-action-controller: job-fixed-revocation-delivery
 * Crash-safe false-routine revocation delivery. The outbox remains pending
 * until a fresh signed writer snapshot proves the certificate revoked. */
import type { MachineSigner } from '../core/AppRecordSignatures.js';
import type { JobSupervisionStore } from './JobSupervisionStore.js';
import type { JobFixedRegistryReader } from './JobFixedRegistryReader.js';
import { signFixedRevocationProof, type FixedRevocationProof } from './JobFixedRegistryRevocation.js';

export class JobFixedRegistryRevocationDispatcher {
  private running = false;

  constructor(private readonly input: {
    store: JobSupervisionStore;
    signer: MachineSigner;
    reader: JobFixedRegistryReader;
    submit: (proof: FixedRevocationProof) => Promise<void>;
    onFailure?: (certificateId: string) => Promise<void> | void;
    now?: () => number;
  }) {}

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let delivered = 0;
    try {
      for (const pending of this.input.store.pendingFixedRevocations(100, (this.input.now ?? Date.now)())) {
        try {
          const proof = signFixedRevocationProof({ version: 1,
            sourceMachineId: this.input.signer.machineId(), attemptId: pending.attemptId,
            certificateId: pending.certificateId, evidenceId: pending.evidenceId,
            gradedAt: pending.gradedAt, grade: 'incorrect', provider: 'fixed', verdict: 'routine',
          }, this.input.signer);
          await this.input.submit(proof);
          const fresh = await this.input.reader.read();
          if (!fresh?.authority.revokedIds.has(pending.certificateId)) throw new Error('revocation unverified');
          if (this.input.store.acknowledgeFixedRevocation(pending.attemptId,
            pending.evidenceId, (this.input.now ?? Date.now)())) delivered++;
        } catch {
          if (this.input.store.recordFixedRevocationFailure(pending.attemptId,
            pending.evidenceId, (this.input.now ?? Date.now)()) && this.input.onFailure) {
            try {
              await this.input.onFailure(pending.certificateId);
              this.input.store.acknowledgeFixedRevocationAttention(pending.attemptId,
                pending.evidenceId, (this.input.now ?? Date.now)());
            } catch { /* @silent-fallback-ok — undelivered attention remains retryable with the proof. */ }
          }
        }
      }
      return delivered;
    } finally { this.running = false; }
  }
}
