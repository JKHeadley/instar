import type { Request } from 'express';
import type { AppConversationService } from '../core/AppConversationService.js';
import { derivedEventId, isAppConversationKey } from '../core/appConversationText.js';
import { sha256Hex } from '../core/AppRecordSignatures.js';
import { requestIdAgeOk, requestIdTime } from '../core/MobileChatRequests.js';
import type { CreatedEvent } from '../core/AppConversationStore.js';
import { isOwnerPerson, type ResolvedPerson } from '../core/MobilePeople.js';
import { exactMessageReader } from './mobileExactMessageAuthority.js';
import { deviceAdmissionIdentity, principalOf, type MobilePairingService } from './mobilePairingRoutes.js';

type RemovalRejection = { ok: false; status: 400 | 403 | 404 | 503; error: string };
type RemovalScope = {
  ok: true;
  conversationKey: string;
  targetEventId: string;
  requestId: string;
  custodianMachineId: string;
  creationEventId: string;
  requestActor: string;
  removalEventId: string;
};
type RemovalAdmission = RemovalRejection | (RemovalScope & { targetMessageId: string; intentHash: string });

const unavailable = { ok: false, status: 404, error: 'message-removal-target-unavailable' } as const;
const wrongCustodian = { ok: false, status: 503, error: 'message-removal-custody-unavailable' } as const;

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

export function isAppRemovalConversationOwner(actor: ResolvedPerson, creation: CreatedEvent, machine: string): boolean {
  const owner = creation.ownerPerson;
  return owner ? owner.machineId === machine && owner.userId === actor.userId : isOwnerPerson(actor);
}

/** Establish current signed authority before looking up any request or target. */
export function resolveAppMessageRemovalScope(req: Request, pairing: MobilePairingService, service: AppConversationService): RemovalScope | RemovalRejection {
  const principal = principalOf(req);
  const signedIdentity = deviceAdmissionIdentity(req);
  if (principal.kind !== 'device' || !signedIdentity) return { ok: false, status: 403, error: 'operator-device-required' };
  const key = req.params.key;
  const body: unknown = req.body;
  if (!isAppConversationKey(key) || req.method !== 'POST' || req.originalUrl.includes('?') || !body || typeof body !== 'object'
    || Array.isArray(body) || Object.keys(body).length !== 3) {
    return { ok: false, status: 400, error: 'invalid-message-removal' };
  }
  const { custodianMachineId, eventId, requestId } = body as Record<string, unknown>;
  if (!isOpaqueId(custodianMachineId) || !isOpaqueId(eventId) || typeof requestId !== 'string' || requestIdTime(requestId) === null) {
    return { ok: false, status: 400, error: 'invalid-message-removal' };
  }

  const current = exactMessageReader(pairing, req);
  const actor = current();
  const machine = service.deps.machineId();
  const identityMachine = pairing.machineId();
  if (!actor) return unavailable;
  if (machine === 'local' || identityMachine !== machine || machine !== custodianMachineId) return wrongCustodian;
  if (!service.liveConversation(key) || !pairing.mayUse(actor, key, 'read')) return unavailable;
  const creation = service.store.getCreationRecord(key);
  if (!creation) return unavailable;

  if (!isAppRemovalConversationOwner(actor, creation, machine) || !pairing.mayUse(actor, key, 'delete')) return unavailable;
  if (creation.machineId !== machine || !service.serves(key)) return wrongCustodian;
  const ownerIdentity = actor.userId === null ? pairing.ownerIdentity() : null;
  if (actor.userId === null && ownerIdentity?.telegramOwnerId == null && ownerIdentity?.slackOwnerUserId == null) return unavailable;
  const actorScope = sha256Hex(JSON.stringify([
    actor.userId, principal.deviceId, signedIdentity.keyHash,
    ownerIdentity?.telegramOwnerId ?? null, ownerIdentity?.slackOwnerUserId ?? null,
  ]));
  // The caller must re-admit immediately before reservation if it awaits any work.
  return {
    ok: true,
    conversationKey: key,
    targetEventId: eventId,
    requestId,
    custodianMachineId,
    creationEventId: creation.eventId,
    requestActor: `app-message-removal:${actorScope}`,
    removalEventId: derivedEventId('removed', JSON.stringify([machine, actorScope, requestId])),
  };
}

export function removalIntentHash(scope: RemovalScope, targetMessageId: string): string {
  return sha256Hex(JSON.stringify(['app-message-removal', scope.custodianMachineId, scope.requestActor,
    scope.conversationKey, scope.targetEventId, targetMessageId]));
}

/** Resolve the exact currently visible event for a first attempt. */
export function resolveFreshRemovalTarget(req: Request, pairing: MobilePairingService, service: AppConversationService,
  scope: RemovalScope, now = Date.now(), options?: { preparedHistory: true }): RemovalAdmission {
  if (!requestIdAgeOk(scope.requestId, now)) return { ok: false, status: 400, error: 'request-id-too-old' };
  const current = exactMessageReader(pairing, req);
  const actor = current();
  if (!actor) return unavailable;
  let targets;
  try {
    targets = options?.preparedHistory
      ? service.store.exactRemovalAwareMessageCandidates(scope.conversationKey, scope.targetEventId, 'event',
        (row) => pairing.mayReadStored(actor, scope.conversationKey, row))
      : service.store.exactMessageCandidates(scope.conversationKey, scope.targetEventId, 'event');
  } catch {
    return unavailable; // @silent-fallback-ok — unreadable target shares the unavailable response
  }
  if (targets === null) return { ok: false, status: 503, error: 'message-removal-state-unavailable' };
  const [target] = targets;
  if (targets.length !== 1 || target?.eventId !== scope.targetEventId || !pairing.mayReadStored(actor, scope.conversationKey, target)) return unavailable;

  const rechecked = current();
  if (!rechecked || rechecked.userId !== actor.userId || rechecked.role !== actor.role) return unavailable;

  const latest = resolveAppMessageRemovalScope(req, pairing, service);
  if (!latest.ok) return latest;
  if (latest.requestActor !== scope.requestActor || latest.creationEventId !== scope.creationEventId) return unavailable;
  return { ...scope, targetMessageId: target.messageId, intentHash: removalIntentHash(scope, target.messageId) };
}

/** Resolve a fresh signed removal intent. Admission has no storage or projection effects. */
export function admitAppMessageRemoval(req: Request, pairing: MobilePairingService, service: AppConversationService): RemovalAdmission {
  const scope = resolveAppMessageRemovalScope(req, pairing, service);
  return scope.ok ? resolveFreshRemovalTarget(req, pairing, service, scope) : scope;
}
