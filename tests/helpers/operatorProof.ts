/**
 * Test helpers for trust-journey decision 4: wrap a trust owner so each raise carries a test proof
 * for exactly that change. Use the bare owner to assert that an unproven raise is refused.
 */
import { issueOperatorProofForTesting } from '../../src/core/TrustRaiseGuard.js';
import type { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import type { AutonomyProfileManager } from '../../src/core/AutonomyProfileManager.js';
import type { TrustRecovery } from '../../src/core/TrustRecovery.js';
import type { OperationMutability, TrustLevel } from '../../src/core/ExternalOperationGate.js';
import type { AutonomyProfileLevel } from '../../src/core/types.js';

export function proved(t: AdaptiveTrust) {
  return {
    grantTrust: (service: string, operation: OperationMutability, level: TrustLevel, statement: string) =>
      t.grantTrust(service, operation, level, statement,
        issueOperatorProofForTesting({ kind: 'trust-grant', service, operation, level })),
    grantServiceTrust: (service: string, level: TrustLevel, statement: string) =>
      t.grantServiceTrust(service, level, statement, Object.fromEntries(
        (['read', 'write', 'modify', 'delete'] as OperationMutability[]).map((operation) =>
          [operation, issueOperatorProofForTesting({ kind: 'trust-grant', service, operation, level })]))),
  };
}

export function provedProfile(m: AutonomyProfileManager) {
  return {
    setProfile: (to: AutonomyProfileLevel, reason: string) =>
      m.setProfile(to, reason, issueOperatorProofForTesting({ kind: 'autonomy-profile', from: m.getProfile(), to })),
  };
}

export function provedRecovery(r: TrustRecovery) {
  return {
    acceptRecovery: (incidentId: string) =>
      r.acceptRecovery(incidentId, issueOperatorProofForTesting({ kind: 'trust-recovery', incidentId })),
  };
}
