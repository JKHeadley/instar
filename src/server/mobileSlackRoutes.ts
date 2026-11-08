/**
 * Slack conversations from the Instar app (docs/specs/mobile-native-conversations.md §4.9,
 * increment 4). Device-signed (the read also accepts the agent's Bearer token):
 *
 *   GET  /mobile/chat/slack/:conversationId/messages?machine=&before=&limit=   history (backwards)
 *   POST /mobile/chat/slack/:conversationId                           send {text, requestId, machine}
 *
 * `machine` is the `machine` field of the conversation's list row. Slack ids are local to the
 * machine that minted them. A history read naming another machine is forwarded to that machine for
 * the owner's phone only (docs/specs/mobile-slack-holder-proxy.md); every other caller, and every
 * send, is refused (409 wrong-machine). A request naming none is refused (400 machine-required).
 *
 * `:conversationId` is the machine-local negative durable id the conversation registry minted
 * for the Slack channel or thread ("Durable Conversation Identity"). It is translated on this
 * machine to the registry's canonical key (`slack:<team>:<channel>[:<thread>]`); the message is
 * stored under that key in the app conversation store with its signed origin, and this machine's
 * receipt is a v2 receipt that signs the canonical key, because the alias in the signed path
 * means nothing on another machine.
 *
 * The send keeps the order of §4.2: authenticate → look up → emergency stop → preflight →
 * reserve → persist (fsync, plus a copy in slack-messages.jsonl) → intercepts → dispatch through
 * the same Slack inbound dispatch a Slack message takes, with the operator as sender → delivery
 * event → mirror "📱 <owner> (from the app): …" into the Slack channel → done. A failed mirror
 * never fails or repeats the dispatch (`mirror: "failed"`).
 *
 * Behind `mobilePairing.native.enabled` (the app conversation service): off ⇒ 503. No Slack on
 * this agent ⇒ 503 `slack-not-configured`. `mobilePairing.slackOwnerUserId` unset ⇒ 503
 * `slack-owner-unset` (the owner's Slack identity is a config field, never inferred).
 */
import { storageErrorResponse } from '../core/storageMachineName.js';
import { mobileOwnerDeviceAdmission } from './mobileOwnerDeviceAdmission.js';
import { DEFAULT_ORIGIN_DISPLAY } from '../messaging/telegram-origin/OriginPresentation.js';
import type { OriginDisplaySettings } from '../messaging/telegram-origin/types.js';
import { deviceOriginRow, type MessageOriginEvidence } from '../messaging/messageOrigin.js';
import type { SlackOriginLedger } from '../messaging/slack/SlackOriginLedger.js';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { InstarConfig } from '../core/types.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { deviceAdmittedAt, deviceMayUse, devicePersonOf, isMobileChatEnabled, isMobileMediaEnabled } from './mobilePairingRoutes.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { requestIdAgeOk, requestIdTime } from '../core/MobileChatRequests.js';
import { derivedEventId, hideCredentialSpans, removeAuthorityTokens } from '../core/appConversationText.js';
import type { MediaMessageEvent, MessageEvent } from '../core/AppConversationStore.js';
import { mediaPreview, displayName, type AppAttachment } from '../core/appMediaTypes.js';
import {
  checkSignedFiles, claimMediaUploads, mediaRecordTooLarge, preflightMediaAttachments, publishMediaMessage, signedFileHashParts, type SignedAttachment,
} from './mobileMediaSend.js';
import { detectOutboundCredential } from '../messaging/outbound-credential-guard.js';
import { isExactStopMessage } from '../core/MessageSentinel.js';
import { appOwnerName, attachmentRows, buildSignedOrigin, historyRow } from './mobileConversationRoutes.js';
import { slackDeviceText, slackPlatformMediaFor } from '../core/appPlatformMedia.js';
import type { OriginVerdict } from '../core/AppRecordSignatures.js';
import { readJsonlTailLastLines } from '../utils/jsonl-tail.js';
import type { HolderRead } from './mobileSlackHolderProxy.js';

/** A Slack conversation as this machine knows it (a local registry entry). */
export interface SlackAppConversation {
  id: number;
  /** The registry's canonical key: `slack:<team>:<channel>[:<thread>]`. */
  key: string;
  channelId: string;
  threadTs: string | null;
  label: string | null;
  mintedAt: string | null;
}

/** One Slack history row as the bridge reads it (slack-messages.jsonl and the in-memory ring). */
export interface SlackHistoryRow {
  ts: string;
  text: string;
  fromUser: boolean;
  senderName: string | null;
  at: string;
  /** Present on a row written for a message sent from the app (joins to the app store). */
  eventId?: string;
}

export type SlackDispatchOutcome = 'delivered' | 'queued' | 'refused';

/**
 * Everything the routes need from Slack, built on the server from the Slack adapter, the
 * conversation registry and the Slack inbound dispatch. Null when Slack is not configured.
 */
export interface MobileSlackBridge {
  /** A LOCAL Slack conversation for a negative id (a replicated or unknown id is null). */
  resolve(id: number): SlackAppConversation | null;
  /** Every local Slack conversation (the unified list). */
  conversations(): SlackAppConversation[];
  /** Recent rows of one channel or thread, oldest first, bounded. */
  history(conv: SlackAppConversation, limit: number): SlackHistoryRow[];
  /** The recorded origin of an agent message (§4), or why there is none. Absent ⇒ no ledger here. */
  originOf?(conv: SlackAppConversation, ts: string): { evidence: MessageOriginEvidence } | { missing: 'not-retained' | 'other-machine' | 'unlinked' };
  /** The latest row of each conversation, for the list (bounded read). */
  lastActivity(): Map<string, { at: string; preview: string }>;
  /** The Slack inbound dispatch, with the operator as sender. Null when it is not wired yet. */
  dispatch(input: { conv: SlackAppConversation; text: string; ownerName: string; ownerUserId: string; messageId: string; originVerdict: OriginVerdict }): Promise<SlackDispatchOutcome>;
  /** Post the mirror line into the channel or thread. */
  post(conv: SlackAppConversation, text: string): Promise<void>;
  /**
   * Upload one file into the channel or thread (the mirror of a file sent from the app, chat-media
   * §4.9), with an optional message beside it. Absent when the adapter cannot upload.
   */
  uploadFile?(conv: SlackAppConversation, filePath: string, opts: { filename: string; initialComment?: string }): Promise<void>;
  /** The app message's copy in slack-messages.jsonl (carries the store eventId). */
  logAppMessage(conv: SlackAppConversation, row: { messageId: string; text: string; senderName: string; ownerUserId: string; eventId: string; deviceId: string }): void;
  /** Emergency stop (every session, as a Slack stop does) and pause (Escape to this conversation's session). */
  emergencyStop(): { stopped: boolean };
  pause(conv: SlackAppConversation): boolean;
  /** Whether a Slack user id is authorized on this agent's Slack adapter. */
  isAuthorized(userId: string): boolean;
  /** This machine holds the serving lease (Slack is dispatched on the serving machine). */
  holdsLease(): boolean;
}

export interface MobileSlackRouteDeps {
  config: InstarConfig;
  pairing: MobilePairingService;
  /** Null when `mobilePairing.native.enabled` resolved off at boot. */
  service: AppConversationService | null;
  /** Null when Slack is not configured on this agent. */
  slack: (() => MobileSlackBridge | null) | null;
  sentinel?: { decideInboundDisposition(message: string, topicId?: number): Promise<{ disposition: string }> } | null;
  /** This machine's id: the `machine` the list puts on Slack rows, which every Slack request must name. */
  machineId: () => string;
  /** The agent's current origin display bits (message-origin-all-platforms §5). Absent ⇒ all on. */
  originDisplay?: () => OriginDisplaySettings;
  now?: () => number;
  /** Reads history from the machine that holds it, for the owner's phone. Absent: 409 wrong-machine, as before. */
  holderRead?: HolderRead;
}

/** The operator's Slack user id (`mobilePairing.slackOwnerUserId`), or null when unset or malformed. */
export function slackOwnerUserId(config: InstarConfig): string | null {
  const v = (config.mobilePairing as { slackOwnerUserId?: unknown } | undefined)?.slackOwnerUserId;
  return typeof v === 'string' && /^[UW][A-Z0-9]{2,20}$/.test(v) ? v : null;
}

/** A strict negative id from the path segment (`-12`, never `-012` or `-0`), else null. */
export function parseSlackConversationId(raw: string): number | null {
  if (!/^-[1-9][0-9]{0,17}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** The title the app shows for a Slack conversation: its label, else `#<channel>` (a thread says so). */
export function slackConversationTitle(c: SlackAppConversation): string {
  const base = c.label ? c.label.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) : '';
  const name = base || `#${c.channelId}`;
  return c.threadTs ? `${name} (thread)` : name;
}

const SEND_RATE_PER_MIN = 20;
const hashOf = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');

/** People and roles §3.4: Slack speaks as the owner's Slack identity, so only the owner's phone may use it. */
function ownerOnly(res: Response): void {
  res.status(403).json({ error: 'owner-only', detail: 'Only the agent\'s owner can use Slack from the app, unless the owner turns it on for you.' });
}

export function createMobileSlackRouter(deps: MobileSlackRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  const sendRate = new Map<string, number[]>();
  const svc = deps.service;

  const principalDevice = (req: Request): string | null => {
    const p = (req as unknown as { instarPrincipal?: { kind: string; deviceId?: string } }).instarPrincipal;
    return p?.kind === 'device' && typeof p.deviceId === 'string' ? p.deviceId : null;
  };
  /**
   * A Slack conversation id is local to the machine that minted it, so every Slack request must
   * name the machine its row came from (`machine` from the list row: a query parameter on the read,
   * a body field on the send, both covered by the device signature). A missing or different
   * machine is refused before anything is read or written: this machine never reads or sends to
   * a conversation that merely shares the number. The history route tries the owner's holder read
   * first, which never looks the number up here.
   */
  const rightMachine = (res: Response, named: unknown): boolean => {
    const self = deps.machineId();
    if (typeof named !== 'string' || !named) { res.status(400).json({ error: 'machine-required', detail: 'Name the machine this Slack conversation was listed from.' }); return false; }
    if (named !== self) { res.status(409).json({ error: 'wrong-machine', servedBy: self, detail: 'This Slack conversation belongs to another machine. Open it through that machine.' }); return false; }
    return true;
  };
  /** Slack on this agent and the owner's Slack id set, else answered. */
  const slackReady = (res: Response): { bridge: MobileSlackBridge; owner: string } | null => {
    const bridge = deps.slack?.() ?? null;
    if (!bridge) { res.status(503).json({ error: 'slack-not-configured', detail: 'Slack is not set up on this agent.' }); return null; }
    const owner = slackOwnerUserId(deps.config);
    if (!owner) {
      res.status(503).json({ error: 'slack-owner-unset', detail: 'Your Slack account is not linked to the app yet. Ask the agent to set your Slack user id, then try again.' });
      return null;
    }
    return { bridge, owner };
  };

  // ── History ──
  router.get('/mobile/chat/slack/:conversationId/messages', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc) { res.status(503).json({ error: 'native-conversations-off', detail: 'App conversations are turned off on this agent.' }); return; }
    if (!deviceMayUse(deps.pairing, req, 'slack:')) { ownerOnly(res); return; }
    const id = parseSlackConversationId(String(req.params.conversationId));
    if (id === null) { res.status(400).json({ error: 'bad-conversation' }); return; }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 100));
    // Another machine's row: only the owner's phone is read through, by the trusted holder. A token
    // read is never forwarded, so the holder's own hop cannot go on to a third machine.
    const named = req.query.machine;
    const deviceId = principalDevice(req);
    const admission = mobileOwnerDeviceAdmission(deps.pairing, req);
    const stillOwner = () => admission?.isCurrent() === true;
    if (deps.holderRead && typeof named === 'string' && named && named !== deps.machineId() && stillOwner()) {
      const answer = await deps.holderRead({ id, machine: named, limit, before: typeof req.query.before === 'string' ? req.query.before : null, stillOwner });
      // The helper has parsed/formatted the body; reread at the actual emission boundary.
      if (answer.status === 200 && !stillOwner()) { ownerOnly(res); return; }
      res.status(answer.status).json(answer.body);
      return;
    }
    if (!rightMachine(res, named)) return;
    const ready = slackReady(res); if (!ready) return;
    const conv = ready.bridge.resolve(id);
    if (!conv) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const before = typeof req.query.before === 'string' ? req.query.before.split(',') : null;
    const isBefore = (at: string, eventId: string) => !before || before.length !== 2 || at < before[0]! || (at === before[0] && eventId < before[1]!);

    // A holder hop asks for the phone's shape by token, so the owner's phone gets what a local read gives.
    const deviceViewAsked = deviceId === null && req.query.deviceView === '1';
    const isDevice = deviceId !== null || deviceViewAsked;
    const display = deps.originDisplay?.() ?? { ...DEFAULT_ORIGIN_DISPLAY };
    const byId = new Map<string, Record<string, unknown>>();
    // App-sent messages from the store, with their verdict (the store is the evidence, never rotated).
    let stored: ReturnType<typeof svc.store.browseMessages>['messages'] = [];
    try { stored = svc.store.browseMessages(conv.key, before ? before.join(',') : null, limit).messages; } catch { stored = []; } // @silent-fallback-ok — the Slack rows are still returned
    for (const m of stored) {
      byId.set(m.eventId, { ...historyRow(m, (x) => svc.verify({ ...x, conversationKey: conv.key }), svc), fromUser: m.role === 'operator', senderName: m.role === 'operator' ? (m.senderName ?? appOwnerName(deps.config)) : null, via: 'mobile-device' });
    }
    // Slack rows: a row carrying an app eventId is the copy of a stored message (already above);
    // everything else was typed in Slack itself (`none`) or is the agent's reply.
    let rows: SlackHistoryRow[] = [];
    try { rows = ready.bridge.history(conv, 1000); } catch { rows = []; } // @silent-fallback-ok — the stored rows are still returned
    for (const r of rows) {
      if (r.eventId) {
        if (byId.has(r.eventId)) continue;
        // Its store event is not on this machine (not yet replicated, or rotated store evidence): "couldn't check".
        const eventId = r.eventId;
        if (!isBefore(r.at, eventId)) continue;
        byId.set(eventId, { eventId, messageId: r.ts, role: 'operator', fromUser: true, senderName: r.senderName, text: r.text, at: r.at, deliveryState: 'unknown', originVerified: 'unknown', via: 'mobile-device' });
        continue;
      }
      const eventId = `slack:${r.ts}`;
      if (!isBefore(r.at, eventId) || byId.has(eventId)) continue;
      // A DEVICE read (media spec §4.9): a file a Slack message carried comes back as
      // `attachments` (the app history row shape), and the text never shows a server path.
      let text = r.text;
      let attachments: Record<string, unknown>[] | null = null;
      if (isDevice) {
        const recorded = r.fromUser ? slackPlatformMediaFor(svc.store, conv.key, r.ts) : null;
        text = slackDeviceText(r.text, recorded);
        if (recorded) { try { attachments = attachmentRows(recorded, svc); } catch { attachments = null; } } // @silent-fallback-ok — the row is still returned, path-free
      }
      // §4: an agent row carries its recorded origin (Slack rows never claim `false`).
      let origin: Record<string, unknown> | null = null;
      if (!r.fromUser) {
        const found = ready.bridge.originOf?.(conv, r.ts) ?? { missing: 'other-machine' as const };
        origin = 'evidence' in found ? deviceOriginRow(found.evidence, display) as unknown as Record<string, unknown>
          : deviceOriginRow(null, display, found.missing) as unknown as Record<string, unknown>;
      }
      byId.set(eventId, { eventId, messageId: r.ts, role: r.fromUser ? 'participant' : 'agent', fromUser: r.fromUser, senderName: r.senderName, text, at: r.at, originVerified: 'none', ...(attachments ? { attachments } : {}), ...(origin ? { origin } : {}) });
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const desc = [...byId.values()].sort((x, y) => cmp(String(y.at), String(x.at)) || cmp(String(y.eventId), String(x.eventId)));
    const page = desc.slice(0, limit);
    const oldest = page[page.length - 1];
    res.json({
      // `conversationKey` is the `ref` a download of this conversation's files names (§4.9).
      ...(deviceViewAsked ? { deviceView: true } : {}),
      conversationId: id, title: slackConversationTitle(conv), conversationKey: conv.key, messages: page.reverse(),
      nextBefore: desc.length > limit && oldest ? `${String(oldest.at)},${String(oldest.eventId)}` : null,
    });
  });

  // ── Send ──
  router.post('/mobile/chat/slack/:conversationId', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc) { res.status(503).json({ error: 'native-conversations-off', detail: 'App conversations are turned off on this agent.' }); return; }
    const deviceId = principalDevice(req);
    if (!deviceId) { res.status(403).json({ error: 'operator-device-required' }); return; }
    if (!deviceMayUse(deps.pairing, req, 'slack:')) { ownerOnly(res); return; }
    const s = svc;
    const requests = s.deps.requests;
    const raw = String(req.params.conversationId);
    const id = parseSlackConversationId(raw);
    if (id === null) { res.status(400).json({ error: 'bad-conversation' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!rightMachine(res, body.machine)) return;
    // Files (chat-media §4.3, §4.9): with media on, a body with attachments becomes a
    // `media-message` stored under the conversation's canonical key. With media off it is refused
    // as before: a message is never stored without its files. An exact stop never waits on files.
    // The media flag is read live per request, as on the Telegram send route.
    const mediaOn = deps.pairing.nativeOn && isMobileMediaEnabled(deps.config);
    if (body.attachments !== undefined && !mediaOn) { res.status(400).json({ error: 'media-target-unsupported', detail: 'Files can be sent in app conversations. Sending them into Slack is not available yet.' }); return; }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    let signedFiles: SignedAttachment[] | null = null;
    if (body.attachments !== undefined && !isExactStopMessage(text)) {
      const checked = checkSignedFiles(body.attachments);
      if ('status' in checked) { res.status(checked.status).json(checked.body); return; }
      signedFiles = checked.files;
    }
    if ((text.length < 1 && !signedFiles) || text.length > 4000) { res.status(400).json({ error: 'text must be 1-4000 characters' }); return; }
    const requestId = body.requestId;
    if (typeof requestId !== 'string' || requestIdTime(requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const hash = signedFiles ? hashOf('slack-send-media', raw, text, ...signedFileHashParts(signedFiles)) : hashOf('slack-send', raw, text);
    // The payload hash is part of the seed: an early refusal releases the request id, and a retry
    // with the same id but different text must be a different stored message.
    const seed = `${deviceId}\u0000${requestId}\u0000${hash}`;
    const messageId = derivedEventId('msg', seed);
    const eventId = derivedEventId('op', seed);

    // Step 2 — look up; a done/unknown request answers from the CURRENT delivery state.
    const prior = requests.lookup(deviceId, requestId, hash);
    if (prior.kind === 'done' || prior.kind === 'outcome-unknown') {
      const state = s.store.deliveryState(messageId);
      if (state === 'delivered' || state === 'refused' || state === 'intercepted') {
        const recorded = prior.kind === 'done' ? prior.body : {};
        res.json({ ...recorded, ok: true, conversationId: id, eventId, messageId, deliveryState: state });
        return;
      }
    }
    if (prior.kind === 'done') { res.status(prior.status).json(prior.body); return; }
    if (prior.kind === 'in-progress') { res.status(202).json({ state: 'in-progress' }); return; }
    if (prior.kind === 'outcome-unknown') { res.status(409).json({ error: 'outcome-unknown', eventId, messageId, detail: 'This message may or may not have reached the agent. Check the conversation.' }); return; }
    if (prior.kind === 'request-id-reused') { res.status(409).json({ error: 'payload-conflict', detail: 'This request id was already used for something else.' }); return; }

    const ready = slackReady(res); if (!ready) return;
    const { bridge, owner } = ready;
    const conv = bridge.resolve(id);
    if (!conv) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    if (!bridge.isAuthorized(owner)) {
      res.status(503).json({ error: 'slack-owner-not-authorized', detail: 'The Slack account linked to the app is not one this agent accepts messages from.' });
      return;
    }

    // Step 2a — an exact emergency stop skips the feature setting and the rate limit.
    const exactStop = isExactStopMessage(text);
    if (!exactStop) {
      // Step 3 — preflight (its one effect: scanInbound may decline a leaked pending pairing).
      if (!isMobileChatEnabled(deps.config)) { res.status(503).json({ error: 'Chat from the app is turned off on this agent.' }); return; }
      const t = now();
      const recent = (sendRate.get(deviceId) ?? []).filter((x) => t - x < 60_000);
      if (recent.length >= SEND_RATE_PER_MIN) { sendRate.set(deviceId, recent); res.status(429).json({ error: 'too-many-requests' }); return; }
      recent.push(t); sendRate.set(deviceId, recent);
      if (!requestIdAgeOk(requestId, t)) { res.status(400).json({ error: 'request-id-too-old' }); return; }
      deps.pairing.scanInbound(text);
    }
    // Slack is dispatched on the serving machine. Refused BEFORE anything is saved, so the app
    // keeps the text and nothing is stored twice (the Telegram chat route's rule).
    if (!bridge.holdsLease()) { res.status(409).json({ error: 'not-serving', detail: 'This machine is not receiving messages right now. Try again shortly.' }); return; }
    const removed = removeAuthorityTokens(text);
    const delivered = removed.text;
    const removedKinds: string[] = [...removed.kinds];
    // Media preflight (chat-media §4.3): each upload is this device's finished upload for THIS
    // conversation (its canonical key), with exactly the signed fields.
    let uploadIds: string[] = [];
    let stored: AppAttachment[] = [];
    if (signedFiles) {
      const pre = preflightMediaAttachments(s, { deviceId, conversationRef: conv.key, messageId, files: signedFiles, scanInbound: (x) => deps.pairing.scanInbound(x) });
      if (!pre.ok) { res.status(pre.status).json(pre.body); return; }
      uploadIds = pre.uploadIds;
      stored = pre.stored;
      for (const k of pre.removedKinds) if (!removedKinds.includes(k)) removedKinds.push(k);
    }
    const credentialShaped = detectOutboundCredential([text, ...(signedFiles ?? []).map((a) => a.transcript ?? '')].join('\n')).detected;
    const extras = {
      ...(removedKinds.length > 0 ? { redacted: true, removed: removedKinds } : {}),
      ...(credentialShaped ? { credentialShaped: true } : {}),
    };

    const sendPerson = devicePersonOf(req);
    const receivedAt = new Date(deviceAdmittedAt(req) ?? now()).toISOString();
    const signed = buildSignedOrigin(req, deps.pairing, deviceId, delivered, removedKinds, s.deps.signer ?? null, receivedAt,
      (detail) => s.deps.reportDegradation?.('MobileSlack.sign', detail), stored.length > 0 ? stored : undefined, conv.key);
    const base = {
      eventId, conversationKey: conv.key, messageId, role: 'operator' as const, text: delivered,
      at: receivedAt, machineId: s.deps.machineId(), receivedAt,
      ...(signed.origin ? { origin: signed.origin } : {}), ...(signed.receipt ? { receipt: signed.receipt } : {}),      // People and roles §3.3: who sent it, recorded at accept time.
      ...(sendPerson ? { senderName: sendPerson.name, senderRole: sendPerson.role } : {}),
      ...(sendPerson && sendPerson.role !== 'owner' && sendPerson.userId ? { senderPerson: { machineId: deps.pairing.machineId(), userId: sendPerson.userId } } : {}),
    };
    const msg: MessageEvent | MediaMessageEvent = stored.length > 0 ? { ...base, kind: 'media-message', attachments: stored } : { ...base, kind: 'message' };
    if (msg.kind === 'media-message' && mediaRecordTooLarge(msg, signed.origin, s.deps.machineId())) {
      res.status(413).json({ error: 'message-too-large', detail: 'This message is too long to store. Shorten the text or send fewer files.' });
      return;
    }

    // Step 4 — reserve, then persist (fsync) BEFORE dispatch.
    let r: ReturnType<typeof requests.reserve>;
    try { r = requests.reserve(deviceId, requestId, hash, 0, { op: 'send', conversationKey: conv.key, messageId }); } catch {
      res.status(503).json(storageErrorResponse({ error: 'chat-unavailable', detail: 'The message could not be recorded, so it was not sent. Try again.' }, deps.config.stateDir));
      return;
    }
    if (r.kind === 'full') { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (r.kind !== 'reserved') {
      if (r.kind === 'in-progress') res.status(202).json({ state: 'in-progress' });
      else if (r.kind === 'done') res.status(r.status).json(r.body);
      else res.status(409).json({ error: r.kind === 'request-id-reused' ? 'payload-conflict' : 'outcome-unknown' });
      return;
    }
    if (msg.kind === 'media-message') {
      const refused = await claimMediaUploads(s, uploadIds, messageId, (detail) => s.deps.reportDegradation?.('AppMedia.publish', detail));
      if (refused) { requests.release(deviceId, requestId); res.status(refused.status).json(refused.body); return; }
    }
    try {
      if (msg.kind === 'media-message') publishMediaMessage(s, uploadIds, msg);
      else s.store.append(msg);
    } catch (err) {
      requests.release(deviceId, requestId);
      s.deps.reportDegradation?.('MobileSlack.persist', err instanceof Error ? err.message : String(err));
      res.status(503).json(storageErrorResponse({ error: 'chat-unavailable', detail: 'The message could not be saved, so it was not sent. Try again.' }, deps.config.stateDir));
      return;
    }
    // People and roles §3.3/§3.5: the sender is the phone's person. An MSP the owner let use Slack
    // speaks with its own name and its own registered Slack id (or a placeholder that resolves to
    // no one) — never the owner's Slack identity, so the Slack permission gate applies the MSP's
    // own standing, not the owner's.
    const sender = devicePersonOf(req);
    const ownerName = sender?.name ?? appOwnerName(deps.config);
    const mspSlackId = sender && sender.role !== 'owner' && sender.slackUserId && sender.slackUserId !== owner ? sender.slackUserId : null;
    const speakAs = !sender || sender.role === 'owner' ? owner : (mspSlackId ?? `app-msp:${sender.userId ?? 'unknown'}`);
    // The copy for the Slack history view (best-effort: the store above is the evidence).
    try { bridge.logAppMessage(conv, { messageId: `app-${messageId}`, text: stored.length > 0 ? mediaPreview(stored, delivered) : delivered, senderName: ownerName, ownerUserId: speakAs, eventId, deviceId }); } catch (err) {
      s.deps.reportDegradation?.('MobileSlack.log', err instanceof Error ? err.message : String(err));
    }
    const delivery = (state: 'delivered' | 'refused' | 'intercepted' | 'unknown'): void => {
      try { s.appendDelivery(conv.key, messageId, state, seed); } catch (err) { s.deps.reportDegradation?.('MobileSlack.delivery', err instanceof Error ? err.message : String(err)); }
    };
    const finish = (status: number, b: Record<string, unknown>): void => {
      if (!requests.finish(deviceId, requestId, { status, body: b })) s.deps.reportDegradation?.('MobileSlack.requestStore', 'could not record a finished request');
      res.status(status).json(b);
    };
    const mirror = async (): Promise<'sent' | 'failed'> => {
      try {
        // A copy for people reading the channel: credential-shaped spans always hidden (§4.9).
        if (stored.length > 0) await mirrorMediaToSlack(bridge, conv, ownerName, stored, hideCredentialSpans(delivered), (sha) => s.media.locateBlob(sha));
        else await bridge.post(conv, `📱 ${ownerName} (from the app): ${hideCredentialSpans(delivered)}`);
        return 'sent';
      } catch (err) {
        s.deps.reportDegradation?.('MobileSlack.mirror', err instanceof Error ? err.message : String(err));
        return 'failed';
      }
    };

    if (exactStop) {
      const stop = bridge.emergencyStop();
      delivery('intercepted');
      finish(200, { ok: true, outcome: 'sentinel-kill', stopped: stop.stopped, conversationId: id, eventId, messageId, deliveryState: 'intercepted', ...extras });
      return;
    }
    // Transcripts are classified with the caption, as in app conversations (§4.3).
    const classifiedText = [delivered, ...stored.map((a) => a.transcript ?? '')].filter(Boolean).join('\n');
    if (deps.sentinel && classifiedText) {
      try {
        const d = await deps.sentinel.decideInboundDisposition(classifiedText, id);
        if (d.disposition === 'kill' || d.disposition === 'pause') {
          const out = d.disposition === 'kill' ? { outcome: 'sentinel-kill', stopped: bridge.emergencyStop().stopped } : { outcome: 'sentinel-pause', paused: bridge.pause(conv) };
          delivery('intercepted');
          finish(200, { ok: true, ...out, conversationId: id, eventId, messageId, deliveryState: 'intercepted', ...extras });
          return;
        }
      } catch { /* @silent-fallback-ok — FAIL-OPEN: a classifier error routes the message normally, as on the Slack path */ }
    }

    // Files (chat-media §4.5): one line per file before the caption, with a server-chosen path to a
    // private copy (the blobs were just published on this machine).
    let sessionText = delivered;
    if (stored.length > 0) {
      const lines = await s.sessionLinesFor(conv.key, messageId, stored, delivered);
      sessionText = [...lines, ...(delivered ? [delivered] : [])].join('\n');
    }
    let outcome: 'delivered' | 'queued' | 'refused';
    try {
      outcome = await bridge.dispatch({ conv, text: sessionText, ownerName, ownerUserId: speakAs, messageId, originVerdict: s.verify(msg) });
    } catch (err) {
      delivery('unknown');
      requests.markUnknown(deviceId, requestId);
      s.deps.reportDegradation?.('MobileSlack.dispatch', err instanceof Error ? err.message : String(err));
      res.status(409).json({ error: 'outcome-unknown', eventId, messageId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    if (outcome === 'refused') {
      // Nothing was handed to a session: an honest refusal, not an unknown outcome. No mirror.
      delivery('refused');
      finish(503, { error: 'chat-unavailable', detail: 'Your message is saved, but this machine cannot start a session for it right now.', conversationId: id, eventId, messageId, deliveryState: 'refused', ...extras });
      return;
    }
    // A queued message (durable inbound custody) has no delivery event yet: it reads `pending`.
    if (outcome === 'delivered') delivery('delivered');
    const mirrored = await mirror();
    finish(200, { ok: true, outcome, conversationId: id, eventId, messageId, deliveryState: outcome === 'delivered' ? 'delivered' : 'pending', mirror: mirrored, ...extras });
  });

  return router;
}

// ── The production bridge ──────────────────────────────────────────────────────────────

/** The slice of SlackAdapter the bridge uses (a stub adapter satisfies it in tests). */
export interface SlackAdapterLike {
  getChannelMessages(channelId: string, limit?: number): Array<{ ts: string; user?: string; text: string; thread_ts?: string }>;
  getBotUserId?(): string | null;
  getLogPath(): string;
  logMessage(entry: { messageId: string; channelId: string; threadTs?: string | null; text: string; fromUser: boolean; senderName?: string; platformUserId?: string; eventId?: string; deviceId?: string }): void;
  sendToChannel(channelId: string, text: string, options?: { thread_ts?: string }): Promise<string>;
  /** Slack's v2 file upload (FileHandler.uploadFile), with the bot token the adapter already holds. */
  uploadFile?(channelId: string, filePath: string, title?: string, options?: { threadTs?: string; initialComment?: string; filename?: string }): Promise<void>;
  getSessionForChannel(routingKey: string): string | null;
  isAuthorized(userId: string): boolean;
  /** message-origin-all-platforms §3: the origin ledger every Slack send writes to first. */
  originLedger?: Pick<SlackOriginLedger, 'lookup'>;
}

/** The slice of ConversationRegistry the bridge uses. */
export interface SlackRegistryLike {
  resolve(id: number): unknown;
  list(opts?: { platform?: string; limit?: number }): Array<{ key: string; entry: { id: number; channelId: string; threadTs: string | null; origin: string; mintedAt: string; label?: string } }>;
}

export type SlackInboundDispatchFn = (message: import('../core/types.js').Message) => Promise<SlackDispatchOutcome | void>;

export interface MobileSlackBridgeDeps {
  adapter: SlackAdapterLike;
  registry: SlackRegistryLike;
  /** The server's Slack inbound dispatch (set when Slack starts); null until then. */
  dispatch: () => SlackInboundDispatchFn | null;
  /** Emergency stop: every running session (what a Slack stop does). */
  killAllSessions: () => boolean;
  /** Pause: Escape into one session. */
  sendEscape: (session: string) => void;
  holdsLease: () => boolean;
  now?: () => number;
}

/** Rows of slack-messages.jsonl read from its tail (bounded: the newest 5000 lines within 8 MiB). */
const LOG_TAIL_LINES = 5000;
const LOG_TAIL_BYTES = 8 * 1024 * 1024;

interface LogRow { messageId?: unknown; channelId?: unknown; threadTs?: unknown; text?: unknown; fromUser?: unknown; timestamp?: unknown; senderName?: unknown; eventId?: unknown }

function routingKeyOf(channelId: string, threadTs: string | null): string { return threadTs ? `${channelId}:${threadTs}` : channelId; }

/** Whether a Slack row (its own ts and thread ts) belongs to this conversation. */
function inConversation(conv: SlackAppConversation, ts: string, threadTs: string | null | undefined): boolean {
  if (conv.threadTs) return threadTs === conv.threadTs || ts === conv.threadTs;
  return !threadTs || threadTs === ts;
}

export function buildMobileSlackBridge(d: MobileSlackBridgeDeps): MobileSlackBridge {
  const now = d.now ?? Date.now;
  const tail = (): LogRow[] => {
    let lines: string[] = [];
    try {
      lines = readTail(d.adapter.getLogPath());
    } catch { lines = []; } // @silent-fallback-ok — a missing or unreadable log means no Slack rows; the store's rows remain
    const out: LogRow[] = [];
    for (const l of lines) { try { out.push(JSON.parse(l) as LogRow); } catch { /* @silent-fallback-ok — a torn line is skipped */ } }
    return out;
  };
  const toConv = (key: string, e: { id: number; channelId: string; threadTs: string | null; mintedAt: string; label?: string }): SlackAppConversation => ({
    id: e.id, key, channelId: e.channelId, threadTs: e.threadTs, label: e.label ?? null, mintedAt: e.mintedAt ?? null,
  });
  let activityCache: { at: number; map: Map<string, { at: string; preview: string }> } | null = null;

  return {
    resolve(id) {
      const r = d.registry.resolve(id) as { platform?: string; id?: number; key?: string; channelId?: string; threadTs?: string | null; origin?: string; label?: string } | null;
      if (!r || r.platform !== 'slack' || r.origin === 'replicated' || typeof r.key !== 'string' || typeof r.channelId !== 'string' || typeof r.id !== 'number') return null;
      // An alias resolves to its target; the app keeps using the id it was given.
      const listed = d.registry.list({ platform: 'slack', limit: 5000 }).find((x) => x.entry.id === r.id);
      return { id, key: r.key, channelId: r.channelId, threadTs: r.threadTs ?? null, label: r.label ?? null, mintedAt: listed?.entry.mintedAt ?? null };
    },
    conversations() {
      return d.registry.list({ platform: 'slack', limit: 500 })
        .filter((x) => x.entry.origin !== 'replicated')
        .map((x) => toConv(x.key, x.entry));
    },
    originOf(conv, ts) {
      return d.adapter.originLedger ? d.adapter.originLedger.lookup(conv.channelId, ts) : { missing: 'other-machine' };
    },
    history(conv, limit) {
      const out = new Map<string, SlackHistoryRow>();
      for (const row of tail()) {
        if (row.channelId !== conv.channelId) continue;
        const ts = String(row.messageId ?? '');
        if (!ts) continue;
        const threadTs = typeof row.threadTs === 'string' ? row.threadTs : null;
        // An app copy names its thread on the row; Slack rows written before increment 4 have no
        // thread field, so a thread conversation shows only rows that say they belong to it.
        if (!inConversation(conv, ts, threadTs)) continue;
        if (typeof row.text !== 'string' || typeof row.timestamp !== 'string') continue;
        out.set(ts, {
          ts, text: row.text, fromUser: row.fromUser === true, at: row.timestamp,
          senderName: typeof row.senderName === 'string' ? row.senderName : null,
          ...(typeof row.eventId === 'string' && row.eventId ? { eventId: row.eventId } : {}),
        });
      }
      // The in-memory ring adds what the API fetched after a restart (it includes the bot's own messages).
      const bot = d.adapter.getBotUserId?.() ?? null;
      try {
        for (const m of d.adapter.getChannelMessages(conv.channelId, 200)) {
          if (out.has(m.ts) || !inConversation(conv, m.ts, m.thread_ts ?? null)) continue;
          const secs = Number(m.ts);
          if (!Number.isFinite(secs)) continue;
          out.set(m.ts, { ts: m.ts, text: m.text, fromUser: !(bot && m.user === bot), at: new Date(secs * 1000).toISOString(), senderName: null });
        }
      } catch { /* @silent-fallback-ok — the log rows remain */ }
      return [...out.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-limit);
    },
    lastActivity() {
      if (activityCache && now() - activityCache.at < 10_000) return activityCache.map;
      const map = new Map<string, { at: string; preview: string }>();
      for (const row of tail()) {
        if (typeof row.channelId !== 'string' || typeof row.timestamp !== 'string' || typeof row.text !== 'string') continue;
        const ts = String(row.messageId ?? '');
        const threadTs = typeof row.threadTs === 'string' && row.threadTs !== ts ? row.threadTs : null;
        const k = routingKeyOf(row.channelId, threadTs);
        const cur = map.get(k);
        if (!cur || row.timestamp >= cur.at) map.set(k, { at: row.timestamp, preview: row.text.slice(0, 2048) }); // cut to 140 after paths are replaced (slackListRows)
      }
      activityCache = { at: now(), map };
      return map;
    },
    async dispatch(input) {
      const fn = d.dispatch();
      if (!fn) return 'refused';
      const ts = `app-${input.messageId}`;
      const r = await fn({
        id: ts, userId: input.ownerUserId, content: input.text,
        channel: { type: 'slack', identifier: input.conv.channelId },
        receivedAt: new Date(now()).toISOString(),
        metadata: {
          slackUserId: input.ownerUserId, senderName: input.ownerName, ts, channelId: input.conv.channelId,
          ...(input.conv.threadTs ? { threadTs: input.conv.threadTs } : {}),
          isDM: input.conv.channelId.startsWith('D'), appOrigin: input.originVerdict,
        },
      });
      return r ?? 'delivered';
    },
    async post(conv, text) {
      await d.adapter.sendToChannel(conv.channelId, text, conv.threadTs ? { thread_ts: conv.threadTs } : undefined);
    },
    ...(typeof d.adapter.uploadFile === 'function' ? {
      async uploadFile(conv: SlackAppConversation, filePath: string, opts: { filename: string; initialComment?: string }) {
        await d.adapter.uploadFile!(conv.channelId, filePath, opts.filename, {
          filename: opts.filename, ...(conv.threadTs ? { threadTs: conv.threadTs } : {}), ...(opts.initialComment ? { initialComment: opts.initialComment } : {}),
        });
      },
    } : {}),
    logAppMessage(conv, row) {
      d.adapter.logMessage({ messageId: row.messageId, channelId: conv.channelId, threadTs: conv.threadTs, text: row.text, fromUser: true, senderName: row.senderName, platformUserId: row.ownerUserId, eventId: row.eventId, deviceId: row.deviceId });
      activityCache = null;
    },
    emergencyStop() { return { stopped: d.killAllSessions() }; },
    pause(conv) {
      const session = d.adapter.getSessionForChannel(routingKeyOf(conv.channelId, conv.threadTs));
      if (!session) return false;
      try { d.sendEscape(session); return true; } catch { return false; } // @silent-fallback-ok — reported as paused:false
    },
    isAuthorized(userId) { return d.adapter.isAuthorized(userId); },
    holdsLease() { return d.holdsLease(); },
  };
}

function readTail(p: string): string[] { return readJsonlTailLastLines(p, LOG_TAIL_LINES, LOG_TAIL_BYTES); }

/** The unified-list rows for every local Slack conversation (§4.9). */
export function slackListRows(bridge: MobileSlackBridge): Array<{ id: number; title: string; lastActivity: string | null; lastPreview: string | null }> {
  const act = bridge.lastActivity();
  return bridge.conversations().map((c) => {
    const a = act.get(routingKeyOf(c.channelId, c.threadTs));
    return { id: c.id, title: slackConversationTitle(c), lastActivity: a?.at ?? c.mintedAt, lastPreview: a ? slackDeviceText(a.preview).slice(0, 140) : null };
  });
}

/**
 * Mirror an app-sent media message into its Slack channel or thread (chat-media §4.9): each file
 * goes up through Slack's v2 upload, the first carrying "📱 <owner> (from the app): <caption>"
 * beside it. A file whose blob is not on this machine is named in a text line instead. Throws on
 * the first failure; the route reports `mirror: "failed"` and never repeats the dispatch.
 */
export async function mirrorMediaToSlack(
  bridge: MobileSlackBridge, conv: SlackAppConversation, ownerName: string, attachments: ReadonlyArray<AppAttachment>, caption: string,
  locate: (sha256: string) => string | null,
): Promise<void> {
  if (typeof bridge.uploadFile !== 'function') throw new Error('this Slack adapter cannot upload files');
  const line = caption ? `📱 ${ownerName} (from the app): ${caption}` : `📱 ${ownerName} (from the app)`;
  let commented = false;
  const missing: string[] = [];
  for (const a of attachments) {
    const p = locate(a.sha256);
    if (!p) { missing.push(`📱 ${ownerName} sent ${displayName(a.filename)} (open it in the app)`); continue; }
    await bridge.uploadFile(conv, p, { filename: displayName(a.filename), ...(!commented ? { initialComment: line } : {}) });
    commented = true;
  }
  if (!commented) await bridge.post(conv, line);
  for (const m of missing) await bridge.post(conv, m);
}
