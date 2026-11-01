/**
 * Native app conversations — the device routes (docs/specs/mobile-native-conversations.md,
 * increment 1). Writes are device-signed only (a Bearer request gets 403); the three reads also
 * accept the agent's own Bearer token (so the agent can list and read). All behind
 * `mobilePairing.native.enabled` (dev-agent gated, read at boot; off ⇒ every route here 503s and
 * the Telegram chat route is unchanged).
 *
 *   POST   /mobile/conversations                     create   {title, requestId}
 *   GET    /mobile/conversations?cursor=&limit=      list (app conversations + Telegram topics)
 *   PATCH  /mobile/conversations/:key                rename   {title, requestId}
 *   DELETE /mobile/conversations/:key                delete   {requestId}
 *   POST   /mobile/chat/app/:key                     send     {text, requestId}
 *   GET    /mobile/chat/app/:key/messages?before=    browse (backwards, (at,eventId) order)
 *   GET    /mobile/chat/app/:key/events?cursor=      sync (this machine's ingest order)
 *
 * Every mutation is idempotent through MobileChatRequestStore keyed on (deviceId, requestId)
 * with an operation-specific payload hash. The send keeps the order of §4.2: authenticate →
 * look up → emergency stop → preflight → reserve → persist (fsync) → pause intercept → dispatch
 * → delivery event → done; lookups answer from the CURRENT delivery state.
 *
 * Origin: every app message is stored with the fields of its device signature (§4.6) so a later
 * increment can re-check it. Increment 1 stores no machine receipt and computes no verdict, so
 * history returns `originVerified: "unknown"` for an app message (never "verified") and "none"
 * for a message with no origin.
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { InstarConfig } from '../core/types.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { isMobileChatEnabled } from './mobilePairingRoutes.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { requestIdAgeOk, requestIdTime, type ChatLookup } from '../core/MobileChatRequests.js';
import {
  cleanConversationTitle, derivedEventId, isAppConversationKey, newAppConversationKey, removeAuthorityTokens,
} from '../core/appConversationText.js';
import type { BrowsedMessage, DeviceSignedOrigin, MessageEvent } from '../core/AppConversationStore.js';
import { detectOutboundCredential } from '../messaging/outbound-credential-guard.js';
import { isExactStopMessage } from '../core/MessageSentinel.js';
import { cleanText } from '../core/MobilePairing.js';

export interface MobileConversationRouteDeps {
  config: InstarConfig;
  pairing: MobilePairingService;
  /** Null when `mobilePairing.native.enabled` resolved off at boot. */
  service: AppConversationService | null;
  machineId: () => string;
  /** Telegram topics for the unified list (absent when Telegram is not configured). */
  telegramTopics?: () => Array<{ topicId: number; topicName: string | null; lastActivity: string | null; lastPreview: string | null }>;
  /** The inbound classifier (pause / stop decisions after persist). */
  sentinel?: { decideInboundDisposition(message: string, topicId?: number): Promise<{ disposition: string }> } | null;
  now?: () => number;
}

type Principal = { kind: 'device'; deviceId: string } | { kind: 'token' };
function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

const SEND_RATE_PER_MIN = 20;
const off = (res: Response) => res.status(503).json({ error: 'native-conversations-off', detail: 'App conversations are turned off on this agent.' });
const hashOf = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');

/** History rows for the app: the stored fields plus the verdict (increment 1: never verified). */
export function historyRow(m: BrowsedMessage): Record<string, unknown> {
  return {
    eventId: m.eventId, messageId: m.messageId, role: m.role, text: m.text, at: m.at, machineId: m.machineId,
    deliveryState: m.deliveryState, originVerified: m.origin ? 'unknown' : 'none',
  };
}

export function createMobileConversationRouter(deps: MobileConversationRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const sendRate = new Map<string, number[]>();
  const mutationRate = new Map<string, number[]>();
  const svc = deps.service;

  /** Sends and conversation mutations keep separate buckets, so renames can never starve sends. */
  const rateIn = (bucket: Map<string, number[]>, deviceId: string): boolean => {
    const t = now();
    const recent = (bucket.get(deviceId) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= SEND_RATE_PER_MIN) { bucket.set(deviceId, recent); return false; }
    recent.push(t); bucket.set(deviceId, recent);
    return true;
  };
  const rateOk = (deviceId: string): boolean => rateIn(sendRate, deviceId);

  /** Common gate: feature on, device principal. Returns the device id or null (answered). */
  const gate = (req: Request, res: Response): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc) { off(res); return null; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'operator-device-required' }); return null; }
    return p.deviceId;
  };
  /**
   * Read gate: the device OR the agent's own Bearer token (agent awareness: the agent lists
   * conversations and reads history). Reads never mutate; every write stays device-only.
   */
  const readGate = (req: Request, res: Response): boolean => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc) { off(res); return false; }
    return true;
  };

  const answerLookup = (res: Response, l: ChatLookup): boolean => {
    if (l.kind === 'done') { res.status(l.status).json(l.body); return true; }
    if (l.kind === 'in-progress') { res.status(202).json({ state: 'in-progress' }); return true; }
    if (l.kind === 'outcome-unknown') { res.status(409).json({ error: 'outcome-unknown', detail: 'This may or may not have taken effect. Check the conversation.' }); return true; }
    if (l.kind === 'request-id-reused') { res.status(409).json({ error: 'payload-conflict', detail: 'This request id was already used for something else.' }); return true; }
    return false;
  };

  const validRequestId = (res: Response, requestId: unknown): requestId is string => {
    if (typeof requestId !== 'string' || requestIdTime(requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return false; }
    return true;
  };

  /**
   * A mutation (create / rename / delete) through the request store. `apply` runs once, after the
   * reservation (whose `extra` already names the effect), and its result is recorded `done`.
   */
  const mutation = (
    res: Response, deviceId: string, requestId: string, hash: string, extra: Record<string, string>,
    apply: () => { status: number; body: Record<string, unknown> },
  ): void => {
    const store = svc!.deps.requests;
    if (answerLookup(res, store.lookup(deviceId, requestId, hash))) return;
    if (!rateIn(mutationRate, deviceId)) { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (!requestIdAgeOk(requestId, now())) { res.status(400).json({ error: 'request-id-too-old' }); return; }
    let r: ReturnType<typeof store.reserve>;
    try { r = store.reserve(deviceId, requestId, hash, 0, extra); } catch {
      res.status(503).json({ error: 'conversation-unavailable', detail: 'The request could not be recorded, so nothing was changed. Try again.' });
      return;
    }
    if (r.kind === 'full') { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (r.kind !== 'reserved') { answerLookup(res, r); return; }
    let result: { status: number; body: Record<string, unknown> };
    try { result = apply(); } catch (err) {
      store.markUnknown(deviceId, requestId);
      svc!.deps.reportDegradation?.('AppConversations.mutation', err instanceof Error ? err.message : String(err));
      res.status(409).json({ error: 'outcome-unknown', detail: 'This may or may not have taken effect. Check the conversation.' });
      return;
    }
    store.finish(deviceId, requestId, result);
    res.status(result.status).json(result.body);
  };

  // ── Create ──
  router.post('/mobile/conversations', (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!validRequestId(res, body.requestId)) return;
    const title = cleanConversationTitle(body.title);
    if (!title) { res.status(400).json({ error: 'bad-title', detail: 'A title of 1-80 characters is required.' }); return; }
    // The new UUID is chosen and written into the reservation BEFORE the store or registry is touched.
    const conversationKey = newAppConversationKey();
    mutation(res, deviceId, body.requestId, hashOf('create', title), { op: 'create', conversationKey, title },
      () => svc!.applyCreate(deviceId, body.requestId as string, conversationKey, title));
  });

  // ── List ──
  router.get('/mobile/conversations', (req: Request, res: Response) => {
    if (!readGate(req, res)) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const page = svc!.store.listConversations({ limit, cursor });
    const rows: Array<Record<string, unknown>> = page.conversations.map((c) => ({
      id: c.conversationKey, platform: 'app', title: c.title, lastActivity: c.lastActivity ?? c.createdAt, lastPreview: c.lastPreview,
    }));
    // Telegram topics ride the first page only (the app pages its own conversations by cursor).
    if (!cursor && deps.telegramTopics) {
      try {
        for (const t of deps.telegramTopics().slice(0, 200)) {
          rows.push({ id: t.topicId, platform: 'telegram', title: t.topicName, lastActivity: t.lastActivity, lastPreview: t.lastPreview });
        }
      } catch { /* @silent-fallback-ok — a Telegram read failure leaves only the app rows; never an error for the app list */ }
    }
    rows.sort((a, b) => String(b.lastActivity ?? '').localeCompare(String(a.lastActivity ?? '')));
    res.json({ conversations: rows.slice(0, 200), nextCursor: page.nextCursor });
  });

  // ── Rename ──
  router.patch('/mobile/conversations/:key', (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const key = String(req.params.key);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!validRequestId(res, body.requestId)) return;
    const title = cleanConversationTitle(body.title);
    if (!title) { res.status(400).json({ error: 'bad-title', detail: 'A title of 1-80 characters is required.' }); return; }
    const hash = hashOf('rename', key, title);
    const known = deps.service!.deps.requests.lookup(deviceId, body.requestId, hash);
    if (known.kind === 'none' && !svc!.liveConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    mutation(res, deviceId, body.requestId, hash, { op: 'rename', conversationKey: key, title }, () => {
      svc!.applyRename(deviceId, body.requestId as string, key, title);
      return { status: 200, body: { conversationKey: key, title: svc!.store.getConversation(key)?.title ?? title } };
    });
  });

  // ── Delete ──
  router.delete('/mobile/conversations/:key', (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const key = String(req.params.key);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!validRequestId(res, body.requestId)) return;
    const hash = hashOf('delete', key);
    const known = svc!.deps.requests.lookup(deviceId, body.requestId, hash);
    if (known.kind === 'none' && !svc!.liveConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    mutation(res, deviceId, body.requestId, hash, { op: 'delete', conversationKey: key }, () => {
      svc!.applyDelete(deviceId, body.requestId as string, key);
      return { status: 200, body: { conversationKey: key, deleted: true } };
    });
  });

  // ── Send ──
  router.post('/mobile/chat/app/:key', async (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const s = svc!;
    const requests = s.deps.requests;
    const key = String(req.params.key);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!validRequestId(res, body.requestId)) return;
    const requestId = body.requestId;
    if (text.length < 1 || text.length > 4000) { res.status(400).json({ error: 'text must be 1-4000 characters' }); return; }
    const hash = hashOf('app-send', key, text);
    const seed = `${deviceId}\u0000${requestId}`;
    const messageId = derivedEventId('msg', seed);
    const eventId = derivedEventId('op', seed);

    // Step 2 — look up. Step 7 — a done/unknown request answers from the CURRENT delivery state.
    const prior = requests.lookup(deviceId, requestId, hash);
    if (prior.kind === 'done' || prior.kind === 'outcome-unknown') {
      const state = s.store.deliveryState(messageId);
      if (state === 'delivered' || state === 'refused' || state === 'intercepted') {
        const recorded = prior.kind === 'done' ? prior.body : {};
        res.json({ ...recorded, ok: true, conversationKey: key, eventId, messageId, deliveryState: state });
        return;
      }
    }
    if (answerLookup(res, prior)) return;

    const conv = s.liveConversation(key);
    if (!conv) { res.status(404).json({ error: 'unknown-conversation' }); return; }

    // Step 2a — an exact emergency stop skips the feature setting and the rate limit.
    const exactStop = isExactStopMessage(text);
    if (!exactStop) {
      // Step 3 — preflight (its one effect: scanInbound may decline a leaked pending pairing).
      if (!isMobileChatEnabled(deps.config)) { res.status(503).json({ error: 'Chat from the app is turned off on this agent.' }); return; }
      if (!rateOk(deviceId)) { res.status(429).json({ error: 'too-many-requests' }); return; }
      if (!requestIdAgeOk(requestId, now())) { res.status(400).json({ error: 'request-id-too-old' }); return; }
      deps.pairing.scanInbound(text);
    }
    const removed = removeAuthorityTokens(text);
    const delivered = removed.text;
    const credentialShaped = detectOutboundCredential(text).detected;

    // Step 4 — reserve, then persist the message with its signed origin (fsync) BEFORE dispatch.
    let r: ReturnType<typeof requests.reserve>;
    try { r = requests.reserve(deviceId, requestId, hash, 0, { op: 'send', conversationKey: key, messageId }); } catch {
      res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be recorded, so it was not sent. Try again.' });
      return;
    }
    if (r.kind === 'full') { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (r.kind !== 'reserved') { answerLookup(res, r); return; }

    const t = now();
    const origin = buildOrigin(req, deps.pairing, deviceId, removed.kinds.length > 0 ? { kinds: removed.kinds, machineId: deps.machineId() } : undefined);
    const msg: MessageEvent = {
      eventId, kind: 'message', conversationKey: key, messageId, role: 'operator', text: delivered,
      at: new Date(t).toISOString(), machineId: deps.machineId(), receivedAt: new Date(t).toISOString(),
      ...(origin ? { origin } : {}),
    };
    try { s.store.append(msg); } catch (err) {
      requests.release(deviceId, requestId);
      s.deps.reportDegradation?.('AppConversations.persist', err instanceof Error ? err.message : String(err));
      res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be saved, so it was not sent. Try again.' });
      return;
    }
    const extras = {
      ...(removed.kinds.length > 0 ? { redacted: true, removed: removed.kinds } : {}),
      ...(credentialShaped ? { credentialShaped: true } : {}),
    };
    const finish = (status: number, b: Record<string, unknown>): void => {
      if (!requests.finish(deviceId, requestId, { status, body: b })) s.deps.reportDegradation?.('AppConversations.requestStore', 'could not record a finished request');
      res.status(status).json(b);
    };

    if (exactStop) {
      const stop = s.emergencyStop(key);
      s.appendDelivery(key, messageId, 'intercepted', seed);
      finish(200, { ok: true, outcome: 'sentinel-kill', stopped: stop.stopped, conversationKey: key, eventId, messageId, deliveryState: 'intercepted', ...extras });
      return;
    }

    // Step 5 — ownership (pool dark: the serving-lease holder), the pause intercept, dispatch.
    const alias = s.deps.registry.appAliasFor(key) ?? (() => { const m = s.deps.registry.mintAppAlias(key); return m.ok ? m.id : null; })();
    if (alias === null || !s.isOwner()) {
      finish(503, { error: 'owner-unavailable', detail: 'Your message is saved, but the machine that runs this conversation is not available right now. Try again shortly.', conversationKey: key, eventId, messageId, ...extras });
      return;
    }
    try { if (!s.deps.registry.isAppBound(alias)) s.deps.registry.bindApp(alias); } catch (err) {
      // The message is already saved; a failed binding write must not leave the request hanging.
      requests.markUnknown(deviceId, requestId);
      s.deps.reportDegradation?.('AppConversations.bind', err instanceof Error ? err.message : String(err));
      res.status(409).json({ error: 'outcome-unknown', eventId, messageId, detail: 'This message is saved but may not have reached the agent. Check the conversation.' });
      return;
    }
    if (deps.sentinel) {
      try {
        const d = await deps.sentinel.decideInboundDisposition(delivered, alias);
        if (d.disposition === 'kill' || d.disposition === 'pause') {
          const out = d.disposition === 'kill' ? { outcome: 'sentinel-kill', stopped: s.emergencyStop(key).stopped } : { outcome: 'sentinel-pause', paused: s.pause(key) };
          s.appendDelivery(key, messageId, 'intercepted', seed);
          finish(200, { ok: true, ...out, conversationKey: key, eventId, messageId, deliveryState: 'intercepted', ...extras });
          return;
        }
      } catch { /* @silent-fallback-ok — FAIL-OPEN: a classifier error routes the message normally, as on the Telegram path */ }
    }
    const dispatch = s.deps.dispatch();
    if (!dispatch) {
      // Nothing was dispatched: an honest refusal, not an unknown outcome.
      s.appendDelivery(key, messageId, 'refused', seed);
      finish(503, { error: 'chat-unavailable', detail: 'Your message is saved, but this machine cannot start a session for it right now.', conversationKey: key, eventId, messageId, deliveryState: 'refused', ...extras });
      return;
    }
    let outcome: 'delivered' | 'refused';
    try {
      outcome = await dispatch({ conversationKey: key, alias, title: conv.title ?? 'Untitled', text: delivered, messageId, ownerName: s.ownerName(), originVerdict: 'unknown' });
    } catch (err) {
      try { s.appendDelivery(key, messageId, 'unknown', seed); } catch { /* @silent-fallback-ok — the request itself is recorded outcome-unknown below */ }
      requests.markUnknown(deviceId, requestId);
      s.deps.reportDegradation?.('AppConversations.dispatch', err instanceof Error ? err.message : String(err));
      res.status(409).json({ error: 'outcome-unknown', eventId, messageId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    s.appendDelivery(key, messageId, outcome, seed);
    finish(200, { ok: true, outcome, conversationKey: key, eventId, messageId, deliveryState: outcome, ...extras });
  });

  // ── Browse ──
  router.get('/mobile/chat/app/:key/messages', (req: Request, res: Response) => {
    if (!readGate(req, res)) return;
    const key = String(req.params.key);
    if (!svc!.liveConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 100));
    const page = svc!.store.browseMessages(key, typeof req.query.before === 'string' ? req.query.before : null, limit);
    res.json({ conversationKey: key, messages: page.messages.map(historyRow), nextBefore: page.nextBefore });
  });

  // ── Sync ──
  router.get('/mobile/chat/app/:key/events', (req: Request, res: Response) => {
    if (!readGate(req, res)) return;
    const key = String(req.params.key);
    if (!isAppConversationKey(key) || !svc!.store.getConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 100));
    const page = svc!.store.syncEvents(key, typeof req.query.cursor === 'string' ? req.query.cursor : null, limit);
    res.json({
      conversationKey: key,
      events: page.events.map((e) => {
        const { origin, ingestSeq: _seq, ...rest } = e as typeof e & { origin?: DeviceSignedOrigin };
        return { ...rest, ...(e.kind === 'message' ? { originVerified: origin ? 'unknown' : 'none' } : {}) };
      }),
      cursor: page.cursor,
    });
  });

  return router;
}

/**
 * The signed-origin fields of this request (§4.6) from the device record and the raw request.
 * For a redacted message the original signed body is NOT stored anywhere — only its hash.
 */
export function buildOrigin(req: Request, pairing: MobilePairingService, deviceId: string, redaction?: { kinds: string[]; machineId: string }): DeviceSignedOrigin | undefined {
  const dev = pairing.devices.get(deviceId);
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const time = req.headers['x-instar-device-time'];
  const sig = req.headers['x-instar-device-sig'];
  if (!dev?.publicKey || !dev.host || typeof time !== 'string' || typeof sig !== 'string') return undefined;
  let keyHash: string;
  try { keyHash = crypto.createHash('sha256').update(Buffer.from(dev.publicKey, 'base64url')).digest('hex'); } catch { return undefined; } // @silent-fallback-ok — an unreadable key stores no origin (history reads 'none')
  return {
    kind: 'device-signed', v: 1, deviceId, keyHash, publicKey: dev.publicKey, host: dev.host,
    method: req.method.toUpperCase(), pathWithQuery: req.originalUrl, timeMs: time,
    ...(redaction ? { redaction: { kinds: redaction.kinds, machineId: redaction.machineId } } : { bodyB64: raw.toString('base64') }),
    bodySha256: crypto.createHash('sha256').update(raw).digest('hex'), sig,
  };
}

/** Owner name: `threadline.ownerName`, else "Operator" (§4.2). */
export function appOwnerName(config: InstarConfig): string {
  return cleanText(config.threadline?.ownerName) || 'Operator';
}
