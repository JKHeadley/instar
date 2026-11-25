import type { ManagedCodexStopStore, ManagedStopCallback } from './ManagedCodexStopStore.js';

export interface ManagedStopRequest {
  topicId: string;
  sessionId: string;
  turnId: string | undefined;
  lastAssistantMessage: string | undefined;
}

type VerifiedCallback = Omit<ManagedStopCallback, 'enabled' | 'sessionId'>;
type ManagedRouteDecision = { decision: 'allow' } | { decision: 'continue'; reasonText: string };

interface Dependencies {
  store: ManagedCodexStopStore;
  enabled: () => boolean;
  verify: (request: ManagedStopRequest) => VerifiedCallback | undefined;
}

/** The verification adapter resolves current custody and rollout facts locally. */
export function createManagedCodexStopRuntime(deps: Dependencies) {
  return (request: ManagedStopRequest): ManagedRouteDecision | undefined => {
    if (!deps.store.hasEnrollment(request.sessionId)) return undefined;

    const verified = deps.verify(request);
    if (!verified) return { decision: 'allow' };

    const outcome = deps.store.decide({
      ...verified,
      enabled: deps.enabled(),
      sessionId: request.sessionId,
    });
    return outcome.managed && outcome.directive
      ? { decision: 'continue', reasonText: 'Continue the admitted project action. ' + outcome.directive.marker }
      : { decision: 'allow' };
  };
}
