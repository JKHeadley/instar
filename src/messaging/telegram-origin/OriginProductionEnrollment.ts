import { fileURLToPath } from 'node:url';
import type { OriginActivationObservation } from './OriginActivation.js';
import { inspectOriginCertification, type OriginCertificationResult } from './OriginCertification.js';

/** Assigned only by the existing recipient-bound, signed mesh client. */
export type OriginEnrollmentPeerTransport = (machineId: string,
  command: { type: 'telegram-origin'; protocol: 'instar-telegram-origin-v1'; action: 'capabilities' },
  timeoutMs: number) => Promise<{ ok: boolean; result?: unknown }>;
export interface OriginProductionEnrollmentOptions {
  selfMachineId: string;
  accountId: string | null;
  activePeerIds: () => string[];
  producerIds: () => string[];
  peerTransport: () => OriginEnrollmentPeerTransport | undefined;
  /** Internal package factory seam, not an operator config/HTTP assertion. */
  packageRoot?: string;
  now?: () => number;
}
type Observation = OriginActivationObservation & { certification?: {
  buildDigest: string; approvedAt: number; expiresAt: number;
  trials: Array<{ kind: string; completedAt: number; evidenceDigest: string }>;
} };

/** Diagnostic-only collector. Live inventory proves what is present; a release
 * review certifies body/author binding and the sender census. Neither substitutes
 * for the other. Cache reads keep the original verification time and expiry. */
export class OriginProductionEnrollment {
  private certificate?: OriginCertificationResult;
  constructor(private readonly options: OriginProductionEnrollmentOptions) {}
  async inspect(): Promise<Observation[]> {
    const now = this.options.now?.() ?? Date.now();
    if (!this.certificate || now < this.certificate.verifiedAt || now - this.certificate.verifiedAt >= 15_000 || now >= this.certificate.validUntil) {
      this.certificate = await inspectOriginCertification(this.options.packageRoot ?? fileURLToPath(new URL('../../../', import.meta.url)), now);
    }
    const proof = this.certificate;
    const observations: Observation[] = [];
    for (const obligation of ['automation-authors', 'sender-census', 'development-trials'] as const) {
      const observation: Observation = { obligation, subject: 'release-certification', state: proof.state,
        reason: proof.state === 'ready' ? 'release-reviewed-build-and-evidence-verified' : proof.reason,
        observedAt: proof.verifiedAt, validUntil: proof.validUntil };
      if (proof.state === 'ready') {
        observation.certification = { buildDigest: proof.certificate.buildDigest, approvedAt: proof.certificate.approvedAt,
          expiresAt: proof.certificate.expiresAt, trials: proof.certificate.trials.map(({ kind, completedAt, evidenceDigest }) => ({ kind, completedAt, evidenceDigest })) };
        if (obligation === 'automation-authors') {
          try {
            const live = this.options.producerIds(), covered = new Set(proof.certificate.producers.map(producer => producer.producerId));
            // Producers are lazily registered; absence is not evidence of missing
            // wiring. Presence of an uncertified ID is never self-certification.
            if (live.length > 500 || live.some(id => !covered.has(id))) {
              observation.state = 'unknown'; observation.reason = 'active-producer-without-certified-author-binding';
            }
          } catch { observation.state = 'unknown'; observation.reason = 'automation-producer-inventory-unavailable'; }
        }
      }
      observations.push(observation);
    }
    const peerObservation = (subject: string, state: OriginActivationObservation['state'], reason: string): Observation =>
      ({ obligation: 'peers', subject, state, reason, observedAt: now, validUntil: now + 30_000 });
    let peers: string[];
    try {
      peers = [...new Set(this.options.activePeerIds())].filter(id => id !== this.options.selfMachineId);
      if (peers.length > 32 || peers.some(id => !id || id.length > 128)) throw new Error('peer inventory bound');
    } catch { observations.push(peerObservation('inventory', 'unknown', 'active-peer-registry-unavailable-or-over-bound')); return observations; }
    if (!peers.length) { observations.push(peerObservation('inventory', 'not-applicable', 'active-peer-registry-has-no-remote-writers')); return observations; }
    const transport = this.options.peerTransport();
    const results = await Promise.all(peers.map(async machineId => {
      if (!transport) return peerObservation(machineId, 'unknown', 'authenticated-origin-peer-transport-not-attached');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([transport(machineId,
          { type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'capabilities' }, 2000),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('peer capability timeout')), 2000); timeout.unref(); })]);
        const value = result.result as { ok?: boolean; protocol?: string; executionOwnerMachineId?: string; credentialOwner?: boolean; accountId?: string | null } | undefined;
        if (!this.options.activePeerIds().includes(machineId)) return peerObservation(machineId, 'unknown', 'origin-peer-authority-changed-during-observation');
        const compatible = result.ok && value?.ok === true && value.protocol === 'instar-telegram-origin-v1' &&
          value.executionOwnerMachineId === machineId && typeof value.credentialOwner === 'boolean' &&
          (value.credentialOwner ? typeof value.accountId === 'string' && value.accountId.length > 0 &&
            (this.options.accountId === null || value.accountId === this.options.accountId) : value.accountId === null);
        return peerObservation(machineId, compatible ? 'ready' : 'unknown', compatible ? 'authenticated-origin-capability-observed' : 'origin-peer-capability-incompatible-or-refused');
      } catch { return peerObservation(machineId, 'unknown', 'origin-peer-capability-unavailable'); }
      finally { if (timeout) clearTimeout(timeout); }
    }));
    observations.push(...results);
    return observations;
  }
}
