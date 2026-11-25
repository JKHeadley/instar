import type { Request } from 'express';
import type { AppConversationService } from '../core/AppConversationService.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import type { createRemovalSyncCursorCodec } from './mobileAppRemovalSyncCursor.js';
import { exactMessageReader } from './mobileExactMessageAuthority.js';
import { resolveOwnerRemovalSyncAuthority } from './mobileAppRemovalSyncAuthority.js';

const MAX_PRIVATE_DISPLAY_MS = 30_000;
const unavailable = { status: 503, body: { error: 'message-removal-sync-unavailable' } } as const;

/** Private signed page executor. Production route, cursor delivery and cache renewal remain unmounted. */
export async function executeOwnerRemovalSync(req: Request, pairing: MobilePairingService,
  service: AppConversationService, evidence: Parameters<typeof resolveOwnerRemovalSyncAuthority>[3],
  codec: ReturnType<typeof createRemovalSyncCursorCodec>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const initial = resolveOwnerRemovalSyncAuthority(req, pairing, service, evidence);
    if (!initial.ok) return { status: initial.status, body: { error: initial.error } };
    const { conversationKey } = initial.authority;
    const epoch = codec.epochFor(initial.authority);
    if (Object.keys(req.query).some((name) => name !== 'cursor' && name !== 'limit')) {
      return { status: 400, body: { error: 'invalid-message-removal-sync-request' } };
    }
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(rawLimit))) {
      return { status: 400, body: { error: 'invalid-message-removal-sync-request' } };
    }
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    const read = req.query.cursor === undefined ? { kind: 'resume', sequence: 0 } as const : codec.read(initial.authority, req.query.cursor);
    if (read.kind === 'invalid') return { status: 400, body: { error: 'invalid-message-removal-cursor' } };
    if (read.kind === 'reset') return { status: 409, body: { error: 'message-removal-sync-reset', epoch } };

    await service.store.prepareRemovalHistory(conversationKey);
    const admitted = resolveOwnerRemovalSyncAuthority(req, pairing, service, evidence);
    if (!admitted.ok) return { status: admitted.status, body: { error: admitted.error } };
    if (codec.epochFor(admitted.authority) !== epoch) return { status: 409, body: { error: 'message-removal-sync-reset' } };

    const reader = exactMessageReader(pairing, req)();
    if (reader?.role !== 'owner') return { status: 404, body: { error: 'unknown-conversation' } };
    const page = service.store.syncRemovalAwareMessageChangesAfter(conversationKey, read.sequence, limit,
      (row) => pairing.mayReadStored(reader, conversationKey, row) ? 'allow' : 'unknown');
    if (!page) return unavailable;
    const final = resolveOwnerRemovalSyncAuthority(req, pairing, service, evidence);
    if (!final.ok) return { status: final.status, body: { error: final.error } };
    if (codec.epochFor(final.authority) !== epoch) return { status: 409, body: { error: 'message-removal-sync-reset' } };
    if (!service.store.hasPreparedRemovalHistory(conversationKey, page.proof)) return unavailable;

    const changes = page.changes.map((change) => {
      if (change.kind === 'message-removed') return change;
      const { eventId, messageId, text, at, role } = change.row;
      return { kind: 'message', row: { eventId, messageId, text, at, role } };
    });
    const caughtUp = !page.blocked && page.sequence === page.highWater;
    return { status: 200, body: {
      conversationKey, epoch, changes, blocked: page.blocked, cursor: codec.issue(final.authority, page.sequence),
      highWater: codec.highWaterFor(final.authority, page.highWater), caughtUp,
      ...(caughtUp ? { displayForMs: MAX_PRIVATE_DISPLAY_MS } : {}),
    } };
  } catch {
    return unavailable; // @silent-fallback-ok — an incomplete projection cannot issue a continuation
  }
}

/** Private first history page. A history read cannot renew the sync display deadline. */
export async function executeOwnerRemovalHistory(req: Request, pairing: MobilePairingService,
  service: AppConversationService, evidence: Parameters<typeof resolveOwnerRemovalSyncAuthority>[3],
  codec: ReturnType<typeof createRemovalSyncCursorCodec>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const initial = resolveOwnerRemovalSyncAuthority(req, pairing, service, evidence);
    if (!initial.ok) return { status: initial.status, body: { error: initial.error } };
    if (Object.keys(req.query).length) return { status: 400, body: { error: 'invalid-message-removal-history-request' } };

    const { conversationKey } = initial.authority;
    const epoch = codec.epochFor(initial.authority);
    await service.store.prepareRemovalHistory(conversationKey);
    const admitted = resolveOwnerRemovalSyncAuthority(req, pairing, service, evidence);
    if (!admitted.ok) return { status: admitted.status, body: { error: admitted.error } };
    if (codec.epochFor(admitted.authority) !== epoch) return { status: 409, body: { error: 'message-removal-sync-reset' } };

    const reader = exactMessageReader(pairing, req)();
    if (reader?.role !== 'owner') return { status: 404, body: { error: 'unknown-conversation' } };
    const page = service.store.readPreparedRemovalHistory(conversationKey, null, 100);
    if (!page || page.messages.some((row) => !pairing.mayReadStored(reader, conversationKey, row))) return unavailable;
    const final = resolveOwnerRemovalSyncAuthority(req, pairing, service, evidence);
    if (!final.ok) return { status: final.status, body: { error: final.error } };
    if (codec.epochFor(final.authority) !== epoch) return { status: 409, body: { error: 'message-removal-sync-reset' } };
    if (!service.store.hasPreparedRemovalHistory(conversationKey, page.proof)) return unavailable;

    return { status: 200, body: {
      conversationKey, epoch, hasOlder: page.nextBefore !== null,
      messages: page.messages.map(({ eventId, messageId, text, at, role }) => ({ eventId, messageId, text, at, role })),
    } };
  } catch {
    return unavailable; // @silent-fallback-ok — a protected history read has no unfiltered fallback
  }
}
