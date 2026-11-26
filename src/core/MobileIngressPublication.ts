import { createHash } from 'node:crypto';
import type { FencedPublicationStore, PublicationClaimResult, PublicationGeneration } from './FencedPublicationStore.js';

interface AuthenticatedMobileIngressIntent {
  agentId: string;
  deviceId: string;
  requestId: string;
  admittedDigest: string;
}

/**
 * Namespace binding for the authenticated receiver. The digest is derived
 * from verified admission upstream. Returning existing never authorizes a
 * second dispatch, including after lease handover.
 */
export function claimMobileIngress(
  store: FencedPublicationStore,
  generation: PublicationGeneration,
  intent: AuthenticatedMobileIngressIntent,
): PublicationClaimResult {
  const { agentId, deviceId, requestId, admittedDigest } = intent;
  if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 128 ||
      typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 128) return { kind: 'conflict' };
  const operationKey = createHash('sha256')
    .update('instar-mobile-ingress-claim-v1\n')
    .update(JSON.stringify([deviceId, requestId]))
    .digest('hex');
  return store.claim({ agentId, namespace: 'mobile-ingress' }, generation, operationKey, admittedDigest);
}
