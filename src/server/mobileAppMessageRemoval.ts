import type { Request } from 'express';
import type { AppConversationService } from '../core/AppConversationService.js';
import { exactMessageReader } from './mobileExactMessageAuthority.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { removalIntentHash, resolveAppMessageRemovalScope, resolveFreshRemovalTarget } from './mobileAppMessageRemovalAdmission.js';

const unknown = { status: 409, body: { error: 'outcome-unknown' } } as const;
const conflict = { status: 409, body: { error: 'payload-conflict' } } as const;

/** Private signed runtime checkpoint. Mount only with authoritative read and sync visibility. */
export function executeAppMessageRemoval(req: Request, pairing: MobilePairingService, service: AppConversationService,
  now = Date.now()): { status: number; body: Record<string, unknown> } {
  try {
    const scope = resolveAppMessageRemovalScope(req, pairing, service);
    if (!scope.ok) return { status: scope.status, body: { error: scope.error } };
    const { conversationKey, targetEventId, custodianMachineId, requestId, requestActor, removalEventId } = scope;
    const requests = service.deps.requests;
    const receipt = { eventId: targetEventId, removalEventId };
    const confirm = (targetMessageId: string): boolean =>
      service.store.messageRemoval(conversationKey, targetEventId, targetMessageId, removalEventId)?.eventId === removalEventId;
    const acknowledge = () => {
      requests.finish(requestActor, requestId, { status: 200, body: receipt });
      return { status: 200, body: receipt };
    };
    const prior = requests.get(requestActor, requestId);
    if (prior) {
      if (prior.keepUntil < now) return { status: 400, body: { error: 'request-id-too-old' } };
      const targetMessageId = prior.extra?.targetMessageId;
      if (!targetMessageId || prior.extra?.op !== 'app-message-removal') return unknown;
      const previous = requests.lookup(requestActor, requestId, removalIntentHash(scope, targetMessageId));
      if (previous.kind === 'none') return { status: 400, body: { error: 'request-id-too-old' } };
      if (previous.kind === 'request-id-reused') return conflict;
      const reader = exactMessageReader(pairing, req)();
      const rows = service.store.exactMessageCandidates(conversationKey, targetEventId, 'event');
      if (!reader || rows.length !== 1 || rows[0].messageId !== targetMessageId
        || !pairing.mayReadStored(reader, conversationKey, rows[0])) {
        return { status: 404, body: { error: 'message-removal-target-unavailable' } };
      }
      if (previous.kind === 'in-progress') return { status: 202, body: { state: 'in-progress' } };
      if (!confirm(targetMessageId)) return unknown;
      return previous.kind === 'done' ? { status: 200, body: receipt } : acknowledge();
    }
    const admitted = resolveFreshRemovalTarget(req, pairing, service, scope, now);
    if (!admitted.ok) return { status: admitted.status, body: { error: admitted.error } };
    const { targetMessageId, intentHash } = admitted;
    const absence = service.store.messageRemoval(conversationKey, targetEventId, targetMessageId);
    if (!absence) return { status: 503, body: { error: 'message-removal-state-unavailable' } };
    if (absence.eventId !== null) return { status: 404, body: { error: 'message-removal-target-unavailable' } };
    const reservation = requests.reserve(requestActor, requestId, intentHash, 0, {
      op: 'app-message-removal', conversationKey, targetEventId, targetMessageId, removalEventId,
    });
    if (reservation.kind === 'full') return { status: 429, body: { error: 'too-many-requests' } };
    if (reservation.kind !== 'reserved') return reservation.kind === 'request-id-reused' ? conflict : unknown;
    try {
      service.store.append({ kind: 'message-removed', eventId: removalEventId, conversationKey, targetEventId,
        targetMessageId, machineId: custodianMachineId, at: new Date(now).toISOString() });
      if (confirm(targetMessageId)) return acknowledge();
    } catch { /* @silent-fallback-ok — a reserved intent stays unknown until exact journal proof exists */ }
    requests.markUnknown(requestActor, requestId);
    return unknown;
  } catch {
    return { status: 503, body: { error: 'message-removal-state-unavailable' } }; // @silent-fallback-ok — no speculative receipt
  }
}
