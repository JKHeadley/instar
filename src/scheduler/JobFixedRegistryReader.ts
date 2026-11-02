/** Point-of-decision read of the single pool writer. A durable replica fences
 * rollback/equivocation, but never substitutes for a fresh writer response.
 * RULE 3.1 RATIONALE: Criticality is high because a false fresh-authority
 * result could close an incorrect routine shape or admit its script. Frequency
 * is once per fixed decision and script admission seam. The upstream is our
 * versioned, signed registry HTTP schema on another machine (stable but subject
 * to version skew and transport failure). The fallback is a null authority,
 * leaving the result unresolved and holding new script admission. Deterministic
 * verification is justified by the pinned signer, signature, epoch witness,
 * freshness bound and fail-closed caller contract; production boot and HTTP
 * tests exercise the writer/peer boundary before activation. */
import type { MachineKeyLookup } from '../core/AppRecordSignatures.js';
import type { FixedResultCertificate, FixedCertificateAuthority } from './JobFixedResultCertificate.js';
import { verifyFixedRegistrySnapshot, type FixedCertificateRegistrySnapshot } from './JobFixedCertificateRegistry.js';
import type { JobFixedRegistryReplica } from './JobFixedRegistryReplica.js';

export interface FreshFixedRegistry {
  authority: FixedCertificateAuthority;
  certificates: ReadonlyMap<string, FixedResultCertificate>;
}

export class JobFixedRegistryReader {
  constructor(private readonly input: {
    pinnedAuthorityMachineId: string;
    keyLookup: MachineKeyLookup;
    replica: JobFixedRegistryReplica;
    fetchSnapshot: () => Promise<FixedCertificateRegistrySnapshot>;
    now?: () => number;
  }) {}

  async read(): Promise<FreshFixedRegistry | null> {
    try {
      const snapshot = await this.input.fetchSnapshot();
      const now = (this.input.now ?? Date.now)();
      const verified = verifyFixedRegistrySnapshot(snapshot, {
        pinnedAuthorityMachineId: this.input.pinnedAuthorityMachineId,
        keyLookup: this.input.keyLookup, minimumEpoch: this.input.replica.latestEpoch(), now,
      });
      if (!verified) return null;
      if (!this.input.replica.accept(snapshot, { pinnedAuthorityMachineId: this.input.pinnedAuthorityMachineId,
        keyLookup: this.input.keyLookup, now })) return null;
      return verified;
    } catch { return null; /* @silent-fallback-ok — unreadable authority cannot grant fixed closure. */ }
  }
}
