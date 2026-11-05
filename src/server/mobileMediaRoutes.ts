/**
 * Media in app conversations — the device routes (docs/specs/mobile-native-chat-media.md §4.2,
 * §4.7, §4.8, §4.10). Device-signed only; behind `mobilePairing.native.media.enabled` (dev-agent
 * gated, read at boot; off ⇒ 503 `media-off`, except the purge of files already stored, so
 * switching off never strands a copy).
 *
 *   POST /mobile/media/uploads                      start   {conversationRef, size, sha256, …}
 *        conversationRef is app:<uuid>, telegram:<topicId> (a topic this machine knows) or a Slack
 *        conversation's canonical key held by THIS machine (§4.9: app → Telegram / Slack sends)
 *   PUT  /mobile/media/uploads/:uploadId/chunks/:i  one signed chunk (application/octet-stream)
 *   GET  /mobile/media/uploads/:uploadId            resume  {received, state, expiresAt}
 *   GET  /mobile/media/:sha256?ref=<conversationRef>[&machine=<holder>] download (Range honored locally,
 *        never executable); a Slack file on another machine streams whole for the owner's phone;
 *        ref is app:<uuid>, telegram:<topicId>, or a Slack conversation's canonical key
 *        slack:<team>:<channel>[:<thread>] held by THIS machine (§4.9 platform media)
 *   POST /mobile/media/purge                        permanently remove files {conversationKeys, requestId}
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router, type Request, type Response } from 'express';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { deviceMayUse } from './mobilePairingRoutes.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { requestIdAgeOk, requestIdTime } from '../core/MobileChatRequests.js';
import { CHUNK_BYTES, CONTROL_CHARS, MEDIA_KINDS, isInlineSafe, isSha256Hex, safeFileName, type AppAttachment, type MediaKind } from '../core/appMediaTypes.js';
import { canonicalConversationKey, isAppConversationKey, parseAppCanonicalKey } from '../core/appConversationText.js';
import type { UploadRow } from '../core/AppMediaStore.js';
import { PLATFORM_CONVERSATION_KEY_RE } from '../core/AppConversationStore.js';
import { slackMediaKeys } from '../core/appPlatformMedia.js';
import { HOLDER_MEDIA_HEADER, type HolderMedia } from './mobileMediaHolderProxy.js';

export interface MobileMediaRouteDeps {
  pairing: MobilePairingService;
  service: AppConversationService | null;
  /** Resolved at boot. */
  mediaEnabled: boolean;
  /**
   * Whether this machine holds the Slack conversation a download names (§4.9): the ref is the
   * current canonical key of a conversation this machine's registry minted. Absent = no Slack.
   */
  slackHeld?: (canonicalKey: string) => boolean;
  /**
   * Whether this machine knows the Telegram topic an upload names (§4.9: files sent from the app
   * into a Telegram topic upload under `telegram:<topicId>`). Absent = no Telegram here.
   */
  telegramTopicExists?: (topicId: number) => boolean;
  now?: () => number;
  /** This machine's id: what a Slack row's `machine` names when the file is here. */
  machineId?: () => string;
  /** Streams a file from the machine holding the conversation. Absent: 409 wrong-machine. */
  holderMedia?: HolderMedia;
  /** The owner-phone check taken from this request's own signature. Null for anyone else. */
  ownerAdmission?: (req: Request) => { isCurrent(): boolean } | null;
  /** Whether this request carries the agent's own bearer token: what a holder hop must present. */
  bearerOk?: (req: Request) => boolean;
}

type Principal = { kind: 'device'; deviceId: string } | { kind: 'token' };
const principalOf = (req: Request): Principal => ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
const hashOf = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');

export function createMobileMediaRouter(deps: MobileMediaRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const svc = deps.service;

  /** Device principal and a live media store. Returns the device id, or null (answered). */
  const gate = (req: Request, res: Response, opts: { evenWhenOff?: boolean } = {}): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc?.media || (!deps.mediaEnabled && !opts.evenWhenOff)) {
      res.status(503).json({ error: 'media-off', detail: 'Files in app conversations are turned off on this agent.' });
      return null;
    }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'operator-device-required' }); return null; }
    return p.deviceId;
  };

  const uploadTargetKnown = (ref: string): boolean => {
    const appKey = parseAppCanonicalKey(ref);
    if (appKey) return !!svc!.liveConversation(appKey);
    const tg = /^telegram:([1-9][0-9]{0,15})$/.exec(ref);
    if (tg) return deps.telegramTopicExists?.(Number(tg[1])) === true;
    return /^slack:/.test(ref) && ref.length <= 128 && deps.slackHeld?.(ref) === true;
  };

  const uploadView = (u: UploadRow) => ({ uploadId: u.uploadId, chunkSize: CHUNK_BYTES, received: svc!.media!.receivedChunks(u.uploadId), expiresAt: new Date(u.expiresAt).toISOString() });

  // ── Start ──
  router.post('/mobile/media/uploads', (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const media = svc!.media!;
    const requests = svc!.deps.requests;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.requestId !== 'string' || requestIdTime(b.requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const { conversationRef, size, sha256, declaredKind, declaredType, filename, requestId } = b;
    if (typeof conversationRef !== 'string' || typeof size !== 'number' || !Number.isSafeInteger(size) || !isSha256Hex(sha256)
      || typeof declaredKind !== 'string' || !MEDIA_KINDS.has(declaredKind) || typeof declaredType !== 'string' || declaredType.length < 1 || declaredType.length > 128
      || typeof filename !== 'string' || filename.length < 1 || filename.length > 255 || CONTROL_CHARS.test(declaredType) || CONTROL_CHARS.test(filename)) {
      res.status(400).json({ error: 'bad-upload', detail: 'conversationRef, size, sha256, declaredKind, declaredType and filename are required.' });
      return;
    }
    const hash = hashOf('upload-start', conversationRef, String(size), sha256, declaredKind, declaredType, filename);
    const prior = requests.lookup(deviceId, requestId as string, hash);
    if (prior.kind === 'done') {
      const id = typeof prior.body.uploadId === 'string' ? prior.body.uploadId : null;
      const u = id ? media.getUpload(id) : null;
      res.status(prior.status).json(u ? uploadView(u) : prior.body);
      return;
    }
    if (prior.kind === 'request-id-reused') { res.status(409).json({ error: 'payload-conflict', detail: 'This request id was already used for something else.' }); return; }
    if (prior.kind === 'in-progress') { res.status(202).json({ state: 'in-progress' }); return; }
    if (prior.kind === 'outcome-unknown') { res.status(409).json({ error: 'outcome-unknown', detail: 'Start the upload again with a new request id.' }); return; }
    if (!requestIdAgeOk(requestId as string, now())) { res.status(400).json({ error: 'request-id-too-old' }); return; }
    // The upload names the conversation its file will be sent into (§4.2, §4.9): a live native app
    // conversation, a Telegram topic this machine knows (`telegram:<topicId>`), or a Slack
    // conversation by the canonical key this machine's registry minted (the `conversationKey` of
    // its history read). The send route checks the same ref again, so an upload for one
    // conversation can never be sent into another.
    if (!uploadTargetKnown(conversationRef)) { res.status(404).json({ error: 'unknown-conversation', detail: 'That conversation does not exist or cannot take files yet.' }); return; }
    // People and roles §3.4: an MSP phone uploads only into conversations it may use.
    if (!deviceMayUse(deps.pairing, req, conversationRef)) { res.status(404).json({ error: 'unknown-conversation', detail: 'That conversation does not exist or cannot take files yet.' }); return; }
    const started = media.startUpload({ deviceId, conversationRef, size, sha256, declaredKind: declaredKind as MediaKind, declaredType, filename });
    if ('status' in started) { res.status(started.status).json({ error: started.error, detail: started.detail }); return; }
    const body = uploadView(started);
    try {
      const r = requests.reserve(deviceId, requestId as string, hash, 0);
      if (r.kind === 'reserved') requests.finish(deviceId, requestId as string, { status: 200, body });
    } catch (err) { // @silent-fallback-ok — reported through deps.reportDegradation
      // E2E-PAIRING: EXEMPT — comment-only annotation; these routes are covered by tests/e2e/mobile-native-media-alive.test.ts
      // The upload exists; a retry with a new id starts another, and this one expires by itself.
      svc!.deps.reportDegradation?.('AppMedia.requestStore', err instanceof Error ? err.message : String(err));
    }
    res.json(body);
  });

  const ownedUpload = (req: Request, res: Response, deviceId: string): UploadRow | null => {
    const u = svc!.media!.getUpload(String(req.params.uploadId).toLowerCase());
    if (!u || u.deviceId !== deviceId) { res.status(404).json({ error: 'upload-unknown', detail: 'This machine does not know that upload. Start again.' }); return null; }
    return u;
  };

  // ── Chunk ──
  router.put('/mobile/media/uploads/:uploadId/chunks/:index', async (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const media = svc!.media!;
    const u = ownedUpload(req, res, deviceId); if (!u) return;
    const indexText = String(req.params.index);
    if (!/^(0|[1-9][0-9]{0,5})$/.test(indexText)) { res.status(400).json({ error: 'bad-chunk-index' }); return; }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = media.putChunk(u, Number(indexText), bytes);
    if ('status' in r) { res.status(r.status).json({ error: r.error, detail: r.detail }); return; }
    if (r.lastChunk) {
      try { await media.finalizeUpload(u.uploadId); } catch (err) {
        // Recovery repeats it: the chunks are removed only after `complete`.
        svc!.deps.reportDegradation?.('AppMedia.finalize', err instanceof Error ? err.message : String(err));
        featureEvidence.record('mobilePairing.native.media', { kind: 'error', reason: 'upload could not be finalized', context: { uploadId: u.uploadId, deviceId, declaredKind: u.declaredKind, size: u.size } });
      }
      if (media.wasHashMismatch(u.uploadId)) {
        featureEvidence.record('mobilePairing.native.media', { kind: 'error', reason: 'corrupt upload: hash mismatch', context: { uploadId: u.uploadId, deviceId, declaredKind: u.declaredKind, size: u.size } });
        res.status(409).json({ error: 'hash-mismatch', detail: 'The file did not arrive intact. Start the upload again.' }); return;
      }
    }
    res.json({ ok: true, state: media.getUpload(u.uploadId)?.state ?? u.state });
  });

  // ── Resume ──
  router.get('/mobile/media/uploads/:uploadId', (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const media = svc!.media!;
    const u = ownedUpload(req, res, deviceId); if (!u) return;
    if (media.wasHashMismatch(u.uploadId)) { res.status(409).json({ error: 'hash-mismatch', detail: 'The file did not arrive intact. Start the upload again.' }); return; }
    if (u.state === 'expired' || (u.expiresAt <= now() && (u.state === 'open' || u.state === 'assembling' || u.state === 'complete'))) { res.status(410).json({ error: 'upload-expired', detail: 'This upload expired. Start it again.' }); return; }
    res.json({ received: media.receivedChunks(u.uploadId), state: u.state, expiresAt: new Date(u.expiresAt).toISOString() });
  });

  // ── Download ──
  router.get('/mobile/media/:sha256', async (req: Request, res: Response) => {
    // A hop from another machine, for the owner's phone there: the agent's own bearer, naming this
    // machine and a Slack conversation it holds. It is checked below like any download, and it
    // never goes on to a third machine, because a hop is not a device.
    const self = deps.machineId?.();
    const hop = principalOf(req).kind === 'token' && req.query.holderHop === '1' && deps.bearerOk?.(req) === true
      && self !== undefined && req.query.machine === self && typeof req.query.ref === 'string' && req.query.ref.startsWith('slack:');
    if (hop) {
      res.setHeader('Cache-Control', 'no-store');
      if (!deps.pairing.enabled() || !svc?.media || !deps.mediaEnabled) { res.status(503).json({ error: 'media-off', detail: 'Files in app conversations are turned off on this agent.' }); return; }
      if (req.headers.range !== undefined) { res.status(416).json({ error: 'range-unsupported' }); return; }
    } else if (!gate(req, res)) return;
    const media = svc!.media!;
    const sha = String(req.params.sha256);
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    const notFound = () => res.status(404).json({ error: 'not-found' });
    // A Slack file another machine holds: only the owner's phone, whole file, through the trusted
    // holder. The ref is that machine's to check, so nothing about it is looked up here.
    const named = req.query.machine;
    if (named !== undefined && !hop && (typeof named !== 'string' || !named)) { res.status(400).json({ error: 'bad-machine' }); return; }
    if (!hop && typeof named === 'string' && named !== self) {
      if (!isSha256Hex(sha) || !/^slack:/.test(ref) || ref.length > 128) { notFound(); return; }
      const owner = deps.ownerAdmission?.(req) ?? null;
      if (!owner) { res.status(403).json({ error: 'owner-only', detail: 'Only the agent\'s owner can open this file from the app.' }); return; }
      if (req.headers.range !== undefined) { res.setHeader('Accept-Ranges', 'none'); res.status(416).json({ error: 'range-unsupported', detail: 'A file on another machine downloads whole.' }); return; }
      if (!deps.holderMedia) { res.status(409).json({ error: 'wrong-machine', servedBy: self ?? null, detail: 'This file belongs to another machine.' }); return; }
      await deps.holderMedia({ sha256: sha, ref, machine: named, isCurrent: () => owner.isCurrent() }, res);
      return;
    }
    // The conversation is a live native app conversation (`app:<uuid>`), a Telegram topic
    // (`telegram:<topicId>`, §4.9), or a Slack conversation by its canonical key — only one this
    // machine's registry minted itself, since a Slack conversation is served by the machine that
    // lists it (§4.9). Platform files are referenced by `platform-media` events.
    const appKey = parseAppCanonicalKey(ref);
    const telegramKey = /^telegram:[1-9][0-9]{0,15}$/.test(ref) ? ref : null;
    const slackKey = /^slack:/.test(ref) && ref.length <= 128 && deps.slackHeld?.(ref) === true ? ref : null;
    const key = appKey ?? telegramKey ?? slackKey;
    if (!isSha256Hex(sha) || !key || (appKey && !svc!.liveConversation(appKey))) { notFound(); return; }
    // People and roles §3.4: an MSP phone downloads only from conversations it may use.
    if (!deviceMayUse(deps.pairing, req, appKey ?? key)) { notFound(); return; }
    // A Slack file may sit under the conversation's earlier placeholder-workspace key.
    let att: ReturnType<AppConversationService["store"]["mediaRefInConversation"]> = null;
    let refKey = key;
    for (const k of slackKey ? slackMediaKeys(slackKey) : [key]) {
      att = svc!.store.mediaRefInConversation(k, sha);
      if (att) { refKey = k; break; }
    }
    if (!att) { notFound(); return; }
    const blob = media.locateBlob(sha);
    // A good copy held now wins over a quarantined older copy of the same hash.
    if (!blob && media.isQuarantined(sha)) { res.status(410).json({ error: 'media-unavailable', detail: 'This file was damaged on this machine and has been set aside.' }); return; }
    if (!blob) {
      // §4.8/§4.12: start (or hurry) the copy from another machine and tell the app to poll.
      // 202 only when a copy can actually start: a mesh, a machine with disk room, an online peer
      // that could hold it, and not given up on. Otherwise an honest 404 with the reason.
      const rep = svc!.replicator;
      const can = rep.canFetch(sha);
      if (!can.ok) { res.status(404).json({ error: 'media-unavailable', detail: `This file is not on this machine: ${can.reason}.` }); return; }
      rep.want(sha);
      res.status(202).json({ state: 'fetching', retryAfterMs: 2000 });
      return;
    }
    const attachment: AppAttachment | undefined = svc!.store.getMediaAttachments(refKey, att.messageId)?.[att.idx];
    const mediaType = attachment?.mediaType ?? 'application/octet-stream';
    const inline = isInlineSafe(mediaType);
    let handle: fs.promises.FileHandle;
    try {
      const st = fs.lstatSync(blob);
      if (!st.isFile()) { notFound(); return; }
      handle = await fs.promises.open(blob, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (opened.ino !== st.ino || opened.dev !== st.dev) { await handle.close(); notFound(); return; }
    } catch { notFound(); return; } // @silent-fallback-ok — a blob that cannot be opened safely reads as absent
    const size = (await handle.stat()).size;
    res.setHeader('Content-Type', inline ? mediaType : 'application/octet-stream');
    if (!inline) res.setHeader('Content-Disposition', `attachment; filename="${safeFileName(attachment?.filename ?? 'file', mediaType)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Accept-Ranges', hop ? 'none' : 'bytes');
    if (hop) res.setHeader(HOLDER_MEDIA_HEADER, '1');
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) { await handle.close(); res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; }
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= size) { await handle.close(); res.status(416).setHeader('Content-Range', `bytes */${size}`).end(); return; }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Length', String(end - start + 1));
    const stream = handle.createReadStream({ start, end, autoClose: true });
    stream.on('error', () => { res.destroy(); });
    res.on('close', () => { stream.destroy(); });
    stream.pipe(res);
  });

  // ── Purge (§4.7): works with the feature off, so switching off never strands a copy ──
  router.post('/mobile/media/purge', (req: Request, res: Response) => {
    const deviceId = gate(req, res, { evenWhenOff: true }); if (!deviceId) return;
    const s = svc!;
    const requests = s.deps.requests;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const requestId = b.requestId;
    if (typeof requestId !== 'string' || requestIdTime(requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const keys = b.conversationKeys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 100 || !keys.every((k) => typeof k === 'string' && k.length <= 256)) { res.status(400).json({ error: 'bad-conversation-keys' }); return; }
    // People and roles §3.4: any key this phone may not use refuses the whole batch.
    if ((keys as string[]).some((k) => !deviceMayUse(deps.pairing, req, k))) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const hash = hashOf('purge', ...(keys as string[]));
    const prior = requests.lookup(deviceId, requestId, hash);
    if (prior.kind === 'done') { res.status(prior.status).json(prior.body); return; }
    if (prior.kind === 'request-id-reused') { res.status(409).json({ error: 'payload-conflict', detail: 'This request id was already used for something else.' }); return; }
    if (prior.kind === 'in-progress') { res.status(202).json({ state: 'in-progress' }); return; }
    if (prior.kind === 'outcome-unknown') { res.status(409).json({ error: 'outcome-unknown', detail: 'This may or may not have taken effect. Check the Storage screen.' }); return; }
    if (!requestIdAgeOk(requestId, now())) { res.status(400).json({ error: 'request-id-too-old' }); return; }
    const sets: Record<string, string[]> = {};
    for (const key of keys as string[]) {
      if (isAppConversationKey(key)) {
        if (s.liveConversation(key)) { res.status(409).json({ error: 'conversation-live', detail: 'Delete the conversation first, then remove its files.' }); return; }
        if (!s.store.getConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
      } else if (!PLATFORM_CONVERSATION_KEY_RE.test(key)) {
        res.status(404).json({ error: 'unknown-conversation' });
        return;
      }
      sets[canonicalConversationKey(key)] = s.store.mediaAttachmentIds(key);
    }
    // The exact set is recorded in the reservation first, so a crash midway resumes it (§4.7).
    let r: ReturnType<typeof requests.reserve>;
    try { r = requests.reserve(deviceId, requestId, hash, 0, { op: 'purge', conversationKey: '', sets: JSON.stringify(sets) }); } catch {
      res.status(503).json({ error: 'purge-unavailable', detail: 'The request could not be recorded, so nothing was removed. Try again.' });
      return;
    }
    if (r.kind !== 'reserved') { res.status(429).json({ error: 'too-many-requests' }); return; }
    const body = s.applyPurge(deviceId, requestId, sets);
    requests.finish(deviceId, requestId, { status: 200, body });
    res.json(body);
  });

  return router;
}
