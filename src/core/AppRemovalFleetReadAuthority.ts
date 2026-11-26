import { MACHINE_ID_PATTERN } from './IdentityStore.js';
import { isAppConversationKey } from './appConversationText.js';
import type { AppRemovalReadCustody } from './AppRemovalReadCustody.js';

type LocalCustody = ReturnType<AppRemovalReadCustody['observe']>;
type Classification =
  | { kind: 'unknown' }
  | { kind: 'unenrolled'; conversationKey: string }
  | { kind: 'enrolled'; conversationKey: string; creationEventId: string; custodianMachineId: string };

interface ServingInstance {
  machineId: string;
  instanceId: string;
  generation: number;
  listener: string;
}

interface ServingLease extends ServingInstance {
  conversationKey: string;
  creationEventId: string;
}

interface ProtectedAttestation extends ServingInstance {
  artifactDigest: string;
  readProtocol: number;
  expiresAt: number;
}

type RouteDecision =
  | { kind: 'legacy' }
  | { kind: 'protected'; serving: Readonly<ServingLease> }
  | { kind: 'unavailable' };

const unavailable: RouteDecision = { kind: 'unavailable' };

/**
 * The inputs must come from verified control-plane sources. Classification is scoped to a
 * complete inventory, serving is the current fenced lease, and attestation is authenticated
 * independently of the application process. Never pass request fields or peer self-reports here.
 */
export function decideAppRemovalFleetRead(input: {
  conversationKey: string;
  classification: Classification;
  local: LocalCustody;
  serving: ServingLease | null;
  attestation: ProtectedAttestation | null;
  approvedArtifacts: ReadonlySet<string>;
  now: number;
}): RouteDecision {
  const { conversationKey, classification, local, serving, attestation, approvedArtifacts, now } = input;
  if (!Number.isFinite(now) || !isAppConversationKey(conversationKey) || classification.kind === 'unknown'
    || classification.conversationKey !== conversationKey || local.kind === 'unavailable') return unavailable;
  if (classification.kind === 'unenrolled') return local.kind === 'unrecorded' ? { kind: 'legacy' } : unavailable;
  if (local.kind === 'recorded' && (local.record.conversationKey !== conversationKey
    || local.record.creationEventId !== classification.creationEventId
    || local.record.custodianMachineId !== classification.custodianMachineId)) return unavailable;
  if (!serving || !attestation || !classification.creationEventId || !serving.instanceId || !serving.listener
    || serving.conversationKey !== conversationKey || serving.creationEventId !== classification.creationEventId
    || !Number.isSafeInteger(serving.generation) || serving.generation < 1
    || !MACHINE_ID_PATTERN.test(serving.machineId) || serving.machineId === 'local' || serving.machineId !== classification.custodianMachineId
    || attestation.machineId !== serving.machineId || attestation.instanceId !== serving.instanceId
    || attestation.generation !== serving.generation || attestation.listener !== serving.listener
    || attestation.readProtocol !== 1 || !approvedArtifacts.has(attestation.artifactDigest)
    || !Number.isFinite(attestation.expiresAt) || attestation.expiresAt <= now) return unavailable;
  return { kind: 'protected', serving: Object.freeze({ ...serving }) };
}
