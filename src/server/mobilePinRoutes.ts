/**
 * Pinned messages from the Instar app and the dashboard (docs/specs/conversation-pinned-messages.md).
 *
 *   GET  /mobile/chat/app/:key/pins                      list (device read, or the agent's Bearer token)
 *   POST /mobile/chat/app/:key/pins                      {messageId, pinned, requestId}
 *   GET  /mobile/chat/:topicId/pins                      list (Telegram topic)
 *   POST /mobile/chat/:topicId/pins                      {messageId, pinned, requestId} — the machine serving Telegram
 *   GET  /mobile/chat/slack/:conversationId/pins?machine= list (Slack, the machine named)
 *   POST /mobile/chat/slack/:conversationId/pins         {messageId, pinned, requestId, machine}
 *
 * A pin is a `pin` event in the app conversation store (replicated to every machine). Pinning is
 * treated as using the conversation: the same access check as sending. A pin in a Telegram topic or
 * Slack conversation is also made there when the platform can (`mirror`); a refusal there never
 * removes the pin here. Writes are device-signed only and idempotent by requestId.
 */
import { Router, type Request, type Response } from 'express';
import type { InstarConfig } from '../core/types.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { deviceMayUse, devicePersonOf } from './mobilePairingRoutes.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { requestIdAgeOk, requestIdTime } from '../core/MobileChatRequests.js';
import { isAppConversationKey } from '../core/appConversationText.js';
import {
  applyPin, isConversationPinsEnabled, isPinMessageId, isRealTelegramMessageId, isSlackTs, pinPreview, pinRequestEventId, pinRowsFor, telegramPinEventId,
} from '../core/ConversationPins.js';
import { parseSlackConversationId, slackOwnerUserId, type MobileSlackBridge, type SlackAppConversation } from './mobileSlackRoutes.js';

/** What the pin routes need from Telegram, built on the server from the Telegram adapter. */
export interface PinTelegramBridge {
  /** Is this a topic this agent lists? */
  exists(topicId: number): boolean;
  /** This machine serves Telegram (the only one that may call the Bot API for it). */
  serving(): boolean;
  /** The text of one recent message in the topic (server paths removed), or null when not held here. */
  textOf(topicId: number, messageId: string): string | null;
  /** Pin or unpin in Telegram itself. */
  pin(topicId: number, messageId: number, pinned: boolean): Promise<void>;
}

export interface MobilePinRouteDeps {
  config: InstarConfig;
  pairing: MobilePairingService;
  /** Null when `mobilePairing.native.enabled` resolved off at boot. */
  service: AppConversationService | null;
  machineId: () => string;
  /** Null or absent when Telegram is not configured on this agent. */
  telegram?: (() => PinTelegramBridge | null) | null;
  /** Null or absent when Slack is not configured on this agent. */
  slack?: (() => MobileSlackBridge | null) | null;
  now?: () => number;
}

export type MirrorOutcome = 'done' | 'failed' | 'unavailable' | 'not-applicable';

export const TELEGRAM_PIN_REFUSED = 'Telegram did not let the agent pin this message. The pin is kept in the app.';
export const TELEGRAM_UNPIN_REFUSED = 'Telegram did not let the agent unpin this message. It is unpinned in the app.';
export const TELEGRAM_PIN_UNAVAILABLE = 'This message was typed in the app, so there is no Telegram message to pin. It is pinned in the app only.';
export const SLACK_PIN_REFUSED = 'Slack did not let the agent pin this message (it may need the pins permission). The pin is kept in the app.';
export const SLACK_UNPIN_REFUSED = 'Slack did not let the agent unpin this message (it may need the pins permission). It is unpinned in the app.';
export const SLACK_PIN_UNAVAILABLE = 'This message was sent from the app, so it can be pinned in the app only.';

type Principal = { kind: 'device'; deviceId: string } | { kind: string; deviceId?: string };
function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

interface PinTarget {
  /** The store key the pin is kept under. */
  key: string;
  /** The ref the shared access check reads. */
  ref: string;
  /** The pinned message's text as this machine holds it, for the preview. */
  textOf: (messageId: string) => string | null;
  /** Make the pin in the platform; null when nothing is mirrored for this conversation. */
  mirror: ((messageId: string, pinned: boolean) => Promise<{ outcome: MirrorOutcome; detail?: string }>) | null;
  /** May this reader see this pinned message? */
  mayRead: (messageId: string) => boolean;
  /** Must the message be held in this conversation to be pinned? (app conversations: yes) */
  mustHold?: boolean;
  /** A preview built at read time instead of a stored one (Slack: the text stays on the machine holding it). */
  readPreview?: (messageId: string) => string | null;
}

export function createMobilePinRouter(deps: MobilePinRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const svc = deps.service;

  /** Feature on, else answered. */
  const ready = (res: Response): boolean => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc) { res.status(503).json({ error: 'native-conversations-off', detail: 'App conversations are turned off on this agent.' }); return false; }
    if (!isConversationPinsEnabled(deps.config)) { res.status(503).json({ error: 'pins-off', detail: 'Pinned messages are turned off on this agent.' }); return false; }
    return true;
  };

  const storedText = (key: string, messageId: string): string | null => {
    try {
      const ev = svc!.store.getMessageEvent(key, messageId) as { kind?: string; text?: unknown; conversationKey?: string } | null;
      return ev && (ev.kind === 'message' || ev.kind === 'media-message') && typeof ev.text === 'string' ? ev.text : null;
    } catch { return null; } // @silent-fallback-ok — no preview rather than a failed pin
  };

  /** A list answer. */
  const list = (res: Response, t: PinTarget): void => {
    res.json({ conversationKey: t.key, pins: pinRowsFor(svc!.store, t.key, t.mayRead, t.readPreview) });
  };

  /** A write: validate, apply, mirror, answer. */
  const write = async (req: Request, res: Response, t: PinTarget): Promise<void> => {
    const p = principalOf(req);
    const deviceId = p.kind === 'device' && typeof p.deviceId === 'string' ? p.deviceId : null;
    if (!deviceId) { res.status(403).json({ error: 'operator-device-required' }); return; }
    const person = devicePersonOf(req);
    if (!person) { res.status(403).json({ error: 'person-unknown' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isPinMessageId(body.messageId)) { res.status(400).json({ error: 'bad-message-id' }); return; }
    if (typeof body.pinned !== 'boolean') { res.status(400).json({ error: 'bad-request', detail: '"pinned" must be true or false.' }); return; }
    if (typeof body.requestId !== 'string' || requestIdTime(body.requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const messageId = body.messageId;
    const pinned = body.pinned;
    // A message from another conversation, or one this person may not read, cannot be pinned here.
    if ((t.mustHold && !svc!.store.getMessageEvent(t.key, messageId)) || !t.mayRead(messageId)) { res.status(404).json({ error: 'unknown-message' }); return; }
    const eventId = pinRequestEventId(deviceId, body.requestId);
    // A retry gets the state as it is now; the same request id for a different pin is a conflict.
    const prior = svc!.store.getEvent(t.key, eventId);
    if (prior) {
      if (prior.kind !== 'pin' || prior.pinnedMessageId !== messageId || prior.pinState !== (pinned ? 'pinned' : 'unpinned')) {
        res.status(409).json({ error: 'payload-conflict', detail: 'This request id was already used for something else.' });
        return;
      }
      res.json({ ok: true, pinned: svc!.store.pinState(t.key, messageId) === 'pinned', changed: false, mirror: 'not-applicable', pins: pinRowsFor(svc!.store, t.key, t.mayRead, t.readPreview) });
      return;
    }
    if (!requestIdAgeOk(body.requestId, now())) { res.status(400).json({ error: 'request-id-too-old' }); return; }
    const preview = pinned ? pinPreview(t.textOf(messageId)) : undefined;
    let out: ReturnType<typeof applyPin>;
    try {
      out = applyPin(svc!.store, {
        conversationKey: t.key, messageId, pinned, by: { name: person.name, role: person.role }, preview, source: 'app',
        machineId: svc!.deps.machineId(), at: new Date(now()).toISOString(), eventId,
      });
    } catch (err) {
      svc!.deps.reportDegradation?.('AppConversations.pin', err instanceof Error ? err.message : String(err));
      res.status(503).json({ error: 'conversation-unavailable', detail: 'The pin could not be saved. Try again.' });
      return;
    }
    if (!out.ok) { res.status(409).json({ error: 'too-many-pins', detail: 'This conversation already has 100 pinned messages. Unpin one first.' }); return; }
    let mirror: { outcome: MirrorOutcome; detail?: string } = { outcome: 'not-applicable' };
    if (out.changed && t.mirror) mirror = await t.mirror(messageId, pinned);
    res.json({
      ok: true, pinned: svc!.store.pinState(t.key, messageId) === 'pinned', changed: out.changed, mirror: mirror.outcome,
      ...(mirror.detail ? { mirrorDetail: mirror.detail } : {}), pins: pinRowsFor(svc!.store, t.key, t.mayRead, t.readPreview),
    });
  };

  // ── App conversations ──
  const appTarget = (req: Request, res: Response, op: 'read' | 'send'): PinTarget | null => {
    const key = String(req.params.key);
    if (!isAppConversationKey(key) || !deviceMayUse(deps.pairing, req, key, op) || !svc!.liveConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return null; }
    const reader = devicePersonOf(req);
    return { key, ref: key, textOf: (id) => storedText(key, id), mirror: null, mayRead: (id) => deps.pairing.mayReadMessageId(reader, key, id), mustHold: true };
  };
  router.get('/mobile/chat/app/:key/pins', (req, res) => {
    if (!ready(res)) return;
    const t = appTarget(req, res, 'read'); if (t) list(res, t);
  });
  router.post('/mobile/chat/app/:key/pins', async (req, res) => {
    if (!ready(res)) return;
    const t = appTarget(req, res, 'send'); if (t) await write(req, res, t);
  });

  // ── Slack conversations (registered before the Telegram path, which would read "slack" as a topic) ──
  const slackTarget = (req: Request, res: Response, op: 'read' | 'send', named: unknown): PinTarget | null => {
    if (!deviceMayUse(deps.pairing, req, 'slack:', op)) { res.status(403).json({ error: 'owner-only', detail: 'Only the agent\'s owner can use Slack from the app, unless the owner turns it on for you.' }); return null; }
    const id = parseSlackConversationId(String(req.params.conversationId));
    if (id === null) { res.status(400).json({ error: 'bad-conversation' }); return null; }
    const self = deps.machineId();
    if (typeof named !== 'string' || !named) { res.status(400).json({ error: 'machine-required', detail: 'Name the machine this Slack conversation was listed from.' }); return null; }
    if (named !== self) { res.status(409).json({ error: 'wrong-machine', servedBy: self, detail: 'This Slack conversation belongs to another machine. Open it through that machine.' }); return null; }
    const bridge = deps.slack?.() ?? null;
    if (!bridge) { res.status(503).json({ error: 'slack-not-configured', detail: 'Slack is not set up on this agent.' }); return null; }
    if (!slackOwnerUserId(deps.config)) { res.status(503).json({ error: 'slack-owner-unset', detail: 'Your Slack account is not linked to the app yet. Ask the agent to set your Slack user id, then try again.' }); return null; }
    const conv: SlackAppConversation | null = bridge.resolve(id);
    if (!conv) { res.status(404).json({ error: 'unknown-conversation' }); return null; }
    return {
      key: conv.key, ref: conv.key,
      // No stored preview for Slack: Slack text stays on the machine holding the conversation, so the
      // preview is built here at read time (the list and the history read are both served here).
      textOf: () => null,
      readPreview: (mid) => slackTextOf(bridge, conv, mid) ?? storedText(conv.key, mid),
      mirror: async (mid, pinned) => {
        if (!isSlackTs(mid) || !bridge.pin) return { outcome: 'unavailable', detail: SLACK_PIN_UNAVAILABLE };
        try { await bridge.pin(conv, mid, pinned); return { outcome: 'done' }; } catch (err) { // @silent-fallback-ok — the refusal is the answer's mirror field
          // Already in the state asked for in Slack: that is done, not a refusal.
          if (/already_pinned|no_pin/.test(err instanceof Error ? err.message : String(err))) return { outcome: 'done' };
          return { outcome: 'failed', detail: pinned ? SLACK_PIN_REFUSED : SLACK_UNPIN_REFUSED };
        }
      },
      mayRead: () => true,
    };
  };
  router.get('/mobile/chat/slack/:conversationId/pins', (req, res) => {
    if (!ready(res)) return;
    const t = slackTarget(req, res, 'read', req.query.machine); if (t) list(res, t);
  });
  router.post('/mobile/chat/slack/:conversationId/pins', async (req, res) => {
    if (!ready(res)) return;
    const t = slackTarget(req, res, 'send', (req.body as Record<string, unknown> | undefined)?.machine); if (t) await write(req, res, t);
  });

  // ── Telegram topics ──
  const topicOf = (req: Request): number | null => {
    const raw = String(req.params.topicId);
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  };
  router.get('/mobile/chat/:topicId/pins', (req, res, next) => {
    const topicId = topicOf(req);
    if (topicId === null) { next(); return; }
    if (!ready(res)) return;
    const ref = `telegram:${topicId}`;
    if (!deviceMayUse(deps.pairing, req, ref, 'read')) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    list(res, { key: ref, ref, textOf: () => null, mirror: null, mayRead: () => true });
  });
  router.post('/mobile/chat/:topicId/pins', async (req, res, next) => {
    const topicId = topicOf(req);
    if (topicId === null) { next(); return; }
    if (!ready(res)) return;
    const ref = `telegram:${topicId}`;
    if (!deviceMayUse(deps.pairing, req, ref, 'send')) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const tg = deps.telegram?.() ?? null;
    if (!tg) { res.status(503).json({ error: 'telegram-not-configured', detail: 'Telegram is not set up on this agent.' }); return; }
    if (!tg.exists(topicId)) { res.status(404).json({ error: 'unknown-topic' }); return; }
    if (!tg.serving()) { res.status(409).json({ error: 'not-serving', detail: 'This machine is not the one talking to Telegram right now. Try again shortly.' }); return; }
    await write(req, res, {
      key: ref, ref,
      textOf: (mid) => tg.textOf(topicId, mid) ?? storedText(ref, mid),
      mirror: async (mid, pinned) => {
        if (!isRealTelegramMessageId(mid)) return { outcome: 'unavailable', detail: TELEGRAM_PIN_UNAVAILABLE };
        try { await tg.pin(topicId, Number(mid), pinned); return { outcome: 'done' }; } catch { return { outcome: 'failed', detail: pinned ? TELEGRAM_PIN_REFUSED : TELEGRAM_UNPIN_REFUSED }; } // @silent-fallback-ok — the refusal is the answer's mirror field
      },
      mayRead: () => true,
    });
  });

  return router;
}

/** The text of one Slack message in a conversation held here, or null. Never throws. */
export function slackTextOf(bridge: Pick<MobileSlackBridge, 'history'>, conv: SlackAppConversation, ts: string): string | null {
  if (!isSlackTs(ts)) return null;
  try { const row = bridge.history(conv, 1000).find((r) => r.ts === ts); return row ? row.text : null; } catch { return null; } // @silent-fallback-ok — no preview rather than a failed read
}

/**
 * Record a pin someone made inside Telegram (the adapter's `onTopicMessagePinned`). Writes nothing
 * when the message is already pinned here, the feature is off, or the store is absent. Never throws.
 */
export function recordTelegramPin(
  deps: { config: InstarConfig; service: AppConversationService | null; textOf?: (topicId: number, messageId: string) => string | null; report?: (detail: string) => void },
  p: { topicId: number; messageId: number; serviceMessageId: number; byName: string; atMs: number },
): 'recorded' | 'unchanged' | 'off' | 'failed' {
  const svc = deps.service;
  if (!svc || !isConversationPinsEnabled(deps.config)) return 'off';
  const key = `telegram:${p.topicId}`;
  const messageId = String(p.messageId);
  try {
    const out = applyPin(svc.store, {
      conversationKey: key, messageId, pinned: true, by: { name: p.byName || 'Someone', role: 'telegram' },
      preview: pinPreview(deps.textOf?.(p.topicId, messageId) ?? null), source: 'telegram',
      machineId: svc.deps.machineId(), at: new Date().toISOString(),
      eventId: telegramPinEventId(p.topicId, p.messageId, p.serviceMessageId),
    });
    return out.ok && out.changed ? 'recorded' : 'unchanged';
  } catch (err) {
    deps.report?.(err instanceof Error ? err.message : String(err));
    return 'failed';
  }
}
