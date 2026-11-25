import { CameraAcceptanceJournalAdapter, type CameraJournalAdapterDeps } from './CameraAcceptanceJournalAdapter.js';
import type { CameraJournalScope } from './CameraAcceptanceJournalRecord.js';
import type { CameraOwnerEvidence } from './CameraOwnerAcceptance.js';
import { authorizeCameraVerifier } from './CameraVerifierAuth.js';

interface CameraAcceptanceRuntimeDeps {
  /** Return the configured pilot scope only while it is active on the serving holder. */
  activeScope(): CameraJournalScope | null;
  readonly journal: CameraJournalAdapterDeps;
  readonly authentication: Parameters<typeof authorizeCameraVerifier>[0];
  /** Read protected evidence for this issued request and authorized verifier. */
  loadEvidence(scope: CameraJournalScope, principal: string, requestId: string): Promise<CameraOwnerEvidence | null>;
}

function sameScope(scope: CameraJournalScope, active: CameraJournalScope | null): boolean {
  return !!active && active.conversationKey === scope.conversationKey && active.milestone === scope.milestone
    && active.leaseEpoch === scope.leaseEpoch && active.binding.physical === scope.binding.physical
    && active.binding.logical === scope.binding.logical && active.binding.node === scope.binding.node;
}

export function cameraAcceptanceRuntime(deps: CameraAcceptanceRuntimeDeps) {
  return {
    async resolveVerifier(credential: string) {
      const scope = deps.activeScope();
      if (!scope) return null;
      const authorization = await authorizeCameraVerifier(deps.authentication, credential);
      if (!authorization || !sameScope(scope, deps.activeScope())) return null;

      const { principal } = authorization;
      const journal = new CameraAcceptanceJournalAdapter(scope, deps.journal, {
        principal,
        allows: (requirement, epoch) => sameScope(scope, deps.activeScope()) && authorization.allows(requirement, epoch),
      });
      return {
        principal,
        journal,
        async loadEvidence(requestId: string) {
          if (!sameScope(scope, deps.activeScope()) || !authorization.isCurrent()) return null;
          const evidence = await deps.loadEvidence(scope, principal, requestId);
          return sameScope(scope, deps.activeScope()) && authorization.isCurrent() ? evidence : null;
        },
      };
    },
  };
}
