/**
 * Native app conversations — the device routes (docs/specs/mobile-native-conversations.md,
 * increment 1). Writes are device-signed only (a Bearer request gets 403); the three reads also
 * accept the agent's own Bearer token (so the agent can list and read). All behind
 * `mobilePairing.native.enabled` (dev-agent gated, read at boot; off ⇒ every route here 503s and
 * the Telegram chat route is unchanged).
 *
 *   POST   /mobile/conversations                     create   {title, requestId}
 *   GET    /mobile/conversations?cursor=&limit=      list (app conversations + Telegram topics + Slack conversations)
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
 * Origin (§4.6, increment 2): every app message is stored with the fields of its device
 * signature, the exact signed body (or, when an authority token was removed, only its hash plus
 * this machine's signed redaction attestation) and this machine's signed receipt. History and
 * sync responses carry `originVerified`, the verdict of verifyRecordedOrigin against this
 * machine's device-key ledger and signing-key history: verified / redacted / failed / unknown /
 * none. Only `verified` adds "📱 signed" to the session tag.
 */
import { DEFAULT_ORIGIN_DISPLAY } from '../messaging/telegram-origin/OriginPresentation.js';
import type { OriginDisplaySettings } from '../messaging/telegram-origin/types.js';
import { deviceOriginRow, validateDeviceOriginRow, type DeviceOriginRow } from '../messaging/messageOrigin.js';
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { InstarConfig } from '../core/types.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { deviceAdmittedAt, deviceAdmittedHost, deviceMayUse, devicePersonOf, isMobileChatEnabled } from './mobilePairingRoutes.js';
import { conversationOwnerFor, validConversationOwner, type ConversationOwner } from '../core/MobilePeople.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import { transcriptForDelivery } from '../core/AppConversationService.js';
import { requestIdAgeOk, requestIdTime, type ChatLookup } from '../core/MobileChatRequests.js';
import {
  cleanConversationTitle, derivedEventId, isAppConversationKey, newAppConversationKey, removeAuthorityTokens,
} from '../core/appConversationText.js';
import type { BrowsedMessage, DeviceSignedOrigin, MachineReceipt, MediaMessageEvent, MessageEvent } from '../core/AppConversationStore.js';
import { signReceipt, signRedaction, signRedactionV2, sha256Hex, type MachineSigner, type OriginVerdict } from '../core/AppRecordSignatures.js';
import {
  MAX_ATTACHMENTS, pushPreviewBody, type AppAttachment,
} from '../core/appMediaTypes.js';
import { detectOutboundCredential } from '../messaging/outbound-credential-guard.js';
import { isExactStopMessage } from '../core/MessageSentinel.js';
import { cleanText } from '../core/MobilePairing.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import type { RouteContext } from './routes.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import { deviceTextForRow } from '../core/appPlatformMedia.js';
import {
  checkSignedFiles, claimMediaUploads, mediaRecordTooLarge, preflightMediaAttachments, publishMediaMessage, signedFileHashParts,
  type SignedAttachment,
} from './mobileMediaSend.js';

/**
 * One row of the unified conversation list. The list order is total and the same on every
 * machine: newest `lastActivity` first (a missing one sorts last as ''), ties broken by the
 * row's sort key (`app:<uuid>`, `telegram:<topicId>` or `slack:<negative id>`), both compared as plain strings —
 * the order the store's SQLite keyset query uses — so one cursor can page every kind losslessly.
 */
export interface ConversationListRow {
  id: string | number;
  platform: 'app' | 'telegram' | 'slack';
  title: string | null;
  lastActivity: string | null;
  lastPreview: string | null;
  machine?: string | null;
  /** People and roles: an app conversation an MSP phone created (its person, machine-namespaced). */
  ownerPerson?: ConversationOwner | null;
}

export function conversationSortKey(r: Pick<ConversationListRow, 'id' | 'platform'>): string { return `${r.platform}:${r.id}`; }
const actOf = (r: ConversationListRow): string => r.lastActivity ?? '';
const strCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Descending list order (negative ⇒ a comes first). */
export function compareConversationRows(a: ConversationListRow, b: ConversationListRow): number {
  return strCmp(actOf(b), actOf(a)) || strCmp(conversationSortKey(b), conversationSortKey(a));
}

/** The list cursor `<activity>|<sortKey>` (the store's own cursor shape, extended to every kind). */
export function parseListCursor(cursor: string | null | undefined): { activity: string; key: string } | null {
  if (!cursor || !cursor.includes('|')) return null;
  const i = cursor.lastIndexOf('|');
  return { activity: cursor.slice(0, i), key: cursor.slice(i + 1) };
}
export function listCursorFor(r: ConversationListRow): string { return `${actOf(r)}|${conversationSortKey(r)}`; }
/** Strictly after the cursor in list order. */
export function isAfterListCursor(r: ConversationListRow, c: { activity: string; key: string } | null): boolean {
  if (!c) return true;
  const a = actOf(r);
  return a < c.activity || (a === c.activity && conversationSortKey(r) < c.key);
}

/**
 * Merge pages from several sources (each already strictly after the same cursor, sorted, and
 * complete up to its own `limit` rows) into one page. Lossless: any row of the true next page is
 * within its own source's first `limit` rows. Duplicates (the same conversation from two
 * machines) collapse to the newest copy, the earlier-listed source winning a tie.
 */
export function mergeConversationPages(
  sources: ReadonlyArray<{ rows: ReadonlyArray<ConversationListRow>; more: boolean }>, limit: number,
): { rows: ConversationListRow[]; nextCursor: string | null } {
  const best = new Map<string, ConversationListRow>();
  for (const s of sources) {
    for (const r of s.rows) {
      const k = conversationSortKey(r);
      const cur = best.get(k);
      if (!cur || actOf(r) > actOf(cur)) best.set(k, r);
    }
  }
  const merged = [...best.values()].sort(compareConversationRows);
  const page = merged.slice(0, limit);
  const more = merged.length > limit || sources.some((s) => s.more);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: more && last ? listCursorFor(last) : null };
}

/** A peer's list row, re-validated (peer output is untrusted display data). */
function sanitizePeerConversation(raw: unknown, machine: string): ConversationListRow | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const s = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
  // Normalised to strict ISO: a peer's odd value (e.g. "0") must never become the cursor that ends paging.
  const lastActivity = r.lastActivity === null || r.lastActivity === undefined ? null : strictIso(r.lastActivity);
  if (lastActivity === undefined) return null;
  if (r.platform === 'app' && isAppConversationKey(r.id)) {
    return { id: r.id, platform: 'app', title: s(r.title, 80), lastActivity, lastPreview: s(r.lastPreview, 140), machine, ownerPerson: validConversationOwner(r.ownerPerson) };
  }
  if (r.platform === 'telegram' && typeof r.id === 'number' && Number.isSafeInteger(r.id) && r.id > 0) {
    return { id: r.id, platform: 'telegram', title: s(r.title, 128), lastActivity, lastPreview: s(r.lastPreview, 140), machine };
  }
  // A Slack conversation's id is the peer's local durable id (mobile-native-conversations §4.9).
  if (r.platform === 'slack' && typeof r.id === 'number' && Number.isSafeInteger(r.id) && r.id < 0) {
    return { id: r.id, platform: 'slack', title: s(r.title, 96), lastActivity, lastPreview: s(r.lastPreview, 140), machine };
  }
  return null;
}

/** A peer's browse row, re-validated. Its verdict is never trusted (§4.8): recomputed or `unknown`. */
function sanitizePeerMessage(raw: unknown, machine: string, display?: OriginDisplaySettings): Record<string, unknown> | null {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  if (typeof m.eventId !== 'string' || !m.eventId || m.eventId.length > 80 || typeof m.messageId !== 'string' || m.messageId.length > 80) return null;
  if (m.role !== 'operator' && m.role !== 'agent') return null;
  const at = strictIso(m.at);
  if (typeof m.text !== 'string' || m.text.length > 8000 || at === undefined) return null;
  // A peer's attachment rows are never passed through: their files live on that machine (this
  // machine cannot serve them) and their fields are unchecked. The row says how many it had.
  const files = Array.isArray(m.attachments) ? Math.min(m.attachments.length, MAX_ATTACHMENTS) : 0;
  return {
    eventId: m.eventId, messageId: m.messageId, role: m.role, text: m.text, at,
    machineId: typeof m.machineId === 'string' ? m.machineId.slice(0, 80) : null,
    deliveryState: typeof m.deliveryState === 'string' && /^(pending|delivered|refused|intercepted|unknown)$/.test(m.deliveryState) ? m.deliveryState : 'unknown',
    originVerified: 'unknown', machine,
    ...(files > 0 ? { filesOnOtherMachine: files } : {}),
    ...(typeof m.senderName === 'string' && m.senderName.length > 0 ? { senderName: m.senderName.slice(0, 128) } : {}),
    ...(m.senderRole === 'owner' || m.senderRole === 'msp' || m.senderRole === 'team' ? { senderRole: m.senderRole } : {}),
    // A peer's origin row is re-checked; its display bits are replaced by this machine's (§4).
    ...(m.role === 'agent' && display ? { origin: validateDeviceOriginRow(m.origin, display) ?? deviceOriginRow(null, display, 'other-machine') } : {}),
  };
}

/** A strict ISO-8601 instant (`Date#toISOString`) from a string, or undefined when it is not one. */
function strictIso(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const POOL_TIMEOUT_MS = 5000;
const MAX_POOL_LIST_BYTES = 512 * 1024;
const MAX_POOL_BROWSE_BYTES = 2 * 1024 * 1024;
type PoolReadCtx = Pick<RouteContext, 'resolvePeerUrls' | 'recordRopeResult'> & { config: InstarConfig };

/** GET a peer's own (non-pool) read with the agent's Bearer token. A 404 is "nothing there", not a failure. */
async function fetchPeers<T>(
  ctx: PoolReadCtx, pathFor: string, maxBytes: number, take: (body: Record<string, unknown>, machineId: string) => T,
): Promise<{ results: T[]; failed: Array<{ machineId: string; reason: string }> }> {
  const results: T[] = [];
  const failed: Array<{ machineId: string; reason: string }> = [];
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  await Promise.all(peers.map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) { failed.push({ machineId: p.machineId, reason: 'peer-url-refused' }); return; }
    try {
      const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, pathFor, {
        headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(POOL_TIMEOUT_MS), redirect: 'manual',
      });
      if (r.status === 404) return;
      if (!r.ok) { failed.push({ machineId: p.machineId, reason: r.status === 503 ? 'off' : `http-${r.status}` }); return; }
      const text = await r.text();
      if (Buffer.byteLength(text) > maxBytes) { failed.push({ machineId: p.machineId, reason: 'too-large' }); return; }
      results.push(take(JSON.parse(text) as Record<string, unknown>, p.machineId));
    } catch (err) { // @silent-fallback-ok — a dark peer is a visible pool.failed row naming the machine
      failed.push({ machineId: p.machineId, reason: err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable' });
    }
  }));
  return { results, failed };
}

export interface MobileConversationRouteDeps {
  config: InstarConfig;
  pairing: MobilePairingService;
  /** Null when `mobilePairing.native.enabled` resolved off at boot. */
  service: AppConversationService | null;
  /** `mobilePairing.native.media.enabled`, resolved at boot. */
  mediaEnabled?: boolean;
  machineId: () => string;
  /** Telegram topics for the unified list (absent when Telegram is not configured). */
  telegramTopics?: () => Array<{ topicId: number; topicName: string | null; lastActivity: string | null; lastPreview: string | null }>;
  /**
   * Slack conversations for the unified list (§4.9). Absent when Slack is not configured; returns
   * null when Slack is configured but the operator's Slack user id is unset (rows withheld, and
   * the list says so with `slackOwnerUnset: true`).
   */
  slackConversations?: () => Array<{ id: number; title: string | null; lastActivity: string | null; lastPreview: string | null }> | null;
  /** The inbound classifier (pause / stop decisions after persist). */
  sentinel?: { decideInboundDisposition(message: string, topicId?: number): Promise<{ disposition: string }> } | null;
  /** The pool fan-out (`?scope=pool`, §4.8). Absent ⇒ a pool read is this machine alone. */
  pool?: PoolReadCtx | null;
  /** The agent's current origin display bits (message-origin-all-platforms §5). Absent ⇒ all on. */
  originDisplay?: () => OriginDisplaySettings;
  now?: () => number;
}

type Principal = { kind: 'device'; deviceId: string } | { kind: 'device-notify'; deviceId: string } | { kind: 'token' };
function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

const SEND_RATE_PER_MIN = 20;
const off = (res: Response) => res.status(503).json({ error: 'native-conversations-off', detail: 'App conversations are turned off on this agent.' });
const hashOf = (...parts: string[]) => crypto.createHash('sha256').update(parts.join('\n')).digest('hex');

/**
 * Attachment rows for the app: the stored fields plus the per-file byte fact (§4.13), and for a
 * voice note the stored server transcript (§4.5.1) as `serverTranscript`, marked unsigned: the
 * phone never saw it, so it is never `transcript` and never part of `originVerified`. Never a
 * server path.
 */
export function attachmentRows(attachments: ReadonlyArray<AppAttachment>, svc: AppConversationService): Array<Record<string, unknown>> {
  return attachments.map((a) => {
    const t = a.kind === 'voice' || a.declaredKind === 'voice' ? svc.store.transcriptFor(a.attachmentId) : null;
    return {
      ...a, ...svc.media.byteFact(a.sha256, a.attachmentId),
      ...(t ? { serverTranscript: { text: transcriptForDelivery(t.text), provider: t.provider, at: t.at, machineId: t.machineId, signed: false, ...(t.late ? { late: true } : {}) } } : {}),
    };
  });
}

/** History rows for the app: the stored fields plus the verdict (§4.6). */
/**
 * message-origin-all-platforms §4: what the phone gets on an agent row. A missing record is a claim
 * (`false`) only for an event this machine wrote; another machine's event may have lost its record
 * to an older peer, so it reads `null` (`other-machine`).
 */
export function agentOriginRow(m: Pick<BrowsedMessage, 'agentOrigin' | 'machineId'>, ctx: { display: OriginDisplaySettings; selfMachineId: string }): DeviceOriginRow {
  if (m.agentOrigin) return deviceOriginRow(m.agentOrigin, ctx.display);
  return deviceOriginRow(null, ctx.display, m.machineId === ctx.selfMachineId ? 'not-recorded' : 'other-machine');
}

export function historyRow(m: BrowsedMessage, verify: (m: BrowsedMessage) => OriginVerdict, svc?: AppConversationService,
  originCtx?: { display: OriginDisplaySettings; selfMachineId: string }): Record<string, unknown> {
  const verdict = verify(m);
  // How the signing phone was approved (§4.6 display: "approved on dashboard"), only with a good verdict.
  const approvedVia = svc ? svc.originApprovedVia(m, verdict) : null;
  return {
    eventId: m.eventId, messageId: m.messageId, role: m.role, text: m.text, at: m.at, machineId: m.machineId,
    deliveryState: m.deliveryState, originVerified: verdict, ...(approvedVia ? { originApprovedVia: approvedVia } : {}),
    // People and roles §3.3: who sent an operator message, as recorded when it was accepted.
    ...(m.senderName ? { senderName: m.senderName } : {}), ...(m.senderRole ? { senderRole: m.senderRole } : {}),
    ...(m.attachments && svc ? { attachments: attachmentRows(m.attachments, svc) } : {}),
    ...(m.role === 'agent' && originCtx ? { origin: agentOriginRow(m, originCtx) } : {}),
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

  /**
   * People and roles §3.4: the one shared conversation check. An MSP phone gets the same 404 a
   * missing conversation gets, so it cannot probe for the owner's conversation ids.
   */
  const allowed = (req: Request, res: Response, key: string): boolean => {
    if (deviceMayUse(deps.pairing, req, key)) return true;
    res.status(404).json({ error: 'unknown-conversation' });
    return false;
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
    // People and roles §3.4: a conversation an MSP phone creates is theirs (machine-namespaced).
    const creator = devicePersonOf(req);
    const ownerPerson = creator ? conversationOwnerFor(creator, deps.pairing.machineId()) : null;
    mutation(res, deviceId, body.requestId, hashOf('create', title),
      { op: 'create', conversationKey, title, ...(ownerPerson ? { ownerMachine: ownerPerson.machineId, ownerUser: ownerPerson.userId } : {}) },
      () => {
        if (creator?.role === 'team' && creator.userId) deps.pairing.confineOwnConversation(conversationKey, creator.userId);
        return svc!.applyCreate(deviceId, body.requestId as string, conversationKey, title, ownerPerson);
      });
  });

  // ── List ──
  /**
   * This machine's own page strictly after `cursor`: app conversations from the store (its keyset
   * cursor has the same shape and order) and every Telegram topic, merged on ONE cursor so paging
   * never drops a row of either kind.
   */
  const localListPage = (limit: number, cursor: string | null): { rows: ConversationListRow[]; more: boolean; slackOwnerUnset: boolean } => {
    const c = parseListCursor(cursor);
    const page = svc!.store.listConversations({ limit, cursor: c ? cursor : null });
    const appRows: ConversationListRow[] = page.conversations.map((x) => ({
      id: x.conversationKey, platform: 'app', title: x.title, lastActivity: x.lastActivity ?? x.createdAt, lastPreview: x.lastPreview,
      ...(x.ownerPerson ? { ownerPerson: x.ownerPerson } : {}),
    }));
    let tgRows: ConversationListRow[] = [];
    if (deps.telegramTopics) {
      try {
        tgRows = deps.telegramTopics()
          .map((t): ConversationListRow => ({ id: t.topicId, platform: 'telegram', title: t.topicName, lastActivity: t.lastActivity, lastPreview: t.lastPreview }))
          .filter((r) => isAfterListCursor(r, c));
      } catch { /* @silent-fallback-ok — a Telegram read failure leaves only the app rows; never an error for the app list */ }
    }
    let slackRows: ConversationListRow[] = [];
    let slackOwnerUnset = false;
    if (deps.slackConversations) {
      try {
        const list = deps.slackConversations();
        if (list === null) slackOwnerUnset = true;
        // A Slack id is this machine's own: every Slack row names the machine that serves it, and
        // the Slack routes refuse a request naming another machine (mobile-native-conversations §4.9).
        else slackRows = list
          .map((c): ConversationListRow => ({ id: c.id, platform: 'slack', title: c.title, lastActivity: c.lastActivity, lastPreview: c.lastPreview, machine: deps.machineId() }))
          .filter((r) => isAfterListCursor(r, c));
      } catch { /* @silent-fallback-ok — a Slack read failure leaves the other rows; never an error for the app list */ }
    }
    const merged = mergeConversationPages([{ rows: appRows, more: page.nextCursor !== null }, { rows: tgRows, more: false }, { rows: slackRows, more: false }], limit);
    return { rows: merged.rows, more: merged.nextCursor !== null, slackOwnerUnset };
  };

  router.get('/mobile/conversations', async (req: Request, res: Response) => {
    if (!readGate(req, res)) return;
    if (req.query.scope !== undefined && req.query.scope !== 'pool') { res.status(400).json({ error: 'invalid-scope' }); return; }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const local = localListPage(limit, cursor);
    const ownerNote = local.slackOwnerUnset && deviceMayUse(deps.pairing, req, 'slack:') ? { slackOwnerUnset: true } : {};
    // People and roles §3.4: an MSP phone sees Telegram topics and its own app conversations only
    // (filtered after the merge, so the cursor still advances over rows it does not see).
    const visible = (rows: ConversationListRow[]): ConversationListRow[] => rows.filter((r) => {
      if (r.platform === 'telegram') return deviceMayUse(deps.pairing, req, `telegram:${String(r.id)}`);
      if (r.platform === 'slack') return deviceMayUse(deps.pairing, req, 'slack:');
      return deviceMayUse(deps.pairing, req, String(r.id));
    });
    if (req.query.scope !== 'pool') {
      const m = mergeConversationPages([local], limit);
      res.json({ conversations: visible(m.rows), nextCursor: m.nextCursor, ...ownerNote });
      return;
    }
    // Pool read (§4.8): every answering machine's own page after the same cursor, merged on the
    // same order (lossless), duplicates collapsed; a dark machine is a `pool.failed` row.
    const self = deps.machineId();
    const q = `/mobile/conversations?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const peers = deps.pool
      ? await fetchPeers(deps.pool, q, MAX_POOL_LIST_BYTES, (body, machineId) => ({
        rows: (Array.isArray(body.conversations) ? body.conversations.slice(0, limit) : [])
          .map((r) => sanitizePeerConversation(r, machineId))
          .filter((r): r is ConversationListRow => r !== null && isAfterListCursor(r, parseListCursor(cursor))),
        more: typeof body.nextCursor === 'string' && body.nextCursor.length > 0,
      }))
      : { results: [], failed: [] };
    // A peer's Slack rows are never listed: a Slack conversation id is local to the machine that
    // minted it, and the Slack routes on this machine look ids up here, so a peer row could name a
    // different conversation that shares the number (and would otherwise collapse onto this
    // machine's row of the same id). Only this machine's own Slack rows are listed.
    const peerPages = peers.results.map((p) => ({ ...p, rows: p.rows.filter((r) => r.platform !== 'slack') }));
    const m = mergeConversationPages([{ rows: local.rows.map((r) => ({ ...r, machine: self })), more: local.more }, ...peerPages], limit);
    // A peer's app row is checked against THIS machine's copy of the conversation: one not
    // replicated here yet is not shown to an MSP phone (fail closed).
    res.json({ conversations: visible(m.rows), nextCursor: m.nextCursor, ...ownerNote, pool: { failed: peers.failed } });
  });

  // ── Rename ──
  router.patch('/mobile/conversations/:key', (req: Request, res: Response) => {
    const deviceId = gate(req, res); if (!deviceId) return;
    const key = String(req.params.key);
    if (!allowed(req, res, key)) return;
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
    if (!allowed(req, res, key)) return;
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
    if (!allowed(req, res, key)) return;
    const sender = devicePersonOf(req);
    const senderPerson = sender ? conversationOwnerFor(sender, deps.pairing.machineId()) : null;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!validRequestId(res, body.requestId)) return;
    const requestId = body.requestId;
    // Media (§4.3): a body with attachments creates a `media-message`. An exact emergency stop
    // never waits on its files: it is handled as the text it is and the uploads simply expire.
    const wantsMedia = body.attachments !== undefined && !isExactStopMessage(text);
    if (wantsMedia && !deps.mediaEnabled) { res.status(400).json({ error: 'media-off', detail: 'Files in app conversations are turned off on this agent.' }); return; }
    let signedFiles: SignedAttachment[] | null = null;
    if (wantsMedia) {
      const checked = checkSignedFiles(body.attachments);
      if ('status' in checked) { res.status(checked.status).json(checked.body); return; }
      signedFiles = checked.files;
    }
    if ((text.length < 1 && !wantsMedia) || text.length > 4000) { res.status(400).json({ error: 'text must be 1-4000 characters' }); return; }
    // The idempotency hash covers the text and each file's signed fields (§4.3).
    const hash = signedFiles ? hashOf('app-send', key, text, ...signedFileHashParts(signedFiles)) : hashOf('app-send', key, text);
    const seed = `${deviceId}\u0000${requestId}`;
    const messageId = derivedEventId('msg', seed);
    const eventId = derivedEventId('op', seed);

    // Step 2 — look up. Step 7 — a done/unknown request answers from the CURRENT delivery state.
    const prior = requests.lookup(deviceId, requestId, hash);
    if (prior.kind === 'done' || prior.kind === 'outcome-unknown') {
      featureEvidence.record('mobilePairing.native', { kind: 'held', reason: `duplicate send answered from record: ${prior.kind}`, context: { messageId, deviceId, priorKind: prior.kind } });
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

    // Media preflight (§4.3): every named upload must be this device's finished upload for this
    // conversation, with exactly the signed fields. Transcripts and filenames get the caption's
    // treatment, so a dictated code or a named invite never reaches a session or the store.
    const removedKinds = new Set<string>(removed.kinds);
    let uploadIds: string[] = [];
    let stored: AppAttachment[] = [];
    if (signedFiles) {
      const pre = preflightMediaAttachments(s, { deviceId, conversationRef: `app:${key}`, messageId, files: signedFiles, scanInbound: (t) => deps.pairing.scanInbound(t) });
      if (!pre.ok) { res.status(pre.status).json(pre.body); return; }
      uploadIds = pre.uploadIds;
      stored = pre.stored;
      for (const k of pre.removedKinds) removedKinds.add(k);
    }
    const classifiedText = [delivered, ...stored.map((a) => a.transcript ?? '')].filter(Boolean).join('\n');
    const credentialShaped = detectOutboundCredential([text, ...(signedFiles ?? []).map((a) => a.transcript ?? '')].join('\n')).detected;

    // `receivedAt` is when the device signature was accepted (the authenticator), so a request at
    // the edge of the 60 s window is judged by the same clock that admitted it.
    const t = deviceAdmittedAt(req) ?? now();
    const receivedAt = new Date(t).toISOString();
    const signed = buildSignedOrigin(req, deps.pairing, deviceId, delivered, [...removedKinds], s.deps.signer ?? null, receivedAt,
      (detail) => s.deps.reportDegradation?.('AppConversations.sign', detail), signedFiles ? stored : undefined);
    const base = {
      eventId, conversationKey: key, messageId, role: 'operator' as const, text: delivered,
      at: receivedAt, machineId: deps.machineId(), receivedAt,
      ...(signed.origin ? { origin: signed.origin } : {}), ...(signed.receipt ? { receipt: signed.receipt } : {}),
      // People and roles §3.3: who sent it, recorded at accept time.
      ...(sender ? { senderName: sender.name, senderRole: sender.role } : {}), ...(senderPerson ? { senderPerson } : {}),
    };
    const msg: MessageEvent | MediaMessageEvent = signedFiles ? { ...base, kind: 'media-message', attachments: stored } : { ...base, kind: 'message' };
    // §4.1: the record exactly as stored and as journaled must fit, before any upload is claimed.
    if (msg.kind === 'media-message' && mediaRecordTooLarge(msg, signed.origin, deps.machineId())) {
      res.status(413).json({ error: 'message-too-large', detail: 'This message is too long to store. Shorten the text or send fewer files.' });
      return;
    }

    // Step 4 — reserve, then persist the message with its signed origin (fsync) BEFORE dispatch.
    let r: ReturnType<typeof requests.reserve>;
    try { r = requests.reserve(deviceId, requestId, hash, 0, { op: 'send', conversationKey: key, messageId }); } catch {
      featureEvidence.record('mobilePairing.native', { kind: 'error', reason: 'loss: request could not be recorded', context: { messageId, deviceId } });
      res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be recorded, so it was not sent. Try again.' });
      return;
    }
    if (r.kind === 'full') { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (r.kind !== 'reserved') { answerLookup(res, r); return; }

    // Media (§4.3): claim every upload at once, make the bytes durable, and only then the event.
    if (msg.kind === 'media-message') {
      const refused = await claimMediaUploads(s, uploadIds, messageId, (detail) => s.deps.reportDegradation?.('AppMedia.publish', detail));
      if (refused) {
        featureEvidence.record('mobilePairing.native.media', { kind: 'error', reason: 'files could not be claimed for the message', context: { messageId, files: uploadIds.length, status: refused.status } });
        requests.release(deviceId, requestId); res.status(refused.status).json(refused.body); return;
      }
    }
    // Publish and append with no await between them (media review finding 1): nothing can remove
    // a blob after it is published and before the event that references it is stored.
    try {
      if (msg.kind === 'media-message') publishMediaMessage(s, uploadIds, msg);
      else s.store.append(msg);
    } catch (err) {
      requests.release(deviceId, requestId);
      s.deps.reportDegradation?.('AppConversations.persist', err instanceof Error ? err.message : String(err));
      featureEvidence.record('mobilePairing.native', { kind: 'error', reason: 'loss: message could not be saved', context: { messageId, deviceId, files: stored.length } });
      if (stored.length > 0) featureEvidence.record('mobilePairing.native.media', { kind: 'error', reason: 'files not published: message could not be saved', context: { messageId, files: stored.length } });
      res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be saved, so it was not sent. Try again.' });
      return;
    }
    for (const a of stored) {
      featureEvidence.record('mobilePairing.native.media', { kind: 'fired', reason: 'file sent', context: { messageId, index: a.index, fileKind: a.kind, declaredKind: a.declaredKind, size: a.size, files: stored.length } });
    }
    const reclassified = stored.filter((a) => a.kind !== a.declaredKind).map((a) => a.index);
    const extras = {
      ...(removedKinds.size > 0 ? { redacted: true, removed: [...removedKinds] } : {}),
      ...(credentialShaped ? { credentialShaped: true } : {}),
      ...(reclassified.length > 0 ? { reclassified } : {}),
    };
    const finish = (status: number, b: Record<string, unknown>): void => {
      if (!requests.finish(deviceId, requestId, { status, body: b })) s.deps.reportDegradation?.('AppConversations.requestStore', 'could not record a finished request');
      res.status(status).json(b);
    };

    if (exactStop) {
      const stop = s.emergencyStop(key, sender?.role === 'team' ? 'conversation' : undefined);
      s.appendDelivery(key, messageId, 'intercepted', seed);
      featureEvidence.record('mobilePairing.native', { kind: 'held', reason: 'intercepted: exact emergency stop', context: { messageId, deviceId, stopped: typeof stop.stopped === 'number' ? stop.stopped : null } });
      finish(200, { ok: true, outcome: 'sentinel-kill', stopped: stop.stopped, conversationKey: key, eventId, messageId, deliveryState: 'intercepted', ...extras });
      return;
    }

    // Step 5 — ownership (pool dark: the serving-lease holder), the pause intercept, dispatch.
    const alias = s.deps.registry.appAliasFor(key) ?? (() => { const m = s.deps.registry.mintAppAlias(key); return m.ok ? m.id : null; })();
    if (alias === null || !s.isOwner()) {
      featureEvidence.record('mobilePairing.native', { kind: 'error', reason: 'saved, not delivered: owner unavailable', context: { messageId, deviceId, aliasMinted: alias !== null } });
      finish(503, { error: 'owner-unavailable', detail: 'Your message is saved, but the machine that runs this conversation is not available right now. Try again shortly.', conversationKey: key, eventId, messageId, ...extras });
      return;
    }
    try { if (!s.deps.registry.isAppBound(alias)) s.deps.registry.bindApp(alias); } catch (err) {
      // The message is already saved; a failed binding write must not leave the request hanging.
      requests.markUnknown(deviceId, requestId);
      s.deps.reportDegradation?.('AppConversations.bind', err instanceof Error ? err.message : String(err));
      featureEvidence.record('mobilePairing.native', { kind: 'error', reason: 'outcome unknown: binding write failed', context: { messageId, deviceId, alias } });
      res.status(409).json({ error: 'outcome-unknown', eventId, messageId, detail: 'This message is saved but may not have reached the agent. Check the conversation.' });
      return;
    }
    if (deps.sentinel && classifiedText) {
      try {
        const d = await deps.sentinel.decideInboundDisposition(classifiedText, alias);
        if (d.disposition === 'kill' || d.disposition === 'pause') {
          const out = d.disposition === 'kill' ? { outcome: 'sentinel-kill', stopped: s.emergencyStop(key, sender?.role === 'team' ? 'conversation' : undefined).stopped } : { outcome: 'sentinel-pause', paused: s.pause(key) };
          s.appendDelivery(key, messageId, 'intercepted', seed);
          featureEvidence.record('mobilePairing.native', { kind: 'held', reason: `intercepted: sentinel ${d.disposition}`, context: { messageId, deviceId, disposition: d.disposition } });
          finish(200, { ok: true, ...out, conversationKey: key, eventId, messageId, deliveryState: 'intercepted', ...extras });
          return;
        }
      } catch { /* @silent-fallback-ok — FAIL-OPEN: a classifier error routes the message normally, as on the Telegram path */ }
    }
    const dispatch = s.deps.dispatch();
    if (!dispatch) {
      // Nothing was dispatched: an honest refusal, not an unknown outcome.
      s.appendDelivery(key, messageId, 'refused', seed);
      featureEvidence.record('mobilePairing.native', { kind: 'error', reason: 'saved, not delivered: no dispatcher on this machine', context: { messageId, deviceId } });
      finish(503, { error: 'chat-unavailable', detail: 'Your message is saved, but a session can\'t start for it right now.', conversationKey: key, eventId, messageId, deliveryState: 'refused', ...extras });
      return;
    }
    // §4.5: one line per file before the caption, with a server-chosen path to a private copy.
    // §4.12: a file not on this machine is pulled first (≤ 60 s), else "[file still copying: …]"
    // and one "[file now available: …]" line follows when it lands.
    let sessionText = delivered;
    if (stored.length > 0) {
      const lines = await s.sessionLinesFor(key, messageId, stored, delivered);
      sessionText = [...lines, ...(delivered ? [delivered] : [])].join('\n');
    }
    const pending = s.pendingContext(key);
    let outcome: 'delivered' | 'refused';
    let originVerdict: OriginVerdict = 'unknown';
    try {
      originVerdict = s.verify(msg);
      outcome = await dispatch({ conversationKey: key, alias, title: conv.title ?? 'Untitled', text: sessionText, messageId, ownerName: sender?.name ?? s.ownerName(), memoryPersonId: sender && sender.role !== 'owner' ? sender.userId : null, originVerdict, ...(pending.lines.length > 0 ? { notes: pending.lines } : {}) });
      if (outcome === 'delivered') pending.ack();
    } catch (err) {
      try { s.appendDelivery(key, messageId, 'unknown', seed); } catch { /* @silent-fallback-ok — the request itself is recorded outcome-unknown below */ }
      requests.markUnknown(deviceId, requestId);
      s.deps.reportDegradation?.('AppConversations.dispatch', err instanceof Error ? err.message : String(err));
      featureEvidence.record('mobilePairing.native', { kind: 'error', reason: 'outcome unknown: dispatch threw', context: { messageId, deviceId, originVerdict, files: stored.length } });
      res.status(409).json({ error: 'outcome-unknown', eventId, messageId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    s.appendDelivery(key, messageId, outcome, seed);
    featureEvidence.record('mobilePairing.native', { kind: outcome === 'delivered' && originVerdict !== 'failed' ? 'fired' : 'error', reason: originVerdict === 'failed' ? `failed verdict on a message: ${outcome}` : `message ${outcome}`, context: { messageId, deviceId, outcome, originVerdict, files: stored.length, redacted: removedKinds.size > 0, senderRole: sender?.role ?? null } });
    finish(200, { ok: true, outcome, conversationKey: key, eventId, messageId, deliveryState: outcome, ...extras });
  });

  // ── Browse ──
  router.get('/mobile/chat/app/:key/messages', async (req: Request, res: Response) => {
    if (!readGate(req, res)) return;
    if (req.query.scope !== undefined && req.query.scope !== 'pool') { res.status(400).json({ error: 'invalid-scope' }); return; }
    const key = String(req.params.key);
    if (!allowed(req, res, key)) return;
    const pool = req.query.scope === 'pool';
    const live = svc!.liveConversation(key);
    // §4.8: a pool read also covers what has not replicated here yet, so a conversation this
    // machine has never seen is read from the peers. One it knows is deleted stays a 404.
    const unseenHere = isAppConversationKey(key) && !svc!.store.getConversation(key);
    if (!live && !(pool && unseenHere)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 100));
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const page = live ? svc!.store.browseMessages(key, before, limit) : { messages: [], nextBefore: null };
    const display = deps.originDisplay?.() ?? { ...DEFAULT_ORIGIN_DISPLAY };
    const originCtx = { display, selfMachineId: deps.machineId() };
    const rows = page.messages.map((m) => historyRow(m, (x) => svc!.verify({ ...x, conversationKey: key }), svc!, originCtx));
    if (!pool) { res.json({ conversationKey: key, messages: rows, nextBefore: page.nextBefore }); return; }
    // Pool read (§4.5/§4.8): each machine's page before the same boundary, merged by eventId
    // (this machine's row wins). A row only a peer holds is not yet replicated here, so this
    // machine cannot check it: `originVerified: "unknown"`, never the peer's verdict. Never
    // advances a sync cursor.
    const self = deps.machineId();
    const b = before ? before.split(',') : null;
    const isBefore = (at: string, eventId: string) => !b || b.length !== 2 || at < b[0]! || (at === b[0] && eventId < b[1]!);
    const q = `/mobile/chat/app/${encodeURIComponent(key)}/messages?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const peers = deps.pool
      ? await fetchPeers(deps.pool, q, MAX_POOL_BROWSE_BYTES, (body, machineId) => ({
        rows: (Array.isArray(body.messages) ? body.messages.slice(0, limit) : [])
          .map((r) => sanitizePeerMessage(r, machineId, display))
          .filter((r): r is Record<string, unknown> => r !== null && isBefore(String(r.at), String(r.eventId))),
        more: typeof body.nextBefore === 'string' && body.nextBefore.length > 0,
      }))
      : { results: [], failed: [] };
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) byId.set(String(r.eventId), { ...r, machine: self });
    for (const p of peers.results) for (const r of p.rows) {
      const mine = byId.get(String(r.eventId));
      if (!mine) { byId.set(String(r.eventId), r); continue; }
      // §4: on a collision this machine's row wins, except that a peer's recorded origin fills in one this machine cannot tell.
      const mineOrigin = mine.origin as { recorded?: unknown } | undefined, theirs = r.origin as { recorded?: unknown } | undefined;
      if (mineOrigin && mineOrigin.recorded !== true && theirs?.recorded === true) mine.origin = theirs;
    }
    // Not on this machine and no peer has it either: still unknown (unless a machine did not answer).
    if (!live && peers.results.length === 0 && peers.failed.length === 0) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const desc = [...byId.values()].sort((x, y) => strCmp(String(y.at), String(x.at)) || strCmp(String(y.eventId), String(x.eventId)));
    const pageRows = desc.slice(0, limit);
    const more = desc.length > limit || page.nextBefore !== null || peers.results.some((p) => p.more);
    const oldest = pageRows[pageRows.length - 1];
    res.json({
      conversationKey: key, messages: pageRows.reverse(),
      nextBefore: more && oldest ? `${String(oldest.at)},${String(oldest.eventId)}` : null, pool: { failed: peers.failed },
    });
  });

  // ── Reply notification preview (chat-media spec §4.11) ──
  // The phone's notification extension asks for the text to show; Apple only ever carries
  // "New reply". Open to the device, its notification read token, or the agent's token.
  router.get('/mobile/chat/app/:key/preview/:messageId', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !svc) { off(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device' && p.kind !== 'device-notify' && p.kind !== 'token') { res.status(403).json({ error: 'device-required' }); return; }
    const key = String(req.params.key);
    const messageId = String(req.params.messageId);
    if (!isAppConversationKey(key) || !/^[a-z0-9._:-]{1,128}$/.test(messageId)) { res.status(400).json({ error: 'bad-request' }); return; }
    if (!deviceMayUse(deps.pairing, req, key)) { res.status(404).json({ error: 'not-found' }); return; }
    // A deleted conversation, or a reply not replicated to this machine yet: the phone keeps the generic text.
    const ev = svc.liveConversation(key) ? svc.store.getMessageEvent(key, messageId) : null;
    const m = ev as unknown as { role?: string; text?: unknown; attachments?: AppAttachment[] } | null;
    if (!m || m.role !== 'agent') { res.status(404).json({ error: 'not-found' }); return; }
    const name = deps.config.projectName ?? 'agent';
    res.json({ title: name.charAt(0).toUpperCase() + name.slice(1), body: pushPreviewBody(m.attachments ?? [], typeof m.text === 'string' ? m.text : '') });
  });

  // ── Sync ──
  router.get('/mobile/chat/app/:key/events', (req: Request, res: Response) => {
    if (!readGate(req, res)) return;
    const key = String(req.params.key);
    if (!allowed(req, res, key)) return;
    if (!isAppConversationKey(key) || !svc!.store.getConversation(key)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 100));
    const page = svc!.store.syncEvents(key, typeof req.query.cursor === 'string' ? req.query.cursor : null, limit);
    res.json({
      conversationKey: key,
      events: page.events.map((e) => {
        const { origin: _origin, receipt: _receipt, ingestSeq: _seq, ...rest } = e as typeof e & { origin?: DeviceSignedOrigin; receipt?: MachineReceipt };
        return {
          ...rest,
          ...(e.kind === 'message' || e.kind === 'media-message' ? (() => {
            const verdict = svc!.verify(e);
            const via = svc!.originApprovedVia(e, verdict);
            return { originVerified: verdict, ...(via ? { originApprovedVia: via } : {}) };
          })() : {}),
          ...(e.kind === 'media-message' ? { attachments: attachmentRows(e.attachments, svc!) } : {}),
          // A server transcript is scrubbed on read too (a peer may have stored it unscrubbed).
          ...(e.kind === 'transcript' ? { text: transcriptForDelivery(e.text) } : {}),
        };
      }),
      cursor: page.cursor,
    });
  });

  return router;
}

/**
 * The signed-origin fields of this request (§4.6) from the device record and the raw request,
 * plus this machine's receipt and (when tokens were removed) its redaction attestation. For a
 * redacted message the original signed body is NOT stored anywhere — only its hash.
 *
 * With no machine signer (no identity on this machine) the origin is still stored without a
 * receipt, so the message reads `unknown`, never `verified`; the gap is reported.
 */
export function buildSignedOrigin(
  req: Request, pairing: MobilePairingService, deviceId: string, storedText: string, removedKinds: ReadonlyArray<string>,
  signer: MachineSigner | null, receivedAt: string, report?: (detail: string) => void,
  attachments?: ReadonlyArray<AppAttachment>,
  /** Slack (§4.9): the canonical key the message is stored under, signed into a v2 receipt. */
  receiptConversationKey?: string,
): { origin?: DeviceSignedOrigin; receipt?: MachineReceipt } {
  const dev = pairing.devices.get(deviceId);
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const time = req.headers['x-instar-device-time'];
  const sig = req.headers['x-instar-device-sig'];
  if (!dev?.publicKey || !dev.host || typeof time !== 'string' || typeof sig !== 'string') return {};
  let keyHash: string;
  try { keyHash = crypto.createHash('sha256').update(Buffer.from(dev.publicKey, 'base64url')).digest('hex'); } catch { return {}; } // @silent-fallback-ok — an unreadable key stores no origin (history reads 'none')
  const bodySha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const base = {
    // E2E-PAIRING: EXEMPT — no route added or changed; the stored Host is exercised end to end through the
    // production authenticator in tests/integration/mobile-multi-route.test.ts, and tests/e2e/mobile-native-conversations-alive.test.ts
    // still asserts `verified` on the paired route.
    // The Host the signature was actually verified against (another of this machine's names over
    // multi-route), so the stored record re-verifies; the paired host only when none was recorded.
    kind: 'device-signed' as const, v: 1 as const, deviceId, keyHash, publicKey: dev.publicKey, host: deviceAdmittedHost(req) ?? dev.host,
    method: req.method.toUpperCase(), pathWithQuery: req.originalUrl, timeMs: time, bodySha256, sig,
  };
  const redacted = removedKinds.length > 0;
  let origin: DeviceSignedOrigin;
  let receipt: MachineReceipt | undefined;
  try {
    origin = redacted
      ? { ...base, redaction: signer
        ? (attachments ? signRedactionV2(signer, bodySha256, storedText, [...removedKinds], attachments) : signRedaction(signer, bodySha256, storedText, [...removedKinds]))
        : { ...(attachments ? { v: 2 as const } : {}), kinds: [...removedKinds], machineId: 'unsigned' } }
      : { ...base, bodyB64: raw.toString('base64') };
    if (signer) receipt = signReceipt(signer, base, receivedAt, receiptConversationKey);
  } catch (err) {
    // @silent-fallback-ok — reported; the message is still stored and delivered, and reads `unknown`
    report?.(`this machine could not sign the receipt (${err instanceof Error ? err.message : String(err)}); the message reads "couldn't check"`);
    origin = redacted ? { ...base, redaction: { ...(attachments ? { v: 2 as const } : {}), kinds: [...removedKinds], machineId: 'unsigned' } } : { ...base, bodyB64: raw.toString('base64') };
    receipt = undefined;
  }
  if (!signer) report?.('this machine has no identity key, so app messages are stored without a machine receipt and read "couldn\'t check"');
  return { origin, ...(receipt ? { receipt } : {}) };
}

/** Owner name: `threadline.ownerName`, else "Operator" (§4.2). */
export function appOwnerName(config: InstarConfig): string {
  return cleanText(config.threadline?.ownerName) || 'Operator';
}

/**
 * The Telegram history join (§4.9), for a DEVICE reading GET /telegram/topics/:id/messages: each
 * row that carries an `eventId` is joined to the app conversation store (`telegram:<topicId>`) and
 * gets `originVerified` computed there; a row whose store event is missing reads `unknown`; a row
 * with no eventId (typed in Telegram itself) reads `none`. App-sent messages whose Telegram row
 * has rotated away are returned from the store, merged by eventId. Never throws.
 */
export function joinTelegramHistory(
  app: AppConversationService, topicId: number, rows: ReadonlyArray<Record<string, unknown>>, limit: number,
): Array<Record<string, unknown>> {
  const key = `telegram:${topicId}`;
  const out: Array<Record<string, unknown>> = rows.map((row) => {
    const eventId = typeof row.eventId === 'string' && row.eventId ? row.eventId : null;
    if (!eventId) return { ...row, originVerified: 'none' };
    let ev: ReturnType<AppConversationService['store']['getEvent']> = null;
    try { ev = app.store.getEvent(key, eventId); } catch { ev = null; } // @silent-fallback-ok — an unreadable store row reads "couldn't check"
    if (!ev || (ev.kind !== 'message' && ev.kind !== 'media-message')) return { ...row, originVerified: 'unknown' };
    // The app's "Delivered" mark reads this; without it an app-sent message looked unsent.
    let deliveryState: string | null = null;
    try { deliveryState = typeof ev.messageId === 'string' ? app.store.deliveryState(ev.messageId) : null; } catch { deliveryState = null; } // @silent-fallback-ok — no mark rather than a wrong one
    const delivered = deliveryState ? { deliveryState } : {};
    if (ev.kind === 'media-message') {
      // Files sent from the app (chat-media §4.9): the Telegram row holds the session's text
      // (file lines with server paths, then the caption). The device gets the STORED caption and
      // the attachments instead, so the verdict covers exactly what it shows and no path leaks.
      const verdict = app.verify(ev);
      const via = app.originApprovedVia(ev, verdict);
      return { ...row, ...delivered, text: ev.text, attachments: attachmentRows(ev.attachments, app), originVerified: verdict, ...(via ? { originApprovedVia: via } : {}) };
    }
    // The verdict covers the STORED text; a Telegram row showing different text gets no verdict.
    if (typeof row.text === 'string' && row.text !== ev.text) return { ...row, ...delivered, originVerified: 'unknown' };
    const verdict = app.verify(ev);
    const via = app.originApprovedVia(ev, verdict);
    return { ...row, ...delivered, originVerified: verdict, ...(via ? { originApprovedVia: via } : {}) };
  });
  const seen = new Set(out.map((r) => (typeof r.eventId === 'string' ? r.eventId : '')).filter(Boolean));
  let stored: BrowsedMessage[] = [];
  try { stored = app.store.browseMessages(key, null, Math.max(1, Math.min(100, limit))).messages; } catch { stored = []; } // @silent-fallback-ok — the Telegram rows are still returned
  for (const m of stored) {
    // A message refused before it reached the agent, or still in flight, is not Telegram history.
    if (seen.has(m.eventId) || m.role !== 'operator' || (m.deliveryState !== 'delivered' && m.deliveryState !== 'intercepted' && m.deliveryState !== 'unknown')) continue;
    out.push({ deliveryState: m.deliveryState,
      messageId: null, topicId, text: m.text, fromUser: m.role === 'operator', timestamp: m.at, sessionName: null,
      via: 'mobile-device', eventId: m.eventId, fromStore: true,
      ...(m.attachments ? { attachments: attachmentRows(m.attachments, app) } : {}),
      ...(() => {
        const rec = { ...m, conversationKey: key };
        const verdict = app.verify(rec);
        const via = app.originApprovedVia(rec, verdict);
        return { originVerified: verdict, ...(via ? { originApprovedVia: via } : {}) };
      })(),
    });
  }
  return out.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-limit);
}

/**
 * Telegram media for a DEVICE's history read (media spec §4.9): a row whose Telegram message id
 * has a `platform-media` event gets that event's `attachments` (the app history row shape), and
 * EVERY row's text has its server paths replaced (`[photo]`, `[file: <name>]`, `[voice note]`), so
 * a device never sees a server path, with or without a recorded event. Never throws.
 */
export function withTelegramMediaForDevice(
  app: AppConversationService | null, topicId: number, rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const key = `telegram:${topicId}`;
  return rows.map((row) => {
    let attachments: AppAttachment[] | null = null;
    const pmid = typeof row.messageId === 'number' || (typeof row.messageId === 'string' && row.messageId) ? String(row.messageId) : null;
    if (app && pmid && row.fromUser === true && !row.fromStore) {
      try { attachments = app.store.getPlatformMedia(key, pmid)?.attachments ?? null; } catch { attachments = null; } // @silent-fallback-ok — the row is still returned, path-free, without attachments
    }
    const text = typeof row.text === 'string' ? deviceTextForRow(row.text, attachments) : row.text;
    return { ...row, text, ...(attachments && app ? { attachments: attachmentRows(attachments, app) } : {}) };
  });
}

