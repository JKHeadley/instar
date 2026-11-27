import type { ManagedStopEnrollment } from './ManagedCodexStopDecision.js';
import type { ManagedCodexStopStore, ManagedStopVerifiedFacts } from './ManagedCodexStopStore.js';

export interface ManagedStopRequest {
  topicId: string;
  sessionId: string;
  turnId: string | undefined;
  lastAssistantMessage: string | undefined;
}

type ManagedRouteDecision = { decision: 'allow' } | { decision: 'continue'; reasonText: string };

interface Dependencies {
  store: ManagedCodexStopStore;
  enabled: () => boolean;
  verify: (request: ManagedStopRequest, enrollment: ManagedStopEnrollment) => ManagedStopVerifiedFacts | undefined;
}

/** The verification adapter resolves current custody and rollout facts locally. */
export function createManagedCodexStopRuntime(deps: Dependencies) {
  return (request: ManagedStopRequest): ManagedRouteDecision | undefined => {
    const outcome = deps.store.decideVerified(request.sessionId, deps.enabled(),
      enrollment => deps.verify(request, enrollment));
    if (!outcome.managed) return undefined;
    return outcome.directive
      ? { decision: 'continue', reasonText: 'Continue the admitted project action. ' + outcome.directive.marker }
      : { decision: 'allow' };
  };
}
