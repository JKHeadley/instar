import type { AppAttachmentOpenToken } from '../core/AppAttachmentOpenToken.js';
import type { Request, Response, Router } from 'express';
import { AppAttachmentPageChanged, browseAppAttachments } from '../core/AppAttachmentBrowse.js';
import { AppAttachmentCursor } from '../core/AppAttachmentCursor.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { MEDIA_KINDS, type MediaKind } from '../core/appMediaTypes.js';
import { canonicalConversationKey, isAppConversationKey } from '../core/appConversationText.js';
import type { InstarConfig } from '../core/types.js';
import { mediaOffBody } from './mobileMediaOff.js';
import { mobileOwnerDeviceAdmission } from './mobileOwnerDeviceAdmission.js';
import { deviceMayUse, devicePersonOf, isMobileMediaEnabled, type MobilePairingService } from './mobilePairingRoutes.js';

const MAX_CONCURRENT_PAGES = 4;
const BROWSE_DEADLINE_MS = 2_000;

interface Dependencies {
  config: InstarConfig;
  pairing: MobilePairingService;
  service: AppConversationService | null;
  mediaEnabled?: boolean;
}

function browseQuery(req: Request): { kind: MediaKind; cursor: string | null } | null {
  const raw = req.originalUrl;
  const queryStart = raw.indexOf('?');
  const query = new URLSearchParams(queryStart < 0 ? '' : raw.slice(queryStart + 1));
  for (const name of query.keys()) if (name !== 'kind' && name !== 'cursor') return null;
  const kinds = query.getAll('kind');
  const cursors = query.getAll('cursor');
  if (kinds.length !== 1 || !MEDIA_KINDS.has(kinds[0]) || cursors.length > 1) return null;
  return { kind: kinds[0] as MediaKind, cursor: cursors[0] ?? null };
}

function canReply(res: Response): boolean {
  return !res.headersSent && !res.destroyed && !res.writableEnded;
}

export function registerMobileAttachmentBrowseRoute(router: Router, deps: Dependencies, openTokens: AppAttachmentOpenToken): void {
  const { pairing, service, config } = deps;
  const enabled = () => config.mobilePairing?.native?.attachmentBrowse?.enabled === true;
  const mediaOn = () => deps.mediaEnabled === true && isMobileMediaEnabled(config);
  let cursorCodec: AppAttachmentCursor | undefined;
  const active = new Set<string>();

  router.get('/mobile/chat/app/:key/attachments', (req, res) => {
    // Express 4 does not forward a rejected async handler into its error middleware.
    void handleBrowse(req, res).catch(() => {
      // @silent-fallback-ok: a failed read discloses no private metadata or cursor.
      if (canReply(res)) res.status(503).json({ error: 'attachment-browse-unavailable' });
    });
  });

  async function handleBrowse(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!enabled()) { res.status(404).json({ error: 'attachment-browse-off' }); return; }
    const owner = mobileOwnerDeviceAdmission(pairing, req);
    if (!owner) { res.status(403).json({ error: 'owner-device-required' }); return; }
    if (!mediaOn()) { res.status(503).json(mediaOffBody()); return; }
    const params = browseQuery(req);
    if (!params) { res.status(400).json({ error: 'invalid-attachment-query' }); return; }
    const conversationKey = String(req.params.key);
    const conversationAvailable = () => isAppConversationKey(conversationKey)
      && deviceMayUse(pairing, req, conversationKey) && !!service?.liveConversation(conversationKey);
    if (!service || !conversationAvailable()) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const { kind, cursor } = params;
    const scope = {
      deviceId: owner.deviceId,
      deviceKeyHash: owner.identity.keyHash,
      personId: owner.identity.userId,
      canonicalConversationKey: canonicalConversationKey(conversationKey),
      kind,
    };
    const codec = (cursorCodec ??= new AppAttachmentCursor());
    const before = cursor === null ? null : codec.open(scope, cursor);
    if (cursor !== null && !before) { res.status(400).json({ error: 'invalid-cursor' }); return; }
    if (active.has(owner.deviceId) || active.size >= MAX_CONCURRENT_PAGES) {
      res.status(429).json({ error: 'attachment-browse-busy' }); return;
    }

    if (!canReply(res)) return;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    active.add(owner.deviceId);
    res.once('close', onClose);
    const deadline = setTimeout(() => {
      abort.abort();
      if (canReply(res)) res.status(503).json({ error: 'attachment-browse-unavailable' });
    }, BROWSE_DEADLINE_MS);
    deadline.unref();

    const canPublish = () => {
      if (abort.signal.aborted || !canReply(res)) return false;
      if (!owner.isCurrent()) { res.status(403).json({ error: 'owner-device-required' }); return false; }
      if (!enabled()) { res.status(404).json({ error: 'attachment-browse-off' }); return false; }
      if (!mediaOn()) { res.status(503).json(mediaOffBody()); return false; }
      if (!conversationAvailable()) { res.status(404).json({ error: 'unknown-conversation' }); return false; }
      return true;
    };

    try {
      const person = devicePersonOf(req);
      const revision = service.store.attachmentPublicationRevision(conversationKey);
      const ready = await service.store.attachmentIndexReady(conversationKey);
      if (!canPublish()) return;
      if (!ready || revision !== service.store.attachmentPublicationRevision(conversationKey)) {
        res.status(503).json({ error: 'attachment-index-pending' }); return;
      }
      const page = await browseAppAttachments({
        store: service.store, conversationKey, kind, before, signal: abort.signal,
        canRead: (event) => (event.kind === 'message' || event.kind === 'media-message')
          && pairing.mayReadStored(person, conversationKey, event),
        sealCursor: (key) => codec.seal(scope, key),
        indexHasGap: service.store.attachmentIndexHasGap(conversationKey),
        openBinding: {
          replica: openTokens.sealReplica(scope),
          seal: (event, attachment) => openTokens.sealOccurrence(scope, {
            eventId: event.eventId, messageId: event.messageId, ...attachment,
          }),
        },
      }).catch(error => {
        if (error instanceof AppAttachmentPageChanged) return null;
        throw error;
      });
      if (!canPublish()) return;
      if (!page || revision !== service.store.attachmentPublicationRevision(conversationKey)) {
        res.status(503).json({ error: 'attachment-page-changed' }); return;
      }
      res.json(page);
    } finally {
      clearTimeout(deadline);
      res.off('close', onClose);
      // A timed-out request keeps its slot until its in-flight descriptor has closed.
      active.delete(owner.deviceId);
    }
  }
}
