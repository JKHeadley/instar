import type { AppAttachmentOpenToken } from '../core/AppAttachmentOpenToken.js';
import { once } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import type { Request, Response, Router } from 'express';
import type { AppConversationService } from '../core/AppConversationService.js';
import { isSha256Hex } from '../core/appMediaTypes.js';
import { canonicalConversationKey, isAppConversationKey } from '../core/appConversationText.js';
import type { InstarConfig } from '../core/types.js';
import { mediaOffBody } from './mobileMediaOff.js';
import { setMobileMediaResponseHeaders } from './mobileMediaResponseHeaders.js';
import { mobileOwnerDeviceAdmission } from './mobileOwnerDeviceAdmission.js';
import { deviceMayUse, devicePersonOf, isMobileMediaEnabled, type MobilePairingService } from './mobilePairingRoutes.js';

const CONCURRENT_OPENS = 4;
const OPEN_DEADLINE_MS = 120_000;
const STREAM_BYTES = 64 * 1024;

interface Dependencies {
  config: InstarConfig;
  pairing: MobilePairingService;
  service: AppConversationService | null;
  mediaEnabled?: boolean;
}

interface RangeParts { first: number | null; last: number | null }

function parseRange(range: string): RangeParts | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  return { first, last };
}

function boundedRange(size: number, range: RangeParts | undefined): { start: number; end: number } | null {
  if (!range) return { start: 0, end: size - 1 };
  const start = range.first ?? Math.max(0, size - (range.last ?? 0));
  const end = range.first === null || range.last === null ? size - 1 : Math.min(size - 1, range.last);
  return start <= end && start < size ? { start, end } : null;
}

function canReply(res: Response): boolean {
  return !res.headersSent && !res.destroyed && !res.writableEnded;
}

function unavailable(res: Response): void {
  res.status(404).json({ error: 'attachment-unavailable' });
}

function retryOpen(res: Response): void {
  res.status(503).json({ error: 'attachment-open-retry' });
}

async function sendAttachment(handle: FileHandle, res: Response, start: number, end: number, signal: AbortSignal): Promise<void> {
  for (let offset = start; offset <= end;) {
    signal.throwIfAborted();
    // A response may still own the prior chunk, even when write() returned true.
    const chunk = Buffer.alloc(Math.min(STREAM_BYTES, end - offset + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    signal.throwIfAborted();
    if (bytesRead === 0) throw new Error('Attachment truncated while streaming');
    offset += bytesRead;
    if (!res.write(chunk.subarray(0, bytesRead))) await once(res, 'drain', { signal });
  }
  res.end();
  await finished(res, { signal, cleanup: true });
}

export function registerMobileAttachmentContentRoute(router: Router, deps: Dependencies, openTokens: AppAttachmentOpenToken): void {
  const { pairing, config, service } = deps;
  const enabled = () => config.mobilePairing?.native?.attachmentBrowse?.enabled === true;
  const mediaOn = () => deps.mediaEnabled === true && isMobileMediaEnabled(config) && !!service?.media;
  const active = new Set<string>();
  router.get('/mobile/chat/app/:key/attachments/:attachmentId/content', (req, res) => {
    void handleContent(req, res).catch(() => {
      // @silent-fallback-ok: no details leave a failed private file verification or send.
      if (canReply(res)) retryOpen(res);
      else if (!res.writableFinished && !res.destroyed) res.destroy();
    });
  });

  async function handleContent(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!enabled()) { res.status(404).json({ error: 'attachment-browse-off' }); return; }
    const owner = mobileOwnerDeviceAdmission(pairing, req);
    if (!owner) { res.status(403).json({ error: 'owner-device-required' }); return; }
    if (!mediaOn()) { res.status(503).json(mediaOffBody()); return; }
    const chat = String(req.params.key);
    const attachmentId = String(req.params.attachmentId);
    const conversationAvailable = () => isAppConversationKey(chat)
      && deviceMayUse(pairing, req, chat) && !!service?.liveConversation(chat);
    if (!service?.media || !conversationAvailable()) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const requireLiveAccess = () => {
      if (!owner.isCurrent()) { res.status(403).json({ error: 'owner-device-required' }); return false; }
      if (!enabled()) { res.status(404).json({ error: 'attachment-browse-off' }); return false; }
      if (!mediaOn()) { res.status(503).json(mediaOffBody()); return false; }
      if (!conversationAvailable()) { res.status(404).json({ error: 'unknown-conversation' }); return false; }
      return true;
    };
    if (!isSha256Hex(attachmentId)) { unavailable(res); return; }
    const scope = {
      deviceId: owner.deviceId, deviceKeyHash: owner.identity.keyHash,
      personId: owner.identity.userId, canonicalConversationKey: canonicalConversationKey(chat),
    };
    const queryStart = req.originalUrl.indexOf('?');
    const query = new URLSearchParams(queryStart < 0 ? '' : req.originalUrl.slice(queryStart + 1));
    const replica = query.getAll('replicaBinding');
    const tokens = query.getAll('openToken');
    if (replica.length !== 1 || !openTokens.matchesReplica(scope, replica[0])) {
      res.status(409).json({ error: 'attachment-replica-changed' }); return;
    }
    const matchesOccurrence = tokens.length === 1 ? openTokens.openOccurrence(scope, tokens[0]) : null;
    if (!matchesOccurrence || [...query.keys()].some(key => key !== 'replicaBinding' && key !== 'openToken')) {
      res.status(400).json({ error: 'invalid-attachment-open-token' }); return;
    }
    const rawRange = req.headers.range;
    const range = typeof rawRange === 'string' ? parseRange(rawRange) : undefined;
    if (range === null || (rawRange !== undefined && typeof rawRange !== 'string')) { res.status(416).json({ error: 'range-unsupported' }); return; }
    if (active.has(owner.deviceId) || active.size >= CONCURRENT_OPENS) {
      res.status(429).json({ error: 'attachment-open-busy' }); return;
    }

    if (!canReply(res)) return;
    const abort = new AbortController();
    let publishing = false;
    let handle: FileHandle | null = null;
    const onClose = () => abort.abort();
    const onFinish = () => { if (!publishing) abort.abort(); };
    active.add(owner.deviceId);
    res.once('close', onClose);
    res.once('finish', onFinish);
    const timer = setTimeout(() => {
      abort.abort();
      if (canReply(res)) retryOpen(res);
      else if (publishing && !res.writableFinished && !res.destroyed) res.destroy();
    }, OPEN_DEADLINE_MS);
    timer.unref();

    try {
      const media = service.media;
      const { store } = service;
      const revision = store.attachmentPublicationRevision(chat);
      const ready = await store.attachmentIndexReady(chat);
      if (abort.signal.aborted || !canReply(res) || !requireLiveAccess()) return;
      if (!ready || revision !== store.attachmentPublicationRevision(chat)) { retryOpen(res); return; }
      const ref = store.mediaRef(attachmentId);
      const canonicalKey = canonicalConversationKey(chat);
      if (!ref || ref.canonicalKey !== canonicalKey || ref.purged || ref.tombstoned) {
        unavailable(res); return;
      }
      const location = store.attachmentMessageIndex(chat, ref.messageId);
      if (!location) { unavailable(res); return; }
      const referenceIsCurrent = () => JSON.stringify(store.mediaRef(attachmentId)) === JSON.stringify(ref)
        && JSON.stringify(store.attachmentMessageIndex(chat, ref.messageId)) === JSON.stringify(location);
      const event = await store.readExactAttachmentEvent(chat, location, abort.signal);
      if (abort.signal.aborted || !canReply(res) || !requireLiveAccess()) return;
      const person = devicePersonOf(req);
      const attachment = event?.kind === 'media-message'
        && event.messageId === ref.messageId && pairing.mayReadStored(person, chat, event)
        ? event.attachments[ref.idx] : undefined;
      if (!attachment || !event || !matchesOccurrence({ eventId: event.eventId, messageId: ref.messageId, ...attachment })
        || attachment.attachmentId !== attachmentId || attachment.index !== ref.idx
        || attachment.sha256 !== ref.sha256 || attachment.size !== ref.size || !referenceIsCurrent()) {
        unavailable(res); return;
      }
      const bounds = boundedRange(attachment.size, range);
      const verified = await media.openExactLocalAttachment(attachment.sha256, attachment.size, abort.signal);
      handle = verified?.handle ?? null;
      if (abort.signal.aborted || !canReply(res) || !requireLiveAccess()) return;
      if (!verified) { unavailable(res); return; }
      const confirmedEvent = await store.readExactAttachmentEvent(chat, location, abort.signal);
      abort.signal.throwIfAborted();
      const descriptorCurrent = await verified.isCurrent();
      const readyToPublish = await store.attachmentIndexReady(chat);
      if (abort.signal.aborted || !canReply(res) || !requireLiveAccess()) return;
      if (!descriptorCurrent || confirmedEvent?.kind !== 'media-message' || confirmedEvent.messageId !== ref.messageId
        || !pairing.mayReadStored(person, chat, confirmedEvent)
        || JSON.stringify(confirmedEvent.attachments[ref.idx]) !== JSON.stringify(attachment)
        || !referenceIsCurrent()) {
        unavailable(res); return;
      }

      if (!readyToPublish || revision !== store.attachmentPublicationRevision(chat)) { retryOpen(res); return; }
      if (!bounds) {
        res.status(416).setHeader('Content-Range', `bytes */${attachment.size}`).end(); return;
      }
      const { start, end } = bounds;
      setMobileMediaResponseHeaders(res, attachment.mediaType, attachment.filename, true);
      if (range) res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${attachment.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      publishing = true;
      res.flushHeaders();
      await sendAttachment(verified.handle, res, start, end, abort.signal);
    } finally {
      try { if (handle) await handle.close(); } finally {
        clearTimeout(timer);
        res.off('close', onClose);
        res.off('finish', onFinish);
        active.delete(owner.deviceId);
      }
    }
  }
}
