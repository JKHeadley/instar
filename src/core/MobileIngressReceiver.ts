import { createHash } from 'node:crypto';
import type { FencedPublicationStore, PublicationClaimResult, PublicationGeneration } from './FencedPublicationStore.js';
import type { MobileChatHandoverEnvelope } from './MobileChatHandoverEnvelope.js';
import { mobileIngressOperationKey } from './MobileIngressPublication.js';
import { canonicalJson } from './appMediaTypes.js';

interface ReceiverAuth {
  /** Authenticated by the transport, never copied from the request body. */
  machineId: string;
}

interface MobileIngressReceiverDeps {
  store: FencedPublicationStore;
  /** The tenant selected by the receiver's enrollment. */
  agentId: string;
  isIngress(machineId: string): boolean;
  isHolder(machineId: string): boolean;
  verifyEnvelope(envelope: MobileChatHandoverEnvelope): boolean;
  deviceStillAllowed(envelope: MobileChatHandoverEnvelope): boolean;
}

function admittedDigest(envelope: MobileChatHandoverEnvelope): string {
  const event = envelope.event;
  return createHash('sha256').update(canonicalJson({
    topicId: envelope.topicId, payloadHash: envelope.payloadHash,
    bodyHash: event.origin?.bodySha256, text: event.text,
    senderName: event.senderName ?? null, senderRole: event.senderRole ?? null,
    senderPerson: event.senderPerson ?? null,
    attachments: event.kind === 'media-message' ? event.attachments : [],
  })).digest('hex');
}

/** Unwired receiver composition. It has no dispatch callback or transport. */
export function createMobileIngressReceiver(deps: MobileIngressReceiverDeps) {
  const scope = { agentId: deps.agentId, namespace: 'mobile-ingress' } as const;
  return {
    stage(auth: ReceiverAuth, envelope: MobileChatHandoverEnvelope) {
      if (!deps.isIngress(auth.machineId) || envelope?.admission?.machineId !== auth.machineId ||
          !deps.verifyEnvelope(envelope)) return 'unauthorized' as const;
      const operation = mobileIngressOperationKey(envelope.deviceId, envelope.requestId);
      return deps.store.stage(scope, operation, admittedDigest(envelope), JSON.stringify(envelope));
    },

    claim(auth: ReceiverAuth, generation: PublicationGeneration, deviceId: string, requestId: string):
      PublicationClaimResult | { kind: 'unauthorized' } {
      if (auth.machineId !== generation.holder || !deps.isHolder(auth.machineId)) return { kind: 'unauthorized' };
      const operation = mobileIngressOperationKey(deviceId, requestId);
      const staged = deps.store.getStage(scope, operation);
      if (!staged) return { kind: 'unavailable' };
      let envelope: MobileChatHandoverEnvelope;
      try {
        envelope = JSON.parse(staged.payload) as MobileChatHandoverEnvelope;
        if (envelope?.deviceId !== deviceId || envelope?.requestId !== requestId ||
            !deps.verifyEnvelope(envelope) || admittedDigest(envelope) !== staged.digest ||
            !deps.deviceStillAllowed(envelope)) return { kind: 'unauthorized' };
      } catch {
        return { kind: 'unavailable' }; // @silent-fallback-ok — unreadable custody cannot authorize dispatch
      }
      return deps.store.claim(scope, generation, operation, staged.digest);
    },
  };
}
