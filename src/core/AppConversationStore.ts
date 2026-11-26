/**
 * AppConversationStore — the conversation store of docs/specs/mobile-native-conversations.md §4.5.
 *
 * SOURCE OF TRUTH: one append-only JSONL file per conversation,
 * `<stateDir>/app-conversations/<sha256(canonical key)>.jsonl`, never rotated. Every row is an
 * immutable event with its own `eventId` (the merge and de-duplication key):
 *   created  {title}                          label {title, setAt}          tombstone {}
 *   message  {messageId, role, text, origin?, receivedAt?, receipt?}
 *   delivery {messageId, state}
 *   media-message {…message fields, attachments}      purge {attachmentIds}
 *   platform-media {messageId, platformMessageId, attachments}
 *     (§4.9: files that arrived in a Telegram topic or Slack conversation, copied into the blob
 *     store; the reference that authorizes downloads and drives pulls. Never a chat message.)
 *     (docs/specs/mobile-native-chat-media.md §4.1, §4.7: a new kind on purpose, so a version that
 *     does not know it refuses the event instead of storing a message with no files)
 * plus, on each row, this machine's `ingestSeq` for that file (a replicated row gets the next
 * local seq when it lands, so a local feed never skips a late arrival).
 *
 * DURABILITY: a row is a commit only when the line is written and the file fsynced; the first
 * write to a new file also fsyncs the directory. Callers persist BEFORE dispatching (§4.2 step 4),
 * so a torn final line (a write cut short by a crash) was never dispatched: on load it is
 * truncated back to the last newline and reported once. Earlier lines are never touched.
 *
 * INDEX: `app-conversations/index.sqlite` (WAL + busy_timeout, the PendingRelayStore pattern) is
 * derived state. Every append updates it right after the file commit; at boot any file indexed
 * short of its size is caught up from its last indexed offset, and a missing or corrupt index is
 * rebuilt from the files. Reads go through the index (byte offset + length per event), so a read
 * never scans a whole file.
 *
 * RETENTION: kept until the operator deletes the conversation (a `tombstone` event); the file then
 * moves to `app-conversations/deleted/` and is kept, never destroyed by this feature.
 */
import { validateMessageOriginEvidence, type MessageOriginEvidence } from '../messaging/messageOrigin.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { canonicalConversationKey, cleanConversationTitle, derivedEventId, isAppConversationKey } from './appConversationText.js';
import { type AppAttachment, validateAttachments, MAX_PURGE_BATCH, mediaPreview } from './appMediaTypes.js';
import { validConversationOwner, type ConversationOwner } from './MobilePeople.js';
import type { ReceiptSignature, StoredReplyReference } from './AppRecordSignatures.js';
import { isReaderKey } from './ConversationReadMarkers.js';
import type { AccessStamp } from './TeamAccessMerge.js';
import { compareCreatedEvidence, creationBaseDigest, creationContextDigest, validateAppCreationContext, type AppCreationContext } from './AppCreationContext.js';

export type AppEventKind = 'created' | 'label' | 'tombstone' | 'message' | 'delivery' | 'media-message' | 'purge' | 'platform-media' | 'transcript' | 'pin' | 'reaction' | 'message-removed';
export type DeliveryEventState = 'delivered' | 'refused' | 'intercepted' | 'unknown';
export type ReducedDeliveryState = DeliveryEventState | 'pending';

/** The signed-origin fields of spec §4.6 (the machine receipt rides beside it on the message). */
export interface DeviceSignedOrigin {
  kind: 'device-signed';
  v: 1;
  deviceId: string;
  keyHash: string;
  publicKey: string;
  host: string;
  method: string;
  pathWithQuery: string;
  timeMs: string;
  /** The exact signed request body (base64); absent when an authority token was removed. */
  bodyB64?: string;
  bodySha256: string;
  sig: string;
  /**
   * Present only when redacted: the accepting machine's identity-key signature over
   * (bodySha256, sha256(stored text), kinds) — the removed token itself is never stored.
   */
  redaction?: { v?: 1 | 2; kinds: string[]; machineId: string; signerKeyHash?: string; sig?: string };
}

/** The accepting machine's receipt (§4.6): its signature over (sha256(canonical request), receivedAt, machineId). */
export type MachineReceipt = ReceiptSignature;

export interface AppEventBase {
  eventId: string;
  kind: AppEventKind;
  /** The conversation key (bare UUID for a native conversation). */
  conversationKey: string;
  at: string;
  machineId: string;
}
/**
 * `ownerPerson` (people and roles §3.4): set when an MSP phone created the conversation, namespaced
 * by the machine whose user registry the id belongs to. Absent ⇒ the owner's conversation.
 */
export interface CreatedEvent extends AppEventBase { kind: 'created'; title: string; ownerPerson?: ConversationOwner; creationContext?: AppCreationContext }
export interface LabelEvent extends AppEventBase { kind: 'label'; title: string; setAt: string }
export interface TombstoneEvent extends AppEventBase { kind: 'tombstone' }
export interface MessageEvent extends AppEventBase {
  kind: 'message';
  messageId: string;
  role: 'operator' | 'agent';
  text: string;
  origin?: DeviceSignedOrigin;
  receivedAt?: string;
  receipt?: MachineReceipt;
  replyTo?: StoredReplyReference;
  forwarded?: true;
  forwardBinding?: string;
  /**
   * People and roles §3.3: who sent an operator message, recorded at accept time. Absent on older
   * events, which were necessarily sent by an owner phone (no other kind existed).
   */
  senderName?: string;
  senderRole?: 'owner' | 'msp' | 'team';
  senderPerson?: ConversationOwner;
  /**
   * message-origin-all-platforms §3: which machine, harness and model wrote an AGENT reply,
   * recorded in the same append as the reply. Information only; nothing decides on it.
   */
  agentOrigin?: MessageOriginEvidence;
  /**
   * Work Board §2: set ONLY by the server-side append of a `Work board:` line, never accepted from a
   * request body. An older build's validator drops it and falls back to the line's own prefix.
   * `work-board-note` (agent-work-cards-default §2): the agent's progress note, written through the notes route.
   */
  systemSource?: 'work-board' | 'work-board-note';
  /** agent-work-cards-default §2: the binding of the session that wrote a `work-board-note` (audit only; never authority). */
  writerBinding?: string;
  /** team-roles-and-access, "Step 2b": what lets any machine judge who may read this. Absent on older events, which every grant opens. */
  accessStamp?: AccessStamp;
}
export interface DeliveryEvent extends AppEventBase { kind: 'delivery'; messageId: string; state: DeliveryEventState }
/** A message with files (media spec §4.1): every field of `message` plus 1-10 attachments. */
export interface MediaMessageEvent extends Omit<MessageEvent, 'kind'> { kind: 'media-message'; attachments: AppAttachment[] }
/** The operator's permanent removal of these exact attachments' bytes (media spec §4.7). */
export interface PurgeEvent extends AppEventBase { kind: 'purge'; attachmentIds: string[] }
/**
 * Files that arrived in a Telegram topic or Slack conversation (media spec §4.9), copied into the
 * blob store. `messageId` is derived from the platform message id (so the same platform message
 * appends once); it is NOT a chat message: browse, previews and delivery states ignore it.
 */
export interface PlatformMediaEvent extends AppEventBase { kind: 'platform-media'; messageId: string; platformMessageId: string; attachments: AppAttachment[] }
/**
 * A server-made transcript of one voice attachment (media spec §4.5.1): machine-produced and
 * UNSIGNED (the phone never saw it), so it is its own event and never part of the signed
 * `media-message`. `late` marks a transcript that finished after the 60 s dispatch deadline.
 */
export interface TranscriptEvent extends AppEventBase { kind: 'transcript'; messageId: string; attachmentId: string; text: string; provider: string; late?: true }
/**
 * A pin or unpin of one message (docs/specs/conversation-pinned-messages.md). Never a chat message:
 * the target is `pinnedMessageId` (not `messageId`), so no message reader treats it as one. Per
 * (conversation, pinnedMessageId) the greatest (at, machineId, eventId) wins, in any arrival order.
 */
export interface PinEvent extends AppEventBase {
  kind: 'pin';
  pinnedMessageId: string;
  pinState: 'pinned' | 'unpinned';
  pinnedBy: { name: string; role: PinnedByRole };
  /** The pinned message's text as the pinning machine saw it (first 200 characters, paths removed). */
  preview?: string;
  source: 'app' | 'telegram';
}
export type PinnedByRole = 'owner' | 'msp' | 'team' | 'telegram';
export const APP_REACTION_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;
export type AppReactionEmoji = typeof APP_REACTION_EMOJI[number];
export function isAppReactionEmoji(value: unknown): value is AppReactionEmoji {
  return APP_REACTION_EMOJI.some((emoji) => emoji === value);
}
export interface ReactionEvent extends AppEventBase {
  kind: 'reaction';
  reactionTarget: string;
  reactionActor: string;
  reactionEmoji: AppReactionEmoji | null;
  reactionRevision: number;
}

export interface MessageRemovedEvent extends AppEventBase {
  kind: 'message-removed';
  targetEventId: string;
  targetMessageId: string;
}

export type AppEvent = CreatedEvent | LabelEvent | TombstoneEvent | MessageEvent | DeliveryEvent | MediaMessageEvent | PurgeEvent | PlatformMediaEvent | TranscriptEvent | PinEvent | ReactionEvent | MessageRemovedEvent;

/** The id of a pinned message: an app message id, a Telegram message id, or a Slack ts. */
export const PIN_MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const PIN_PREVIEW_CHARS = 200;
/** At most this many messages are pinned in one conversation (a further pin is refused). */
export const MAX_PINS_PER_CONVERSATION = 100;

/** One pinned message as the reads return it. */
export interface PinnedMessage {
  messageId: string;
  pinnedAt: string;
  pinnedBy: { name: string; role: PinnedByRole };
  preview: string | null;
  source: 'app' | 'telegram';
  eventId: string;
  machineId: string;
}

/** Whether a pin event beats the current winner for its message (the one order every machine uses). */
export function pinEventWins(next: { at: string; machineId: string; eventId: string }, cur: { at: string; machineId: string; eventId: string } | null | undefined): boolean {
  if (!cur) return true;
  if (next.at !== cur.at) return next.at > cur.at;
  if (next.machineId !== cur.machineId) return next.machineId > cur.machineId;
  return next.eventId > cur.eventId;
}

/** A transcript event's id: one per attachment per machine (the index picks one winner, §4.5.1). */
export function transcriptEventId(attachmentId: string, machineId: string): string {
  return derivedEventId('tr', attachmentId, machineId);
}
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** A platform conversation's canonical key (the same shapes the purge route accepts). */
/**
 * A Slack key is the conversation registry's canonical key: `slack:<team>:<channel>[:<thread>]`,
 * where `<team>` is a workspace id or `_` (the registry's unknown-workspace placeholder, which a
 * mint uses until the workspace is known), `<channel>` a `C`/`D`/`G` id and `<thread>` a Slack ts.
 */
export const PLATFORM_CONVERSATION_KEY_RE = /^(telegram:\d+|slack:(_|[A-Za-z0-9]+):[A-Za-z0-9]+(:[0-9.]+)?)$/;

/** The stable message id (and event id) of the platform-media event for one platform message. */
export function platformMediaMessageId(conversationKey: string, platformMessageId: string): string {
  return derivedEventId('pm', canonicalConversationKey(conversationKey), platformMessageId);
}
export type StoredAppEvent = AppEvent & { ingestSeq: number };

export interface ConversationSummary {
  conversationKey: string;
  canonicalKey: string;
  title: string | null;
  createdAt: string | null;
  lastActivity: string | null;
  lastPreview: string | null;
  tombstoned: boolean;
  /** People and roles: the MSP who created it; null ⇒ the owner's conversation. */
  ownerPerson: ConversationOwner | null;
}

export interface BrowsedMessage {
  eventId: string;
  messageId: string;
  role: 'operator' | 'agent';
  text: string;
  at: string;
  machineId: string;
  deliveryState: ReducedDeliveryState;
  origin?: DeviceSignedOrigin;
  receivedAt?: string;
  receipt?: MachineReceipt;
  replyTo?: StoredReplyReference;
  forwarded?: true;
  attachments?: AppAttachment[];
  senderName?: string;
  senderRole?: 'owner' | 'msp' | 'team';
  /** Unread (mobile-unread-messages §3.4): the sender's registry person, so a count can tell a reader's own rows. */
  senderPerson?: ConversationOwner;
  agentOrigin?: MessageOriginEvidence;
  /** Work Board §2: this line was written by the work board, not by the agent; `work-board-note` is the agent's own progress note (agent-work-cards-default §2). */
  systemSource?: 'work-board' | 'work-board-note';
  writerBinding?: string;
  accessStamp?: AccessStamp;
}

/** One attachment reference as the index holds it. */
export interface MediaRef {
  attachmentId: string; sha256: string; size: number; canonicalKey: string; messageId: string; idx: number; purged: boolean; tombstoned: boolean;
}

export const MAX_STORED_TEXT = 16_000;
const PREVIEW_CHARS = 140;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_REMOVAL_HISTORY_PROOFS = 64;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (canonicalKey TEXT PRIMARY KEY, fileName TEXT NOT NULL, indexedBytes INTEGER NOT NULL, nextIngestSeq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (canonicalKey TEXT NOT NULL, ingestSeq INTEGER NOT NULL, eventId TEXT NOT NULL, messageId TEXT, kind TEXT NOT NULL, at TEXT NOT NULL, machineId TEXT NOT NULL, byteOffset INTEGER NOT NULL, byteLength INTEGER NOT NULL, PRIMARY KEY (canonicalKey, eventId))`,
  `CREATE INDEX IF NOT EXISTS events_seq ON events(canonicalKey, ingestSeq)`,
  `CREATE INDEX IF NOT EXISTS events_at ON events(canonicalKey, at, eventId)`,
  `CREATE TABLE IF NOT EXISTS messages (messageId TEXT PRIMARY KEY, canonicalKey TEXT NOT NULL, eventId TEXT NOT NULL, at TEXT NOT NULL, deliveryState TEXT NOT NULL, lastPreview TEXT, forwarded INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS messages_at ON messages(canonicalKey, at, eventId)`,
  `CREATE TABLE IF NOT EXISTS deliveries (eventId TEXT PRIMARY KEY, messageId TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, machineId TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS deliveries_msg ON deliveries(messageId)`,
  `CREATE TABLE IF NOT EXISTS conversations (canonicalKey TEXT PRIMARY KEY, conversationKey TEXT NOT NULL, title TEXT, titleAt TEXT, titleMachine TEXT, createdAt TEXT, lastActivity TEXT, lastPreview TEXT, tombstoned INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS conversations_activity ON conversations(tombstoned, lastActivity)`,
  // Media references (media spec §4.7): kept incrementally as events are indexed, tombstoned or
  // purged, so agent usage is one row read, never a rescan. `liveRefs` counts references from
  // unpurged attachments of live conversations; `allRefs` also counts deleted conversations.
  `CREATE TABLE IF NOT EXISTS media_refs (attachmentId TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, canonicalKey TEXT NOT NULL, messageId TEXT NOT NULL, idx INTEGER NOT NULL, purged INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS media_refs_sha ON media_refs(sha256)`,
  `CREATE INDEX IF NOT EXISTS media_refs_conv ON media_refs(canonicalKey)`,
  `CREATE TABLE IF NOT EXISTS media_blobs (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, liveRefs INTEGER NOT NULL DEFAULT 0, allRefs INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS media_purged (attachmentId TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS media_totals (id INTEGER PRIMARY KEY CHECK (id = 1), liveBytes INTEGER NOT NULL DEFAULT 0)`,
  // Server transcripts (media spec §4.5.1): the one winning transcript event per attachment.
  `CREATE TABLE IF NOT EXISTS transcripts (attachmentId TEXT PRIMARY KEY, canonicalKey TEXT NOT NULL, eventId TEXT NOT NULL, at TEXT NOT NULL, machineId TEXT NOT NULL)`,
  // Pinned messages (conversation-pinned-messages): the winning pin event per message.
  `CREATE TABLE IF NOT EXISTS pins (canonicalKey TEXT NOT NULL, pinnedMessageId TEXT NOT NULL, eventId TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, machineId TEXT NOT NULL, PRIMARY KEY (canonicalKey, pinnedMessageId))`,
  `CREATE TABLE IF NOT EXISTS reactions (canonicalKey TEXT NOT NULL, target TEXT NOT NULL, actor TEXT NOT NULL, revision INTEGER NOT NULL, eventId TEXT NOT NULL, emoji TEXT, PRIMARY KEY(canonicalKey, target, actor, revision, eventId), FOREIGN KEY(canonicalKey, eventId) REFERENCES events(canonicalKey, eventId) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS message_removals (canonicalKey TEXT NOT NULL, targetEventId TEXT NOT NULL, targetMessageId TEXT NOT NULL, machineId TEXT NOT NULL, eventId TEXT NOT NULL, PRIMARY KEY(canonicalKey, targetEventId, targetMessageId, machineId, eventId), FOREIGN KEY(canonicalKey, eventId) REFERENCES events(canonicalKey, eventId) ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS message_removals_event ON message_removals(canonicalKey, eventId)`,
  `CREATE INDEX IF NOT EXISTS pins_state ON pins(canonicalKey, state, at)`,
];

/**
 * Deterministic delivery reduction (§4.5): a definite state (`delivered`, `refused`,
 * `intercepted`) beats `unknown`; among definite states the latest `(at, machineId)` wins;
 * no events means `pending`. Independent of arrival order.
 */
export function reduceDeliveryState(events: ReadonlyArray<{ state: string; at: string; machineId: string }>): ReducedDeliveryState {
  let best: { state: string; at: string; machineId: string } | null = null;
  let sawUnknown = false;
  for (const e of events) {
    if (e.state === 'unknown') { sawUnknown = true; continue; }
    if (e.state !== 'delivered' && e.state !== 'refused' && e.state !== 'intercepted') continue;
    if (!best || e.at > best.at || (e.at === best.at && e.machineId > best.machineId)) best = e;
  }
  if (best) return best.state as ReducedDeliveryState;
  return sawUnknown ? 'unknown' : 'pending';
}

/** Validate (and normalize) one event from an untrusted source (a file line or a replica). */
export function validateAppEvent(raw: unknown): AppEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const eventId = str(r.eventId, 128);
  const conversationKey = str(r.conversationKey, 256);
  const at = str(r.at, 64);
  const machineId = str(r.machineId, 256);
  if (!eventId || !conversationKey || !at || Number.isNaN(Date.parse(at)) || !machineId) return null;
  const base = { eventId, conversationKey, at, machineId };
  switch (r.kind) {
    case 'created': {
      const title = cleanConversationTitle(r.title);
      if (!title) return null;
      const ownerPerson = validConversationOwner(r.ownerPerson);
      const creationContext = r.creationContext === undefined ? undefined : validateAppCreationContext(r.creationContext);
      if (creationContext === null) return null;
      return { ...base, kind: 'created', title, ...(ownerPerson ? { ownerPerson } : {}), ...(creationContext ? { creationContext } : {}) };
    }
    case 'label': {
      const title = cleanConversationTitle(r.title);
      const setAt = str(r.setAt, 64);
      return title && setAt && !Number.isNaN(Date.parse(setAt)) ? { ...base, kind: 'label', title, setAt } : null;
    }
    case 'tombstone':
      return { ...base, kind: 'tombstone' };
    case 'message':
    case 'media-message': {
      const messageId = str(r.messageId, 128);
      const text = typeof r.text === 'string' && r.text.length <= MAX_STORED_TEXT ? r.text : null;
      if (!messageId || text === null || (r.role !== 'operator' && r.role !== 'agent')) return null;
      const common = { ...base, messageId, role: r.role, text } as const;
      let out: MessageEvent | MediaMessageEvent;
      if (r.kind === 'media-message') {
        const attachments = validateAttachments(r.attachments, messageId);
        if (!attachments) return null;
        out = { ...common, kind: 'media-message', attachments };
      } else {
        out = { ...common, kind: 'message' };
      }
      const origin = validateOrigin(r.origin);
      if (origin) out.origin = origin;
      const receivedAt = str(r.receivedAt, 64);
      if (receivedAt) out.receivedAt = receivedAt;
      const receipt = validateReceipt(r.receipt);
      if (receipt) out.receipt = receipt;
      const replyTo = validateReplyReference(r.replyTo);
      if (replyTo) out.replyTo = replyTo;
      if (r.forwarded !== undefined || r.forwardBinding !== undefined) {
        if (r.kind !== 'message' || r.role !== 'operator' || r.forwarded !== true
          || typeof r.forwardBinding !== 'string' || !/^[a-f0-9]{64}$/.test(r.forwardBinding)
          || ['origin', 'receipt', 'replyTo', 'attachments', 'systemSource', 'agentOrigin'].some((field) => r[field] !== undefined)) return null;
        out.forwarded = true;
        out.forwardBinding = r.forwardBinding;
      }
      const accessStamp = validateAccessStamp(r.accessStamp);
      if (accessStamp) out.accessStamp = accessStamp;
      const senderName = typeof r.senderName === 'string' && r.senderName.length > 0 && r.senderName.length <= 128 ? r.senderName : null;
      if (senderName) out.senderName = senderName;
      if (r.senderRole === 'owner' || r.senderRole === 'msp' || r.senderRole === 'team') out.senderRole = r.senderRole;
      const senderPerson = validConversationOwner(r.senderPerson);
      if (senderPerson) out.senderPerson = senderPerson;
      // Only an agent reply carries origin, only a valid one, and only one recorded by the machine
      // that wrote the event (a peer cannot attach another machine's identity to it).
      if (r.role === 'agent' && r.agentOrigin !== undefined) {
        const agentOrigin = validateMessageOriginEvidence(r.agentOrigin);
        if (agentOrigin && agentOrigin.machineId === machineId) out.agentOrigin = agentOrigin;
      }
      // Work Board §2: a server-written card line, or (agent-work-cards-default §2) the agent's progress note. Only on an
      // agent-role plain message; any other value is dropped. An older build drops `work-board-note` and keeps the line.
      if (r.role === 'agent' && r.kind === 'message' && (r.systemSource === 'work-board' || r.systemSource === 'work-board-note')) {
        (out as MessageEvent).systemSource = r.systemSource;
        if (r.systemSource === 'work-board-note') { const wb = str(r.writerBinding, 200); if (wb) (out as MessageEvent).writerBinding = wb; }
      }
      return out;
    }
    case 'delivery': {
      const messageId = str(r.messageId, 128);
      const s = r.state;
      if (!messageId || (s !== 'delivered' && s !== 'refused' && s !== 'intercepted' && s !== 'unknown')) return null;
      return { ...base, kind: 'delivery', messageId, state: s };
    }
    case 'platform-media': {
      const messageId = str(r.messageId, 128);
      const platformMessageId = typeof r.platformMessageId === 'string' && /^[0-9A-Za-z._:-]{1,64}$/.test(r.platformMessageId) ? r.platformMessageId : null;
      // The event id IS the message id, so a media reference resolves to its event by one lookup.
      if (!messageId || messageId !== eventId || !platformMessageId || !PLATFORM_CONVERSATION_KEY_RE.test(conversationKey)) return null;
      const attachments = validateAttachments(r.attachments, messageId);
      return attachments ? { ...base, kind: 'platform-media', messageId, platformMessageId, attachments } : null;
    }
    case 'transcript': {
      const messageId = str(r.messageId, 128);
      const attachmentId = typeof r.attachmentId === 'string' && /^[0-9a-f]{64}$/.test(r.attachmentId) ? r.attachmentId : null;
      const text = typeof r.text === 'string' && r.text.length <= MAX_STORED_TEXT ? r.text : null;
      const provider = typeof r.provider === 'string' && PROVIDER_RE.test(r.provider) ? r.provider : null;
      if (!messageId || !attachmentId || text === null || !provider) return null;
      if (r.late !== undefined && r.late !== true) return null;
      return { ...base, kind: 'transcript', messageId, attachmentId, text, provider, ...(r.late === true ? { late: true as const } : {}) };
    }
    case 'message-removed': {
      const targetEventId = str(r.targetEventId, 128);
      const targetMessageId = str(r.targetMessageId, 128);
      if (!isAppConversationKey(conversationKey) || !targetEventId || !targetMessageId || targetEventId === eventId
        || [eventId, targetEventId, targetMessageId, machineId].some((id) => /[\x00-\x1f\x7f]/.test(id))) return null;
      return { ...base, kind: 'message-removed', targetEventId, targetMessageId };
    }
    case 'reaction': {
      const reactionTarget = str(r.reactionTarget, 128);
      if (!reactionTarget || /[\x00-\x1f\x7f]/.test(reactionTarget) || !isReaderKey(r.reactionActor)
        || (r.reactionEmoji !== null && !isAppReactionEmoji(r.reactionEmoji))
        || typeof r.reactionRevision !== 'number' || !Number.isSafeInteger(r.reactionRevision) || r.reactionRevision < 1) return null;
      return { ...base, kind: 'reaction', reactionTarget, reactionActor: r.reactionActor,
        reactionEmoji: r.reactionEmoji, reactionRevision: r.reactionRevision };
    }
    case 'pin': {
      const pinnedMessageId = typeof r.pinnedMessageId === 'string' && PIN_MESSAGE_ID_RE.test(r.pinnedMessageId) ? r.pinnedMessageId : null;
      const pinState = r.pinState === 'pinned' || r.pinState === 'unpinned' ? r.pinState : null;
      const by = r.pinnedBy as Record<string, unknown> | undefined;
      const name = by && typeof by.name === 'string' && by.name.length > 0 && by.name.length <= 128 ? by.name : null;
      const role = by && (by.role === 'owner' || by.role === 'msp' || by.role === 'team' || by.role === 'telegram') ? by.role : null;
      const source = r.source === 'app' || r.source === 'telegram' ? r.source : null;
      if (!pinnedMessageId || !pinState || !name || !role || !source) return null;
      // The winner is picked by comparing `at` as text, so only the one exact UTC form is accepted.
      if (new Date(at).toISOString() !== at) return null;
      if (r.preview !== undefined && (typeof r.preview !== 'string' || r.preview.length > PIN_PREVIEW_CHARS)) return null;
      return {
        ...base, kind: 'pin', pinnedMessageId, pinState, pinnedBy: { name, role }, source,
        ...(typeof r.preview === 'string' && r.preview ? { preview: r.preview } : {}),
      };
    }
    case 'purge': {
      const ids = r.attachmentIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PURGE_BATCH) return null;
      if (!ids.every((i) => typeof i === 'string' && /^[0-9a-f]{64}$/.test(i))) return null;
      return { ...base, kind: 'purge', attachmentIds: [...ids] as string[] };
    }
    default:
      return null;
  }
}

function validateOrigin(raw: unknown): DeviceSignedOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
  const f = {
    deviceId: s(o.deviceId, 128), keyHash: s(o.keyHash, 128), publicKey: s(o.publicKey, 256), host: s(o.host, 256),
    method: s(o.method, 16), pathWithQuery: s(o.pathWithQuery, 2048), timeMs: s(o.timeMs, 32),
    bodySha256: s(o.bodySha256, 128), sig: s(o.sig, 512),
  };
  if (o.kind !== 'device-signed' || o.v !== 1 || Object.values(f).some((v) => v === null)) return undefined;
  const out: DeviceSignedOrigin = { kind: 'device-signed', v: 1, ...(f as Record<keyof typeof f, string>) };
  const body = s(o.bodyB64, 64 * 1024);
  if (body) out.bodyB64 = body;
  if (o.redaction && typeof o.redaction === 'object') {
    const rd = o.redaction as Record<string, unknown>;
    const kinds = Array.isArray(rd.kinds) ? rd.kinds.filter((k): k is string => typeof k === 'string' && k.length <= 32).slice(0, 8) : [];
    const machineId = s(rd.machineId, 256);
    if (machineId) {
      out.redaction = { ...(rd.v === 1 || rd.v === 2 ? { v: rd.v } : {}), kinds, machineId };
      const signerKeyHash = s(rd.signerKeyHash, 64);
      const sig = s(rd.sig, 512);
      if (signerKeyHash && sig) { out.redaction.signerKeyHash = signerKeyHash; out.redaction.sig = sig; }
    }
  }
  return out;
}

function validateReplyReference(raw: unknown): StoredReplyReference | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { conversationKey, eventId, messageId } = raw as Record<string, unknown>;
  if (typeof conversationKey !== 'string' || !conversationKey || conversationKey.length > 256
    || (eventId !== null && (typeof eventId !== 'string' || !eventId || eventId.length > 128))
    || typeof messageId !== 'string' || !messageId || messageId.length > 128) return undefined;
  return { conversationKey, eventId, messageId };
}

function validateReceipt(raw: unknown): MachineReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const machineId = s(o.machineId, 256);
  const signerKeyHash = s(o.signerKeyHash, 64);
  const sig = s(o.sig, 512);
  if (!machineId || !signerKeyHash || !sig) return undefined;
  // A v2 receipt (§4.9) also signs the canonical conversation key; both fields travel together.
  if (o.v === 2) {
    const conversationKey = s(o.conversationKey, 256);
    return conversationKey ? { machineId, signerKeyHash, sig, v: 2, conversationKey } : undefined;
  }
  if (o.v === 3) {
    const conversationKey = s(o.conversationKey, 256);
    const eventId = s(o.eventId, 128);
    const messageId = s(o.messageId, 128);
    const replyTo = o.replyTo === null ? null : validateReplyReference(o.replyTo);
    return conversationKey && eventId && messageId && replyTo !== undefined
      ? { machineId, signerKeyHash, sig, v: 3, conversationKey, eventId, messageId, replyTo } : undefined;
  }
  return o.v === undefined || o.v === 1 ? { machineId, signerKeyHash, sig } : undefined;
}

/** The line a conversation list shows for a message. */
export function messagePreview(m: { text: string; attachments?: AppAttachment[] }): string {
  return (m.attachments ? mediaPreview(m.attachments, m.text) : m.text.replace(/\s+/g, ' ').trim()).slice(0, PREVIEW_CHARS);
}

export interface AccessStamps {
  stamp(event: MessageEvent | MediaMessageEvent): AccessStamp | null;
  saw(stamp: AccessStamp): void;
}

function validateAccessStamp(raw: unknown): AccessStamp | null {
  const r = raw as { origin?: unknown; incarnation?: unknown; seq?: unknown; access?: unknown } | null;
  if (r === undefined) return null;
  // A stamp that cannot be read is held from every reader, never taken as no stamp at all.
  const bad = { origin: 'unreadable', incarnation: 'unreadable', seq: Number.MAX_SAFE_INTEGER, access: {} };
  if (!r || typeof r !== 'object') return bad;
  if (typeof r.origin !== 'string' || typeof r.incarnation !== 'string' || !Number.isSafeInteger(r.seq) || (r.seq as number) < 1) return bad;
  if (!r.access || typeof r.access !== 'object' || Object.values(r.access).some((v) => typeof v !== 'number')) return bad;
  return { origin: r.origin, incarnation: r.incarnation, seq: r.seq as number, access: r.access as Record<string, number> };
}

export interface AppConversationStoreOptions {
  stateDir: string;
  machineId: () => string;
  now?: () => number;
  /** One report per problem (torn tail, index rebuild, a skipped unreadable line). */
  reportDegradation?: (what: string, detail: string) => void;
  /** Called after a LOCAL-origin append committed (the replication emit hook). Never for a replicated ingest. */
  onLocalAppend?: (event: AppEvent) => void;
}

interface CreatedEvidenceBase {
  event: CreatedEvent;
  contexts: Map<string, AppCreationContext>;
}

export class AppConversationStore {
  readonly dir: string;
  private readonly deletedDir: string;
  private db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly reported = new Set<string>();
  private onLocalAppend: ((event: AppEvent) => void) | undefined;
  private readonly appendListeners = new Set<(event: AppEvent, how: { replicated: boolean }) => void>();
  private stamps: AccessStamps | null = null;
  // Durable observations retain conflicting/complete copies before event-id suppression.
  // Retention: append-only alongside the canonical conversation files; no automatic expiry.
  private readonly creationEvidence = new Map<string, Map<string, Map<string, CreatedEvidenceBase>>>();
  private creationEvidenceUnreadable = false;
  private creationVersion = 0;
  private lastDataVersion = 0;
  private evidenceDataVersion = 0;
  private removalIndexProof: string | null = null;
  private readonly removalHistoryProofs = new Map<string, string>();
  private readonly removalJournalRevisions = new Map<string, { checkpoint: string; revision: string }>();
  private indexedPlainMessageWrites = 0;
  private removalHistoryPreparation: { key: string; result: Promise<boolean> } | null = null;

  constructor(private readonly opts: AppConversationStoreOptions) {
    this.dir = path.join(opts.stateDir, 'app-conversations');
    this.deletedDir = path.join(this.dir, 'deleted');
    this.now = opts.now ?? Date.now;
    this.onLocalAppend = opts.onLocalAppend;
    fs.mkdirSync(this.deletedDir, { recursive: true, mode: 0o700 });
    this.db = this.openIndex();
    registerSqliteHandle(() => { try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ } });
    this.loadCreationEvidence();
    this.evidenceDataVersion = Number(this.db.pragma('data_version', { simple: true }));
    this.catchUp();
  }

  setReplicationHook(hook: ((event: AppEvent) => void) | undefined): void { this.onLocalAppend = hook; }

  /**
   * Observe every event that newly COMMITTED here, local or replicated (never a de-duplicated
   * replay). Separate from the single replication hook, so an observer can never displace it.
   * A listener's failure is contained: the commit already landed. Returns an unsubscribe.
   */
  addAppendListener(fn: (event: AppEvent, how: { replicated: boolean }) => void): () => void {
    this.appendListeners.add(fn);
    return () => { this.appendListeners.delete(fn); };
  }

  private notifyAppended(event: AppEvent, replicated: boolean): void {
    for (const fn of this.appendListeners) {
      try { fn(event, { replicated }); } catch (err) {
        this.reportOnce('append-listener', `an observer of new conversation events failed (${err instanceof Error ? err.message : String(err)}); the event itself was stored`);
      }
    }
  }

  // ── Index lifecycle ───────────────────────────────────────────────────────────────────

  private indexPath(): string { return path.join(this.dir, 'index.sqlite'); }

  private openIndex(): BetterSqliteDatabase {
    const open = (): BetterSqliteDatabase => {
      const db = new Database(this.indexPath()); /* state-registry: app-conversations */
      try { fs.chmodSync(this.indexPath(), 0o600); } catch { /* @silent-fallback-ok — mode bits are best-effort on some filesystems */ }
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 5000');
      for (const ddl of SCHEMA) db.exec(ddl);
      // People and roles: the conversation's MSP owner (added in place; an index built before this
      // column existed held only owner conversations, so NULL is the truthful value for its rows).
      const cols = new Set((db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!cols.has('ownerMachine')) db.exec('ALTER TABLE conversations ADD COLUMN ownerMachine TEXT');
      if (!cols.has('ownerUser')) db.exec('ALTER TABLE conversations ADD COLUMN ownerUser TEXT');
      if (!cols.has('creationRecord')) db.exec('ALTER TABLE conversations ADD COLUMN creationRecord TEXT');
      const messageCols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      if (!messageCols.some((c) => c.name === 'forwarded')) db.exec('ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0');
      const ok = db.pragma('quick_check', { simple: true });
      if (ok !== 'ok') throw new Error(`index quick_check: ${String(ok)}`);
      return db;
    };
    try {
      return open();
    } catch (err) {
      // A corrupt index is derived state: set it aside and rebuild from the files.
      this.reportOnce('index-rebuild', `the conversation index could not be opened (${err instanceof Error ? err.message : String(err)}); it was set aside and rebuilt from the conversation files`);
      for (const suffix of ['', '-wal', '-shm']) {
        const p = this.indexPath() + suffix;
        if (fs.existsSync(p)) { try { fs.renameSync(p, `${p}.corrupt-${this.now()}`); } catch { SafeFsExecutor.safeRmSync(p, { force: true, operation: 'src/core/AppConversationStore.ts:index-rebuild' }); } }
      }
      return open();
    }
  }

  /** Drop the index and rebuild it from the files (tests and the operator's repair path). */
  rebuildIndex(): void {
    this.removalIndexProof = null;
    this.removalHistoryProofs.clear();
    this.removalJournalRevisions.clear();
    this.db.exec('DELETE FROM files; DELETE FROM events; DELETE FROM messages; DELETE FROM deliveries; DELETE FROM conversations; DELETE FROM media_refs; DELETE FROM media_blobs; DELETE FROM media_purged; DELETE FROM media_totals; DELETE FROM transcripts; DELETE FROM pins;');
    this.catchUp();
  }

  /** Index every file (live and deleted) that is indexed short of its committed size. */
  catchUp(): void {
    for (const [sub, deleted] of [['', false], ['deleted', true]] as const) {
      const dir = sub ? path.join(this.dir, sub) : this.dir;
      let names: string[] = [];
      try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.jsonl$/.test(n)); } catch { /* @silent-fallback-ok — an absent directory holds no files */ }
      for (const name of names) this.catchUpFile(path.join(dir, name), deleted ? `deleted/${name}` : name);
    }
  }

  private catchUpFile(filePath: string, fileName: string): void {
    this.truncateTornTail(filePath);
    let size: number;
    try { size = fs.statSync(filePath).size; } catch { return; }
    const row = this.db.prepare('SELECT canonicalKey, indexedBytes FROM files WHERE fileName = ?').get(fileName) as { canonicalKey: string; indexedBytes: number } | undefined;
    let from = row?.indexedBytes ?? 0;
    if (row && from > size) {
      // The file is shorter than what was indexed (should not happen): re-index it from the start.
      this.dropMediaRefsOf(row.canonicalKey); // re-derived with the events
      this.db.prepare('DELETE FROM transcripts WHERE canonicalKey = ?').run(row.canonicalKey);
      this.db.prepare('DELETE FROM pins WHERE canonicalKey = ?').run(row.canonicalKey);
      this.db.prepare('DELETE FROM events WHERE canonicalKey = ?').run(row.canonicalKey);
      from = 0;
    }
    if (from >= size) return;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      this.db.transaction(() => {
        let offset = from;
        let start = 0;
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] !== 0x0a) continue;
          const lineBuf = buf.subarray(start, i);
          const lineOffset = offset;
          offset += i - start + 1;
          start = i + 1;
          let parsed: unknown;
          try { parsed = JSON.parse(lineBuf.toString('utf8')); } catch {
            this.reportOnce(`bad-line:${fileName}:${lineOffset}`, `an unreadable committed line in ${fileName} at byte ${lineOffset} was skipped (left in place)`);
            continue;
          }
          const ev = validateAppEvent(parsed);
          const seq = (parsed as { ingestSeq?: unknown }).ingestSeq;
          if (!ev || typeof seq !== 'number') {
            this.reportOnce(`bad-line:${fileName}:${lineOffset}`, `an invalid event in ${fileName} at byte ${lineOffset} was skipped (left in place)`);
            continue;
          }
          this.indexEvent({ ...ev, ingestSeq: seq }, fileName, lineOffset, lineBuf.length);
        }
        this.db.prepare('UPDATE files SET indexedBytes = ? WHERE fileName = ?').run(offset, fileName);
      })();
    } finally { fs.closeSync(fd); }
  }

  /** A final line without a newline is an uncommitted write: truncate back to the last newline. */
  private truncateTornTail(filePath: string): void {
    let size: number;
    try { size = fs.statSync(filePath).size; } catch { return; }
    if (size === 0) return;
    const fd = fs.openSync(filePath, 'r+');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return;
      // Scan backwards for the last newline in bounded chunks.
      let pos = size;
      let cut = 0;
      const chunk = Buffer.alloc(64 * 1024);
      while (pos > 0) {
        const len = Math.min(chunk.length, pos);
        pos -= len;
        fs.readSync(fd, chunk, 0, len, pos);
        const idx = chunk.subarray(0, len).lastIndexOf(0x0a);
        if (idx !== -1) { cut = pos + idx + 1; break; }
      }
      fs.ftruncateSync(fd, cut);
      fs.fsyncSync(fd);
      this.reportOnce(`torn:${path.basename(filePath)}`, `a write to ${path.basename(filePath)} was cut short by a crash; the unfinished line (${size - cut} bytes) was removed. Earlier lines are unchanged.`);
    } finally { fs.closeSync(fd); }
  }

  private reportOnce(key: string, detail: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    try { this.opts.reportDegradation?.('AppConversationStore', detail); } catch { /* @silent-fallback-ok — reporting never fails the store */ }
  }

  // ── Writes ──────────────────────────────────────────────────────────────────────────

  private fileNameFor(canonicalKey: string): string {
    return `${crypto.createHash('sha256').update(canonicalKey).digest('hex')}.jsonl`;
  }

  /**
   * agent-work-cards-default §2 "Progress notes land in the conversation first": the replicated-journal emit is
   * RESERVED before anything is written, and the durable local append runs only when the emit was accepted (enqueued
   * for replication). A refused emit (`rate-limited`, or any other non-accepted outcome) writes nothing anywhere and
   * is returned to the caller to retry; there is no rollback and no spool because nothing was written first.
   * With no reserving hook configured (a single machine, or a test), this is a plain `append`.
   */
  appendWithEmit(input: AppEvent): { appended: boolean; ingestSeq: number; outcome: 'appended' | 'duplicate' | 'rate-limited' | 'not-accepted' } {
    const stamp = (input.kind === 'message' || input.kind === 'media-message') && !input.accessStamp ? this.stamps?.stamp(input) ?? null : null;
    const event = stamp ? { ...input, accessStamp: stamp } as AppEvent : input;
    const canonicalKey = canonicalConversationKey(event.conversationKey);
    const existing = this.db.prepare('SELECT ingestSeq FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, event.eventId) as { ingestSeq: number } | undefined;
    if (existing) {
      // Even a duplicate may carry creation evidence stripped by an older codec.
      if (event.kind === 'created') this.write(event);
      return { appended: false, ingestSeq: existing.ingestSeq, outcome: 'duplicate' };
    }
    if (this.reserveEmit) {
      const r = this.reserveEmit(event);
      const accepted = r.outcome === 'emitted' || r.outcome === 'disabled' || r.outcome === 'skipped';
      if (!accepted) return { appended: false, ingestSeq: 0, outcome: /rate-limited/.test(r.outcome) ? 'rate-limited' : 'not-accepted' };
      const w = this.write(event);
      if (w.appended) this.notifyAppended(event, false);
      return { ...w, outcome: w.appended ? 'appended' : 'duplicate' };
    }
    const r = this.append(event);
    return { ...r, outcome: r.appended ? 'appended' : 'duplicate' };
  }

  /** The emit the reserving append runs FIRST (the same emitter the replication hook uses, returning its outcome). */
  setReservingReplicationHook(hook: ((event: AppEvent) => { outcome: string }) | undefined): void { this.reserveEmit = hook; }
  private reserveEmit: ((event: AppEvent) => { outcome: string }) | undefined;

  /** Append a locally-created event (dedup by eventId). The replication hook fires on a new commit. */
  append(input: AppEvent): { appended: boolean; ingestSeq: number } {
    const stamp = (input.kind === 'message' || input.kind === 'media-message') && !input.accessStamp ? this.stamps?.stamp(input) ?? null : null;
    const event = stamp ? { ...input, accessStamp: stamp } as AppEvent : input;
    const r = this.write(event);
    if (r.appended) { try { this.onLocalAppend?.(event); } catch { /* @silent-fallback-ok — replication emit is best-effort, the local commit already landed */ } }
    if (r.appended) this.notifyAppended(event, false);
    return r;
  }

  /** Ingest an event received by replication: validated, de-duplicated, never re-emitted. */
  ingestReplicated(raw: unknown): { appended: boolean; ingestSeq: number } | null {
    const ev = validateAppEvent(raw);
    if (!ev) return null;
    const r = this.write(ev);
    if (r.appended && (ev.kind === 'message' || ev.kind === 'media-message') && ev.accessStamp) this.stamps?.saw(ev.accessStamp);
    if (r.appended) this.notifyAppended(ev, true);
    return r;
  }

  /** Team access stamps messages once it knows there is something to protect. */
  useAccessStamps(stamps: AccessStamps): void { this.stamps = stamps; }

  private write(event: AppEvent): { appended: boolean; ingestSeq: number } {
    if (event.kind === 'message-removed') {
      const normalized = validateAppEvent(event);
      if (normalized?.kind !== 'message-removed') throw new Error('invalid App message removal');
      event = normalized;
    }
    if (event.kind === 'created') {
      const normalized = validateAppEvent(event);
      if (!normalized || normalized.kind !== 'created') throw new Error('invalid app creation evidence');
      event = normalized;
      const evidenceVersion = Number(this.db.pragma('data_version', { simple: true }));
      if (this.evidenceDataVersion && evidenceVersion !== this.evidenceDataVersion) this.loadCreationEvidence();
      this.evidenceDataVersion = evidenceVersion;
      // A pre-upgrade index may not have replayed its canonical base into the new evidence cache.
      const original = this.getEvent(event.conversationKey, event.eventId);
      if (original?.kind === 'created') this.observeCreated(original, false);
      this.observeCreated(event, true);
    }
    const canonicalKey = canonicalConversationKey(event.conversationKey);
    const existing = this.db.prepare('SELECT ingestSeq FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, event.eventId) as { ingestSeq: number } | undefined;
    if (existing) {
      if (event.kind === 'created') this.indexCreationRecord(event);
      return { appended: false, ingestSeq: existing.ingestSeq };
    }
    const file = this.db.prepare('SELECT fileName, nextIngestSeq, indexedBytes FROM files WHERE canonicalKey = ?').get(canonicalKey) as { fileName: string; nextIngestSeq: number; indexedBytes: number } | undefined;
    const fileName = file?.fileName ?? this.fileNameFor(canonicalKey);
    const ingestSeq = file?.nextIngestSeq ?? 1;
    const line = `${JSON.stringify({ ...event, ingestSeq })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES) throw new Error('app conversation event too large');
    const filePath = path.join(this.dir, fileName);
    const created = !fs.existsSync(filePath);
    const fd = fs.openSync(filePath, 'a', 0o600); /* state-registry: app-conversations */
    const trackedJournal = this.removalJournalRevisions.get(canonicalKey);
    let appendCheckpoint: string | null = null;
    let offset: number;
    try {
      offset = fs.fstatSync(fd).size;
      const beforeAppend = trackedJournal && file?.indexedBytes === offset ? this.removalJournalDescriptorStat(fd) : null;
      const trackedAppend = beforeAppend && this.removalJournalFileCheckpoint(beforeAppend) === trackedJournal?.checkpoint;
      try {
        if (fs.writeSync(fd, line) !== bytes) throw new Error('short App conversation append');
        fs.fsyncSync(fd);
        if (trackedAppend) {
          const afterAppend = this.removalJournalDescriptorStat(fd);
          if (afterAppend?.dev === beforeAppend.dev && afterAppend.ino === beforeAppend.ino
            && afterAppend.size === BigInt(offset + bytes)) appendCheckpoint = this.removalJournalFileCheckpoint(afterAppend);
        }
      } catch (err) {
        // A failed write must not leave a fragment mid-file for the next append to fuse onto:
        // cut back to where this line started, then report the failure (nothing was committed).
        try { fs.ftruncateSync(fd, offset); fs.fsyncSync(fd); } catch { /* @silent-fallback-ok — the boot torn-tail pass truncates it instead */ }
        throw err;
      }
    } finally { fs.closeSync(fd); }
    if (created) this.fsyncDir(path.dirname(filePath));
    // The commit landed. Index it (derived state; a failure here is repaired by catch-up).
    try {
      // A plain message updates only its own journal and scoped index rows. A same-chat
      // proof still sees the changed journal. Leave failures and all other writes global.
      const before = event.kind === 'message' ? this.indexWriteCount() : null;
      this.db.transaction(() => {
        if (!file) this.db.prepare('INSERT OR REPLACE INTO files (canonicalKey, fileName, indexedBytes, nextIngestSeq) VALUES (?, ?, ?, ?)').run(canonicalKey, fileName, 0, 1);
        this.indexEvent({ ...event, ingestSeq }, fileName, offset, bytes - 1);
        this.db.prepare('UPDATE files SET indexedBytes = ? WHERE canonicalKey = ?').run(offset + bytes, canonicalKey);
      })();
      if (before !== null) this.indexedPlainMessageWrites += this.indexWriteCount() - before;
      if (trackedJournal && appendCheckpoint) trackedJournal.checkpoint = appendCheckpoint;
    } catch (err) {
      this.reportOnce(`index-write:${fileName}`, `the conversation index missed an append (${err instanceof Error ? err.message : String(err)}); catching up from the file`);
      this.catchUpFile(filePath, fileName);
    }
    if (event.kind === 'tombstone') this.moveToDeleted(canonicalKey);
    return { appended: true, ingestSeq };
  }

  private fsyncDir(dir: string): void {
    try {
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the file itself was fsynced */ }
  }

  private moveToDeleted(canonicalKey: string): void {
    const row = this.db.prepare('SELECT fileName FROM files WHERE canonicalKey = ?').get(canonicalKey) as { fileName: string } | undefined;
    if (!row || row.fileName.startsWith('deleted/')) return;
    const next = `deleted/${row.fileName}`;
    try {
      fs.renameSync(path.join(this.dir, row.fileName), path.join(this.dir, next));
      this.fsyncDir(this.deletedDir);
      this.db.prepare('UPDATE files SET fileName = ? WHERE canonicalKey = ?').run(next, canonicalKey);
    } catch (err) {
      this.reportOnce(`move-deleted:${row.fileName}`, `a deleted conversation's file could not be moved aside (${err instanceof Error ? err.message : String(err)}); it stays hidden`);
    }
  }

  /** Apply one event to the index tables. Idempotent per (canonicalKey, eventId). */
  private indexEvent(ev: StoredAppEvent, fileName: string, byteOffset: number, byteLength: number): void {
    if (ev.kind === 'created') this.observeCreated(ev, false);
    const canonicalKey = canonicalConversationKey(ev.conversationKey);
    // The file's current location is the one being indexed (a moved-to-deleted file re-points it).
    this.db.prepare('INSERT INTO files (canonicalKey, fileName, indexedBytes, nextIngestSeq) VALUES (?, ?, 0, 1) ON CONFLICT(canonicalKey) DO UPDATE SET fileName = excluded.fileName')
      .run(canonicalKey, fileName);
    const ins = this.db.prepare('INSERT OR IGNORE INTO events (canonicalKey, ingestSeq, eventId, messageId, kind, at, machineId, byteOffset, byteLength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(canonicalKey, ev.ingestSeq, ev.eventId, 'messageId' in ev ? ev.messageId : null, ev.kind, ev.at, ev.machineId, byteOffset, byteLength);
    this.db.prepare('UPDATE files SET nextIngestSeq = MAX(nextIngestSeq, ?) WHERE canonicalKey = ?').run(ev.ingestSeq + 1, canonicalKey);
    if (ins.changes === 0) return;
    const newConversation = this.db.prepare('INSERT OR IGNORE INTO conversations (canonicalKey, conversationKey) VALUES (?, ?)').run(canonicalKey, ev.conversationKey);
    if (newConversation.changes) this.creationVersion++;
    switch (ev.kind) {
      case 'created':
      case 'label': {
        const setAt = ev.kind === 'label' ? ev.setAt : ev.at;
        const cur = this.db.prepare('SELECT titleAt, titleMachine, createdAt FROM conversations WHERE canonicalKey = ?').get(canonicalKey) as { titleAt: string | null; titleMachine: string | null; createdAt: string | null };
        if (!cur.titleAt || setAt > cur.titleAt || (setAt === cur.titleAt && ev.machineId > (cur.titleMachine ?? ''))) {
          this.db.prepare('UPDATE conversations SET title = ?, titleAt = ?, titleMachine = ? WHERE canonicalKey = ?').run(ev.title, setAt, ev.machineId, canonicalKey);
        }
        if (ev.kind === 'created' && (!cur.createdAt || ev.at < cur.createdAt)) {
          // The earliest `created` decides both the creation time and the owner (one rule, any arrival order).
          this.db.prepare('UPDATE conversations SET createdAt = ?, ownerMachine = ?, ownerUser = ? WHERE canonicalKey = ?')
            .run(ev.at, ev.ownerPerson?.machineId ?? null, ev.ownerPerson?.userId ?? null, canonicalKey);
        }
        if (ev.kind === 'created') this.indexCreationRecord(ev);
        return;
      }
      case 'tombstone':
        this.creationVersion++;
        this.tombstoneMediaRefs(canonicalKey);
        this.db.prepare('UPDATE conversations SET tombstoned = 1 WHERE canonicalKey = ?').run(canonicalKey);
        return;
      case 'purge':
        for (const id of ev.attachmentIds) this.purgeMediaRef(id);
        return;
      case 'message-removed':
        this.db.prepare('INSERT OR IGNORE INTO message_removals (canonicalKey, targetEventId, targetMessageId, machineId, eventId) VALUES (?, ?, ?, ?, ?)')
          .run(canonicalKey, ev.targetEventId, ev.targetMessageId, ev.machineId, ev.eventId);
        return;
      case 'reaction':
        this.db.prepare('INSERT OR IGNORE INTO reactions (canonicalKey, target, actor, revision, eventId, emoji) VALUES (?, ?, ?, ?, ?, ?)')
          .run(canonicalKey, ev.reactionTarget, ev.reactionActor, ev.reactionRevision, ev.eventId, ev.reactionEmoji);
        return;
      case 'pin': {
        // Never a chat message: no messages row, no preview, no activity. One winner per message.
        const cur = this.db.prepare('SELECT eventId, at, machineId FROM pins WHERE canonicalKey = ? AND pinnedMessageId = ?').get(canonicalKey, ev.pinnedMessageId) as { eventId: string; at: string; machineId: string } | undefined;
        if (pinEventWins(ev, cur)) {
          this.db.prepare('INSERT OR REPLACE INTO pins (canonicalKey, pinnedMessageId, eventId, state, at, machineId) VALUES (?, ?, ?, ?, ?, ?)').run(canonicalKey, ev.pinnedMessageId, ev.eventId, ev.pinState, ev.at, ev.machineId);
        }
        return;
      }
      case 'platform-media':
        // A reference only (§4.9): never a chat message, so no messages row and no preview.
        this.indexMediaRefs(canonicalKey, ev);
        return;
      case 'transcript': {
        // Never a chat message either. One winner per attachment, independent of arrival order:
        // the earliest `at`, then the lowest machine id (two machines can each transcribe once).
        const cur = this.db.prepare('SELECT at, machineId FROM transcripts WHERE attachmentId = ?').get(ev.attachmentId) as { at: string; machineId: string } | undefined;
        if (!cur || ev.at < cur.at || (ev.at === cur.at && ev.machineId < cur.machineId)) {
          this.db.prepare('INSERT OR REPLACE INTO transcripts (attachmentId, canonicalKey, eventId, at, machineId) VALUES (?, ?, ?, ?, ?)').run(ev.attachmentId, canonicalKey, ev.eventId, ev.at, ev.machineId);
        }
        return;
      }
      case 'message':
      case 'media-message': {
        const state = this.reduceFor(ev.messageId);
        const preview = messagePreview(ev.kind === 'media-message' ? ev : { text: ev.text });
        if (ev.kind === 'media-message') this.indexMediaRefs(canonicalKey, ev);
        this.db.prepare('INSERT OR IGNORE INTO messages (messageId, canonicalKey, eventId, at, deliveryState, lastPreview, forwarded) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(ev.messageId, canonicalKey, ev.eventId, ev.at, state, preview, ev.forwarded ? 1 : 0);
        const cur = this.db.prepare('SELECT lastActivity FROM conversations WHERE canonicalKey = ?').get(canonicalKey) as { lastActivity: string | null };
        if (!cur.lastActivity || ev.at >= cur.lastActivity) {
          this.db.prepare('UPDATE conversations SET lastActivity = ?, lastPreview = ? WHERE canonicalKey = ?').run(ev.at, preview, canonicalKey);
        }
        return;
      }
      case 'delivery': {
        this.db.prepare('INSERT OR IGNORE INTO deliveries (eventId, messageId, state, at, machineId) VALUES (?, ?, ?, ?, ?)').run(ev.eventId, ev.messageId, ev.state, ev.at, ev.machineId);
        this.db.prepare('UPDATE messages SET deliveryState = ? WHERE messageId = ?').run(this.reduceFor(ev.messageId), ev.messageId);
        return;
      }
    }
  }

  // ── Media references (media spec §4.7) ──────────────────────────────────────────────

  private isTombstoned(canonicalKey: string): boolean {
    const r = this.db.prepare('SELECT tombstoned FROM conversations WHERE canonicalKey = ?').get(canonicalKey) as { tombstoned: number } | undefined;
    return r?.tombstoned === 1;
  }

  /** Move one blob's counts; the agent total changes only when `liveRefs` crosses zero. */
  private bumpBlob(sha256: string, size: number, liveDelta: number, allDelta: number): void {
    this.db.prepare('INSERT OR IGNORE INTO media_blobs (sha256, size) VALUES (?, ?)').run(sha256, size);
    const cur = this.db.prepare('SELECT size, liveRefs FROM media_blobs WHERE sha256 = ?').get(sha256) as { size: number; liveRefs: number };
    const nextLive = Math.max(0, cur.liveRefs + liveDelta);
    this.db.prepare('UPDATE media_blobs SET liveRefs = ?, allRefs = MAX(0, allRefs + ?) WHERE sha256 = ?').run(nextLive, allDelta, sha256);
    this.db.prepare('INSERT OR IGNORE INTO media_totals (id, liveBytes) VALUES (1, 0)').run();
    if (cur.liveRefs === 0 && nextLive > 0) this.db.prepare('UPDATE media_totals SET liveBytes = liveBytes + ? WHERE id = 1').run(cur.size);
    if (cur.liveRefs > 0 && nextLive === 0) this.db.prepare('UPDATE media_totals SET liveBytes = MAX(0, liveBytes - ?) WHERE id = 1').run(cur.size);
  }

  private indexMediaRefs(canonicalKey: string, ev: MediaMessageEvent | PlatformMediaEvent): void {
    const tombstoned = this.isTombstoned(canonicalKey);
    for (const a of ev.attachments) {
      const purged = !!this.db.prepare('SELECT 1 FROM media_purged WHERE attachmentId = ?').get(a.attachmentId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO media_refs (attachmentId, sha256, size, canonicalKey, messageId, idx, purged) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(a.attachmentId, a.sha256, a.size, canonicalKey, ev.messageId, a.index, purged ? 1 : 0);
      if (ins.changes > 0 && !purged) this.bumpBlob(a.sha256, a.size, tombstoned ? 0 : 1, 1);
    }
  }

  private tombstoneMediaRefs(canonicalKey: string): void {
    if (this.isTombstoned(canonicalKey)) return;
    const refs = this.db.prepare('SELECT sha256, size FROM media_refs WHERE canonicalKey = ? AND purged = 0').all(canonicalKey) as Array<{ sha256: string; size: number }>;
    for (const r of refs) this.bumpBlob(r.sha256, r.size, -1, 0);
  }

  private purgeMediaRef(attachmentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO media_purged (attachmentId) VALUES (?)').run(attachmentId);
    const r = this.db.prepare('SELECT sha256, size, canonicalKey, purged FROM media_refs WHERE attachmentId = ?').get(attachmentId) as { sha256: string; size: number; canonicalKey: string; purged: number } | undefined;
    if (!r || r.purged === 1) return;
    this.db.prepare('UPDATE media_refs SET purged = 1 WHERE attachmentId = ?').run(attachmentId);
    this.bumpBlob(r.sha256, r.size, this.isTombstoned(r.canonicalKey) ? 0 : -1, -1);
  }

  private dropMediaRefsOf(canonicalKey: string): void {
    const tombstoned = this.isTombstoned(canonicalKey);
    const refs = this.db.prepare('SELECT sha256, size, purged FROM media_refs WHERE canonicalKey = ?').all(canonicalKey) as Array<{ sha256: string; size: number; purged: number }>;
    for (const r of refs) if (r.purged === 0) this.bumpBlob(r.sha256, r.size, tombstoned ? 0 : -1, -1);
    this.db.prepare('DELETE FROM media_refs WHERE canonicalKey = ?').run(canonicalKey);
  }

  /** Bytes the agent's live references hold, from replicated metadata (one row read). */
  mediaLiveBytes(): number {
    const r = this.db.prepare('SELECT liveBytes FROM media_totals WHERE id = 1').get() as { liveBytes: number } | undefined;
    return r?.liveBytes ?? 0;
  }

  /** The reference counts of one blob, or null when no event names it. */
  mediaBlobRefs(sha256: string): { size: number; liveRefs: number; allRefs: number } | null {
    return (this.db.prepare('SELECT size, liveRefs, allRefs FROM media_blobs WHERE sha256 = ?').get(sha256) as { size: number; liveRefs: number; allRefs: number } | undefined) ?? null;
  }

  /** Every hash an event on this machine references, unpurged. */
  mediaReferencedHashes(): Array<{ sha256: string; size: number; liveRefs: number }> {
    return this.db.prepare('SELECT sha256, size, liveRefs FROM media_blobs WHERE allRefs > 0').all() as Array<{ sha256: string; size: number; liveRefs: number }>;
  }

  mediaRef(attachmentId: string): MediaRef | null {
    const r = this.db.prepare('SELECT m.*, COALESCE(c.tombstoned, 0) AS tomb FROM media_refs m LEFT JOIN conversations c ON c.canonicalKey = m.canonicalKey WHERE m.attachmentId = ?').get(attachmentId) as (Omit<MediaRef, 'purged' | 'tombstoned'> & { purged: number; tomb: number }) | undefined;
    if (!r) return null;
    return { attachmentId: r.attachmentId, sha256: r.sha256, size: r.size, canonicalKey: r.canonicalKey, messageId: r.messageId, idx: r.idx, purged: r.purged === 1, tombstoned: r.tomb === 1 };
  }

  /** The first unpurged attachment of `sha256` in this live conversation, or null. */
  mediaRefInConversation(conversationKey: string, sha256: string): MediaRef | null {
    const canonicalKey = canonicalConversationKey(conversationKey);
    if (this.isTombstoned(canonicalKey)) return null;
    const r = this.db.prepare('SELECT attachmentId FROM media_refs WHERE canonicalKey = ? AND sha256 = ? AND purged = 0 LIMIT 1').get(canonicalKey, sha256) as { attachmentId: string } | undefined;
    return r ? this.mediaRef(r.attachmentId) : null;
  }

  /** Select a readable media occurrence under the same proof as protected message history. */
  readPreparedRemovalMedia(conversationKey: string, sha256: string, mayRead: (row: BrowsedMessage) => boolean, attachmentId?: string) {
    const key = canonicalConversationKey(conversationKey);
    return this.withRemovalHistory(conversationKey, (custodian, proof) => {
      if (this.isTombstoned(key)) return { occurrence: null, proof };
      const rows = this.db.prepare(`
        SELECT m.eventId, m.at, f.attachmentId, f.messageId, f.idx, f.size
        FROM media_refs f JOIN messages m ON m.canonicalKey = f.canonicalKey AND m.messageId = f.messageId
        WHERE f.canonicalKey = ? AND f.sha256 = ? AND f.purged = 0
          ${attachmentId !== undefined ? 'AND f.attachmentId = ?' : ''}
          AND NOT EXISTS (SELECT 1 FROM message_removals r
            WHERE r.canonicalKey = f.canonicalKey AND r.targetEventId = m.eventId
            AND r.targetMessageId = f.messageId AND r.machineId = ?)
        ORDER BY f.attachmentId LIMIT 101
      `).all(key, sha256, ...(attachmentId !== undefined ? [attachmentId] : []), custodian) as Array<{ eventId: string; at: string; attachmentId: string; messageId: string; idx: number; size: number }>;
      for (const row of rows.slice(0, 100)) {
        const message = this.readIndexedMessage(key, row);
        const attachment = message.attachments?.[row.idx];
        if (!attachment || attachment.attachmentId !== row.attachmentId || attachment.sha256 !== sha256
          || attachment.size !== row.size || message.messageId !== row.messageId) throw new Error('indexed media occurrence unavailable');
        if (mayRead(message)) return { occurrence: { eventId: row.eventId, messageId: row.messageId, attachment }, proof };
      }
      if (rows.length > 100) throw new Error('media occurrence search incomplete');
      return { occurrence: null, proof };
    });
  }

  /** The conversations (canonical keys) with an unpurged attachment of this hash. */
  mediaConversationsFor(sha256: string): string[] {
    return (this.db.prepare('SELECT DISTINCT canonicalKey FROM media_refs WHERE sha256 = ? AND purged = 0 ORDER BY canonicalKey').all(sha256) as Array<{ canonicalKey: string }>).map((r) => r.canonicalKey);
  }

  /** Unpurged attachments held for a conversation right now (the exact set a purge names). */
  mediaAttachmentIds(conversationKey: string): string[] {
    return (this.db.prepare('SELECT attachmentId FROM media_refs WHERE canonicalKey = ? AND purged = 0 ORDER BY attachmentId').all(canonicalConversationKey(conversationKey)) as Array<{ attachmentId: string }>).map((r) => r.attachmentId);
  }

  /** Purged attachments, for the sweep's idempotent re-apply (session copies). */
  mediaPurgedRefs(): Array<{ messageId: string; idx: number }> {
    return this.db.prepare('SELECT messageId, idx FROM media_refs WHERE purged = 1').all() as Array<{ messageId: string; idx: number }>;
  }

  isAttachmentPurged(attachmentId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM media_purged WHERE attachmentId = ?').get(attachmentId);
  }

  /** The stored message event by message id (the attachment lookup behind app-media-path). */
  getMessageEvent(conversationKey: string, messageId: string): StoredAppEvent | null {
    const row = this.db.prepare('SELECT eventId FROM messages WHERE messageId = ?').get(messageId) as { eventId: string } | undefined;
    return row ? this.getEvent(conversationKey, row.eventId) : null;
  }

  /**
   * The attachments recorded under a media reference's message id: a `media-message` (through the
   * messages table) or a `platform-media` event (whose event id IS its message id). Null otherwise.
   */
  getMediaAttachments(conversationKey: string, messageId: string): AppAttachment[] | null {
    const msg = this.getMessageEvent(conversationKey, messageId);
    if (msg && msg.kind === 'media-message') return msg.attachments;
    const pm = this.getEvent(conversationKey, messageId);
    return pm && pm.kind === 'platform-media' && pm.messageId === messageId ? pm.attachments : null;
  }

  /** The stored server transcript of one attachment (§4.5.1), or null. */
  transcriptFor(attachmentId: string): (TranscriptEvent & { ingestSeq: number }) | null {
    const row = this.db.prepare('SELECT canonicalKey, eventId FROM transcripts WHERE attachmentId = ?').get(attachmentId) as { canonicalKey: string; eventId: string } | undefined;
    if (!row) return null;
    const loc = this.db.prepare('SELECT byteOffset, byteLength FROM events WHERE canonicalKey = ? AND eventId = ?').get(row.canonicalKey, row.eventId) as { byteOffset: number; byteLength: number } | undefined;
    const ev = loc ? this.readEventAt(row.canonicalKey, loc.byteOffset, loc.byteLength) : null;
    return ev && ev.kind === 'transcript' ? ev : null;
  }

  /** The platform-media event recorded for one platform message (§4.9), or null. */
  getPlatformMedia(conversationKey: string, platformMessageId: string): (PlatformMediaEvent & { ingestSeq: number }) | null {
    const ev = this.getEvent(conversationKey, platformMediaMessageId(conversationKey, platformMessageId));
    return ev && ev.kind === 'platform-media' && ev.platformMessageId === platformMessageId ? ev : null;
  }

  private reduceFor(messageId: string): ReducedDeliveryState {
    const rows = this.db.prepare('SELECT state, at, machineId FROM deliveries WHERE messageId = ?').all(messageId) as Array<{ state: string; at: string; machineId: string }>;
    return reduceDeliveryState(rows);
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────

  private readEventAt(canonicalKey: string, byteOffset: number, byteLength: number): StoredAppEvent | null {
    const row = this.db.prepare('SELECT fileName FROM files WHERE canonicalKey = ?').get(canonicalKey) as { fileName: string } | undefined;
    if (!row) return null;
    const fd = fs.openSync(path.join(this.dir, row.fileName), 'r');
    try {
      const buf = Buffer.alloc(byteLength);
      fs.readSync(fd, buf, 0, byteLength, byteOffset);
      const parsed = JSON.parse(buf.toString('utf8')) as { ingestSeq?: number };
      const ev = validateAppEvent(parsed);
      return ev && typeof parsed.ingestSeq === 'number' ? { ...ev, ingestSeq: parsed.ingestSeq } : null;
    } catch { return null; } finally { fs.closeSync(fd); } // @silent-fallback-ok — an unreadable row reads as absent
  }

  private creationEvidencePath(): string { return path.join(this.dir, 'creation-evidence.jsonl'); }

  /** Only new evidence is appended; identical stripped copies add no information. */
  private observeCreated(event: CreatedEvent, durable: boolean): void {
    const key = canonicalConversationKey(event.conversationKey);
    const byId = this.creationEvidence.get(key);
    const bases = byId?.get(event.eventId);
    const digest = creationBaseDigest(event);
    const held = bases?.get(digest);
    const contextHash = event.creationContext ? creationContextDigest(event.creationContext) : null;
    if (held && (!contextHash || held.contexts.has(contextHash))) return;
    if (durable) {
      if (this.creationEvidenceUnreadable) throw new Error('creation evidence log is unreadable; refusing to acknowledge new evidence');
      const file = this.creationEvidencePath();
      const created = !fs.existsSync(file);
      const fd = fs.openSync(file, 'a', 0o600); /* state-registry: app-conversations */
      try {
        const bytes = Buffer.from(`${JSON.stringify({ v: 1, event })}\n`);
        let offset = 0;
        while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      if (created) this.fsyncDir(this.dir);
    }
    const ids = byId ?? new Map<string, Map<string, CreatedEvidenceBase>>();
    const variants = bases ?? new Map<string, CreatedEvidenceBase>();
    const base = held ?? { event: { ...event, creationContext: undefined }, contexts: new Map<string, AppCreationContext>() };
    if (event.creationContext && contextHash) base.contexts.set(contextHash, event.creationContext);
    variants.set(digest, base); ids.set(event.eventId, variants); this.creationEvidence.set(key, ids);
    this.creationVersion++;
  }

  /** Replay observations without truncation, writes, repair, or a per-row file scan. */
  private loadCreationEvidence(): void {
    let fd: number;
    try { fd = fs.openSync(this.creationEvidencePath(), 'r'); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.creationEvidenceUnreadable = true;
      this.reportOnce('creation-evidence-read', 'creation evidence could not be read; placement evidence is unavailable');
      return;
    }
    try {
      const chunk = Buffer.alloc(64 * 1024);
      let carry = Buffer.alloc(0), pos = 0;
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        if (!n) break;
        pos += n;
        const bytes = Buffer.concat([carry, chunk.subarray(0, n)]);
        let start = 0;
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] !== 10) continue;
          if (i > start) {
            try {
              const raw = JSON.parse(bytes.subarray(start, i).toString('utf8')) as { v?: unknown; event?: unknown };
              const event = raw.v === 1 ? validateAppEvent(raw.event) : null;
              if (!event || event.kind !== 'created') throw new Error('invalid creation observation');
              this.observeCreated(event, false);
            } catch { this.creationEvidenceUnreadable = true; /* @silent-fallback-ok: reported once below and all placement evidence becomes unavailable. */ }
          }
          start = i + 1;
        }
        carry = Buffer.from(bytes.subarray(start));
        if (carry.length > MAX_LINE_BYTES) { this.creationEvidenceUnreadable = true; break; }
      }
      if (carry.length) this.creationEvidenceUnreadable = true;
    } catch { this.creationEvidenceUnreadable = true; /* @silent-fallback-ok: reported once below and all placement evidence becomes unavailable. */ }
    finally { fs.closeSync(fd); }
    if (this.creationEvidenceUnreadable) this.reportOnce('creation-evidence-read', 'creation evidence has an unreadable observation; placement evidence is unavailable');
  }

  private parseCreationRecord(raw: unknown): CreatedEvent | null {
    if (typeof raw !== 'string') return null;
    try { const ev = validateAppEvent(JSON.parse(raw)); return ev?.kind === 'created' ? ev : null; }
    catch { return null; /* @silent-fallback-ok: malformed historical evidence is explicitly unknown, never authoritative placement. */ }
  }

  private completeCreated(event: CreatedEvent): CreatedEvent {
    const bases = this.creationEvidence.get(canonicalConversationKey(event.conversationKey))?.get(event.eventId);
    const held = bases?.get(creationBaseDigest(event));
    const context = held?.contexts.size === 1 ? held.contexts.values().next().value : undefined;
    return { ...event, ...(context ? { creationContext: validateAppCreationContext(context)! } : {}) };
  }

  private indexCreationRecord(event: CreatedEvent): void {
    const key = canonicalConversationKey(event.conversationKey);
    const row = this.db.prepare('SELECT creationRecord FROM conversations WHERE canonicalKey = ?').get(key) as { creationRecord: unknown } | undefined;
    if (!row) return;
    const prior = this.parseCreationRecord(row.creationRecord);
    const chosen = !prior || compareCreatedEvidence(event, prior) < 0 ? event : prior;
    const conflict = this.snapshotHasCreationConflict(row.creationRecord) || this.observedCreationConflict(key);
    this.db.prepare('UPDATE conversations SET creationRecord = ? WHERE canonicalKey = ?').run(JSON.stringify({
      ...this.completeCreated(chosen), ...(conflict ? { creationEvidenceConflict: true } : {}),
    }), key);
  }

  private rawCreationRecord(key: string): CreatedEvent | null {
    const r = this.db.prepare('SELECT creationRecord FROM conversations WHERE canonicalKey = ?').get(canonicalConversationKey(key)) as { creationRecord: unknown } | undefined;
    return r ? this.parseCreationRecord(r.creationRecord) : null;
  }

  private snapshotHasCreationConflict(raw: unknown): boolean {
    if (typeof raw !== 'string') return false;
    try { return (JSON.parse(raw) as { creationEvidenceConflict?: unknown }).creationEvidenceConflict === true; }
    catch { return true; /* @silent-fallback-ok: unreadable evidence is conservatively conflicting, suppressing placement without losing the chat. */ }
  }

  private observedCreationConflict(key: string): boolean {
    if (this.creationEvidenceUnreadable) return true;
    for (const variants of this.creationEvidence.get(canonicalConversationKey(key))?.values() ?? []) {
      if (variants.size > 1 || [...variants.values()].some((value) => value.contexts.size > 1)) return true;
    }
    return false;
  }

  hasCreationConflict(key: string): boolean {
    const indexed = this.db.prepare('SELECT creationRecord FROM conversations WHERE canonicalKey = ?').get(canonicalConversationKey(key)) as { creationRecord: unknown } | undefined;
    if (this.observedCreationConflict(key) || this.snapshotHasCreationConflict(indexed?.creationRecord)) return true;
    const record = this.rawCreationRecord(key);
    const owner = this.getConversation(key)?.ownerPerson ?? null;
    return !!record && ((record.ownerPerson?.machineId ?? null) !== (owner?.machineId ?? null) || (record.ownerPerson?.userId ?? null) !== (owner?.userId ?? null));
  }

  /** Historical evidence only. A missing/stripped legacy context remains absent. */
  getCreationRecord(key: string): CreatedEvent | null {
    if (this.hasCreationConflict(key)) return null;
    const record = this.rawCreationRecord(key);
    return record ? this.completeCreated(record) : null;
  }

  /** Changes on new context/index evidence; external writers invalidate the cached projection too. */
  get creationGeneration(): number {
    const version = Number(this.db.pragma('data_version', { simple: true }));
    if (version !== this.lastDataVersion) { this.lastDataVersion = version; this.creationVersion++; }
    return this.creationVersion;
  }
  get generation(): number { return this.creationGeneration; }
  getCreationGeneration(): number { return this.creationGeneration; }

  /** One event by id (the Telegram history join, §4.9), or null. */
  getEvent(conversationKey: string, eventId: string): StoredAppEvent | null {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const loc = this.db.prepare('SELECT byteOffset, byteLength FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, eventId) as { byteOffset: number; byteLength: number } | undefined;
    return loc ? this.readEventAt(canonicalKey, loc.byteOffset, loc.byteLength) : null;
  }

  hasEvent(conversationKey: string, eventId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalConversationKey(conversationKey), eventId);
  }

  getConversation(conversationKey: string): ConversationSummary | null {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const r = this.db.prepare('SELECT * FROM conversations WHERE canonicalKey = ?').get(canonicalKey) as Record<string, unknown> | undefined;
    return r ? toSummary(r) : null;
  }

  /**
   * Live (not deleted) NATIVE app conversations, newest activity first; keyset cursor
   * `<activity>|<canonicalKey>`. App-sent Telegram/Slack messages kept here (§4.9) are not listed.
   */
  listConversations(opts: { limit?: number; cursor?: string | null } = {}): { conversations: ConversationSummary[]; nextCursor: string | null } {
    return this.nativeConversationPage(opts, true);
  }

  /** Internal creation graph inventory; archived-card hiding is a user-list preference only. */
  creationInventoryPage(opts: { limit?: number; cursor?: string | null } = {}): { conversations: ConversationSummary[]; nextCursor: string | null } {
    return this.nativeConversationPage(opts, false);
  }

  private nativeConversationPage(opts: { limit?: number; cursor?: string | null }, applyHiddenFilter: boolean): { conversations: ConversationSummary[]; nextCursor: string | null } {
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    const act = `COALESCE(lastActivity, createdAt, '')`;
    // Work Board §2: conversations of archived or removed cards are left out BEFORE paging. If the
    // An unreadable classification is a failed read, never permission to expose internal work.
    let hidden: Set<string> | null = null;
    try { hidden = applyHiddenFilter ? this.hiddenConversationKeys?.() ?? null : null; }
    catch { throw new Error('work-card-visibility-unavailable'); }
    const isHidden = (r: Record<string, unknown>): boolean => !!hidden && hidden.size > 0 && hidden.has(String(r.canonicalKey).replace(/^app:/, ''));
    const kept: Array<Record<string, unknown>> = [];
    let cursor = opts.cursor && opts.cursor.includes('|') ? opts.cursor : null;
    // Each pass reads one batch after the cursor; hidden rows are skipped and the read continues,
    // bounded by the table size (every pass advances the keyset cursor or ends).
    for (;;) {
      let rows: Array<Record<string, unknown>>;
      const want = limit + 1 - kept.length + (hidden?.size ? Math.min(hidden.size, 200) : 0);
      if (cursor) {
        const i = cursor.lastIndexOf('|');
        const ca = cursor.slice(0, i);
        const ck = cursor.slice(i + 1);
        rows = this.db.prepare(`SELECT * FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%' AND (${act} < ? OR (${act} = ? AND canonicalKey < ?)) ORDER BY ${act} DESC, canonicalKey DESC LIMIT ?`).all(ca, ca, ck, want) as Array<Record<string, unknown>>;
      } else {
        rows = this.db.prepare(`SELECT * FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%' ORDER BY ${act} DESC, canonicalKey DESC LIMIT ?`).all(want) as Array<Record<string, unknown>>;
      }
      for (const r of rows) { if (!isHidden(r) && kept.length < limit + 1) kept.push(r); }
      if (rows.length < want || kept.length >= limit + 1) break;
      const lastRow = rows[rows.length - 1];
      cursor = `${(lastRow.lastActivity as string | null) ?? (lastRow.createdAt as string | null) ?? ''}|${String(lastRow.canonicalKey)}`;
    }
    const more = kept.length > limit;
    const page = kept.slice(0, limit).map(toSummary);
    const last = page[page.length - 1];
    return { conversations: page, nextCursor: more && last ? `${last.lastActivity ?? last.createdAt ?? ''}|${last.canonicalKey}` : null };
  }

  /** Work Board §2: set by the wiring; returns the conversation keys of archived or removed cards. */
  hiddenConversationKeys: (() => Set<string>) | null = null;

  /** Human discovery only; direct history, replication and worker execution keep their existing access rules. */
  isHiddenConversation(conversationKey: string): boolean {
    return this.hiddenConversationKeys?.().has(conversationKey.replace(/^app:/, '').toLowerCase()) === true;
  }

  /** The pin state of one message (conversation-pinned-messages): its winning event's state, or null when never pinned. */
  pinState(conversationKey: string, messageId: string): 'pinned' | 'unpinned' | null {
    const r = this.db.prepare('SELECT state FROM pins WHERE canonicalKey = ? AND pinnedMessageId = ?').get(canonicalConversationKey(conversationKey), messageId) as { state: string } | undefined;
    return r ? (r.state === 'pinned' ? 'pinned' : 'unpinned') : null;
  }

  /** The winning pin event of one message: its state and time, or null when never pinned. */
  pinRecord(conversationKey: string, messageId: string): { state: 'pinned' | 'unpinned'; at: string } | null {
    const r = this.db.prepare('SELECT state, at FROM pins WHERE canonicalKey = ? AND pinnedMessageId = ?').get(canonicalConversationKey(conversationKey), messageId) as { state: string; at: string } | undefined;
    return r ? { state: r.state === 'pinned' ? 'pinned' : 'unpinned', at: r.at } : null;
  }

  /** How many messages are pinned in a conversation now. */
  pinCount(conversationKey: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM pins WHERE canonicalKey = ? AND state = 'pinned'").get(canonicalConversationKey(conversationKey)) as { c: number }).c;
  }

  /** The pinned messages of a conversation, newest pin first (at most MAX_PINS_PER_CONVERSATION). */
  listPins(conversationKey: string, limit = MAX_PINS_PER_CONVERSATION): PinnedMessage[] {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const n = Math.max(1, Math.min(MAX_PINS_PER_CONVERSATION, Math.floor(limit)));
    const rows = this.db.prepare("SELECT eventId FROM pins WHERE canonicalKey = ? AND state = 'pinned' ORDER BY at DESC, machineId DESC, eventId DESC LIMIT ?").all(canonicalKey, n) as Array<{ eventId: string }>;
    const out: PinnedMessage[] = [];
    for (const r of rows) {
      const ev = this.getEvent(conversationKey, r.eventId);
      if (!ev || ev.kind !== 'pin') continue;
      out.push({ messageId: ev.pinnedMessageId, pinnedAt: ev.at, pinnedBy: ev.pinnedBy, preview: ev.preview ?? null, source: ev.source, eventId: ev.eventId, machineId: ev.machineId });
    }
    return out;
  }

  /**
   * Meaning search (docs/specs/conversation-search.md §4): one page of message identities in live
   * NATIVE app conversations for the embedding index, newest stored first (row order), older than
   * `beforeRow` (null ⇒ the newest). No text: the indexer reads an event only when it lacks it.
   */
  messageIndexPage(beforeRow: number | null, limit: number): Array<{ row: number; canonicalKey: string; eventId: string; at: string }> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const live = `canonicalKey IN (SELECT canonicalKey FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%')`;
    return (beforeRow === null
      ? this.db.prepare(`SELECT rowid AS row, canonicalKey, eventId, at FROM messages WHERE ${live} ORDER BY rowid DESC LIMIT ?`).all(n)
      : this.db.prepare(`SELECT rowid AS row, canonicalKey, eventId, at FROM messages WHERE rowid < ? AND ${live} ORDER BY rowid DESC LIMIT ?`).all(beforeRow, n)) as Array<{ row: number; canonicalKey: string; eventId: string; at: string }>;
  }

  /** How many messages live native app conversations hold (meaning search coverage). */
  liveMessageCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE canonicalKey IN (SELECT canonicalKey FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%')`).get() as { n: number }).n;
  }

  /** Every live conversation key (boot alias re-derivation and lease-acquisition binds). */
  liveConversationKeys(): string[] {
    return (this.db.prepare('SELECT conversationKey FROM conversations WHERE tombstoned = 0').all() as Array<{ conversationKey: string }>).map((r) => r.conversationKey);
  }

  /** Bounded registration snapshot, including removals, without message or title data. */
  inventoryFrontier(limit = 1001): {
    keys: Array<{ conversationKey: string; tombstoned: boolean }>;
    overflow: boolean;
    eventWatermark: number;
    liveCount: number;
  } {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(10001, Math.floor(limit))) : 1001;
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT conversationKey, tombstoned FROM conversations ORDER BY canonicalKey LIMIT ?')
        .all(bounded + 1) as Array<{ conversationKey: string; tombstoned: number }>;
      const watermark = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS value FROM events').get() as { value: number };
      const live = this.db.prepare('SELECT COUNT(*) AS value FROM conversations WHERE tombstoned = 0').get() as { value: number };
      return {
        keys: rows.slice(0, bounded).map(row => ({ conversationKey: row.conversationKey, tombstoned: row.tombstoned !== 0 })),
        overflow: rows.length > bounded,
        eventWatermark: watermark.value,
        liveCount: live.value,
      };
    })();
  }

  deliveryState(messageId: string): ReducedDeliveryState | null {
    const r = this.db.prepare('SELECT deliveryState FROM messages WHERE messageId = ?').get(messageId) as { deliveryState: ReducedDeliveryState } | undefined;
    return r ? r.deliveryState : null;
  }

  hasMessage(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE messageId = ?').get(messageId);
  }

  /**
   * SYNC read (§4.5): events in this machine's ingest order. The cursor is opaque (this
   * machine's id plus an ingestSeq); a cursor minted by another machine is not compared —
   * the read starts again from the beginning and the client de-duplicates by eventId.
   */
  syncEvents(conversationKey: string, cursor: string | null | undefined, limit = 100): { events: StoredAppEvent[]; cursor: string } {
    const { events, sequence } = this.syncIndexedEvents(conversationKey, this.readSyncSequence(cursor), limit, false);
    return { events, cursor: this.syncCursor(sequence) };
  }

  private readSyncSequence(cursor: string | null | undefined): number {
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { m?: unknown; s?: unknown };
        if (c.m === this.opts.machineId() && typeof c.s === 'number' && c.s >= 0) return c.s;
      } catch { /* @silent-fallback-ok — an unreadable cursor restarts from the beginning (the client de-duplicates) */ }
    }
    return 0;
  }

  private syncIndexedEvents(conversationKey: string, after: number, limit: number,
    strict: boolean): { events: StoredAppEvent[]; sequence: number } {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare('SELECT ingestSeq, eventId, kind, byteOffset, byteLength FROM events WHERE canonicalKey = ? AND ingestSeq > ? ORDER BY ingestSeq ASC LIMIT ?').all(canonicalKey, after, n) as Array<{ ingestSeq: number; eventId: string; kind: AppEventKind; byteOffset: number; byteLength: number }>;
    const events: StoredAppEvent[] = [];
    let last = after;
    for (const r of rows) {
      last = r.ingestSeq;
      const ev = this.readEventAt(canonicalKey, r.byteOffset, r.byteLength);
      if (strict && (!ev || ev.ingestSeq !== r.ingestSeq || ev.eventId !== r.eventId
        || ev.kind !== r.kind || canonicalConversationKey(ev.conversationKey) !== canonicalKey)) {
        throw new Error('indexed sync event unavailable');
      }
      if (ev) events.push(ev);
    }
    return { events, sequence: last };
  }

  private syncCursor(sequence: number): string {
    return Buffer.from(JSON.stringify({ m: this.opts.machineId(), s: sequence })).toString('base64url');
  }

  /** Authorized message changes only. The private projection does not replace generic App sync. */
  syncRemovalAwareMessageChanges(conversationKey: string, cursor: string | null | undefined, limit: number,
    mayRead: (row: BrowsedMessage) => 'allow' | 'deny' | 'unknown'): {
      changes: Array<{ kind: 'message'; row: BrowsedMessage } |
        { kind: 'message-removed'; conversationKey: string; eventId: string; targetEventId: string }>;
      cursor: string;
      blocked: boolean;
    } | null {
    const page = this.syncRemovalAwareMessageChangesAfter(conversationKey, this.readSyncSequence(cursor), limit, mayRead);
    return page && { changes: page.changes, cursor: this.syncCursor(page.sequence), blocked: page.blocked };
  }

  syncRemovalAwareMessageChangesAfter(conversationKey: string, after: number, limit: number,
    mayRead: (row: BrowsedMessage) => 'allow' | 'deny' | 'unknown'): {
    changes: NonNullable<ReturnType<AppConversationStore['syncRemovalAwareMessageChanges']>>['changes'];
    sequence: number;
    highWater: number;
    blocked: boolean;
    proof: string;
  } | null {
    if (!Number.isSafeInteger(after) || after < 0) return null;
    return this.withRemovalHistory(conversationKey, (custodian, proof) => {
      const key = canonicalConversationKey(conversationKey);
      const frontier = this.db.prepare('SELECT COALESCE(MAX(ingestSeq), 0) AS sequence FROM events WHERE canonicalKey = ?')
        .get(key) as { sequence: number };
      const highWater = frontier.sequence;
      if (!Number.isSafeInteger(highWater) || highWater < after) throw new Error('removal sync frontier unavailable');
      const { events, sequence } = this.syncIndexedEvents(conversationKey, after, limit, true);
      const firstRemoval = this.db.prepare(`
        SELECT e.eventId FROM message_removals r JOIN events e
          ON e.canonicalKey = r.canonicalKey AND e.eventId = r.eventId
        WHERE r.canonicalKey = ? AND r.targetEventId = ? AND r.targetMessageId = ? AND r.machineId = ?
        ORDER BY e.ingestSeq ASC LIMIT 1
      `);
      type Change = NonNullable<ReturnType<AppConversationStore['syncRemovalAwareMessageChanges']>>['changes'][number];
      const changes: Change[] = [];
      let previous = after;
      for (const fact of events) {
        const marker = fact.kind === 'message-removed' && fact.machineId === custodian;
        const target = marker ? this.getEvent(conversationKey, fact.targetEventId) : fact;
        if (marker && (!target || target.eventId !== fact.targetEventId
          || canonicalConversationKey(target.conversationKey) !== key)) return { changes, sequence: previous, blocked: true, highWater, proof };
        if (target && (target.kind === 'message' || target.kind === 'media-message')
          && canonicalConversationKey(target.conversationKey) === key
          && (!marker || fact.targetMessageId === target.messageId)) {
          const removal = firstRemoval.get(key, target.eventId, target.messageId, custodian) as { eventId: string } | undefined;
          if (marker ? removal?.eventId === fact.eventId : !removal && fact.kind !== 'message-removed') {
            const row = this.projectMessage(target);
            const access = mayRead(row);
            if (access === 'unknown') return { changes, sequence: previous, blocked: true, highWater, proof };
            if (access === 'allow') changes.push(marker
              ? { kind: 'message-removed', conversationKey, eventId: fact.eventId, targetEventId: target.eventId }
              : { kind: 'message', row });
          }
        }
        previous = fact.ingestSeq;
      }
      return { changes, sequence, blocked: false, highWater, proof };
    });
  }

  /**
   * BROWSE read (§4.5): messages paged BACKWARDS in `(at, eventId)` order, each with its reduced
   * delivery state. `before` is `<at>,<eventId>` (exclusive). The page is returned oldest-first,
   * with `nextBefore` naming the oldest row when older messages remain.
   */
  /** Ordinary history for session and context consumers. Copies cannot become agent instructions. */
  browseAgentMessages(conversationKey: string, before: string | null | undefined, limit = 100) {
    return this.browseMessages(conversationKey, before, limit, { excludeForwarded: true });
  }

  browseMessages(conversationKey: string, before: string | null | undefined, limit = 100, options?: { excludeForwarded?: boolean }): { messages: BrowsedMessage[]; nextBefore: string | null } {
    return this.browseIndexedMessages(conversationKey, before, limit, options?.excludeForwarded ?? false);
  }

  /** A page from the creation custodian, or null when there is no complete removal proof. */
  browseRemovalAwareMessages(conversationKey: string, before: string | null | undefined, limit = 100): { messages: BrowsedMessage[]; nextBefore: string | null } | null {
    const page = this.readPreparedRemovalHistory(conversationKey, before, limit);
    return page ? { messages: page.messages, nextBefore: page.nextBefore } : null;
  }

  /** Keep the exact evidence used by the read available for final response validation. */
  readPreparedRemovalHistory(conversationKey: string, before: string | null | undefined, limit: number) {
    return this.withRemovalHistory(conversationKey, (custodian, proof) => ({
      ...this.browseIndexedMessages(conversationKey, before, limit, false, custodian),
      proof,
    }));
  }

  /** Exact candidates after the caller's row ACL, or null when removal proof is incomplete. */
  exactRemovalAwareMessageCandidates(conversationKey: string, target: string, kind: 'event' | 'message' | 'legacy',
    mayRead: (row: BrowsedMessage) => boolean): BrowsedMessage[] | null {
    return this.withRemovalHistory(conversationKey, (custodian) =>
      this.selectRemovalAwareCandidates(conversationKey, target, kind, mayRead, custodian));
  }

  /** Project bounded exact reads together without exposing journal rows outside the snapshot. */
  projectPreparedRemovalEvents<T>(conversationKey: string, mayRead: (row: BrowsedMessage) => boolean,
    project: (find: (eventId: string) => BrowsedMessage | undefined) => T) {
    return this.withRemovalHistory(conversationKey, (custodian, proof) => ({
      value: project((eventId) => this.selectRemovalAwareCandidates(conversationKey, eventId, 'event', mayRead, custodian)[0]),
      proof,
    }));
  }

  private selectRemovalAwareCandidates(conversationKey: string, target: string, kind: 'event' | 'message' | 'legacy',
    mayRead: (row: BrowsedMessage) => boolean, custodian: string) {
    const key = canonicalConversationKey(conversationKey);
    const removed = this.db.prepare('SELECT 1 FROM message_removals WHERE canonicalKey = ? AND targetEventId = ? AND targetMessageId = ? AND machineId = ? LIMIT 1');
    const candidates = this.exactMessageCandidates(conversationKey, target, kind).filter(mayRead);
    const visible = candidates.filter((row) => !removed.get(key, row.eventId, row.messageId, custodian));
    // A legacy identifier may name two occurrences. Removal cannot retarget it to the survivor.
    return kind === 'legacy' && visible.length !== candidates.length ? [] : visible;
  }

  /** Resolve an exact context page under one prepared custodian snapshot. */
  readPreparedRemovalContext(conversationKey: string, target: string, kind: 'event' | 'message' | 'legacy',
    inclusive: boolean, limit: number, mayRead: (row: BrowsedMessage) => boolean) {
    return this.withRemovalHistory(conversationKey, (custodian, proof) => {
      const candidates = this.selectRemovalAwareCandidates(conversationKey, target, kind, mayRead, custodian);
      if (candidates.length !== 1) return { anchor: null, messages: [], proof };
      const anchor = candidates[0]!;
      const messages = this.exactMessageChunk(conversationKey, anchor, inclusive, limit, custodian);
      if (messages.some((row) => !mayRead(row))) throw new Error('exact context access unavailable');
      return { anchor, messages, proof };
    });
  }

  private removalJournalFileCheckpoint(stat: fs.BigIntStats): string {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  }

  private removalJournalDescriptorStat(fd: number): fs.BigIntStats | null {
    try {
      return fs.fstatSync(fd, { bigint: true });
    } catch {
      return null; // @silent-fallback-ok — a write can finish while its continuation becomes invalid
    }
  }

  /** A current authoritative journal epoch. Trusted indexed appends keep existing continuations valid. */
  removalJournalRevision(conversationKey: string): string | null {
    const key = canonicalConversationKey(conversationKey);
    try {
      const file = this.db.prepare('SELECT fileName, indexedBytes FROM files WHERE canonicalKey = ?')
        .get(key) as { fileName: string; indexedBytes: number } | undefined;
      if (!file) throw new Error('removal journal unavailable');
      const stat = fs.statSync(path.join(this.dir, file.fileName), { bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(file.indexedBytes)) throw new Error('removal journal checkpoint unavailable');
      const checkpoint = this.removalJournalFileCheckpoint(stat);
      const tracked = this.removalJournalRevisions.get(key);
      const evidence = tracked?.checkpoint === checkpoint ? tracked : { checkpoint, revision: crypto.randomUUID() };
      this.removalJournalRevisions.delete(key);
      if (this.removalJournalRevisions.size >= MAX_REMOVAL_HISTORY_PROOFS) {
        const oldest = this.removalJournalRevisions.keys().next().value;
        if (oldest !== undefined) this.removalJournalRevisions.delete(oldest);
      }
      this.removalJournalRevisions.set(key, evidence);
      return evidence.revision;
    } catch {
      this.removalJournalRevisions.delete(key);
      return null; // @silent-fallback-ok — uncertain journal evidence never renews cached display
    }
  }

  private indexWriteCount(): number {
    return (this.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
  }

  private removalHistoryCheckpoint(conversationKey: string) {
    const key = canonicalConversationKey(conversationKey);
    const custodian = this.getCreationRecord(conversationKey)?.machineId;
    if (!custodian || custodian === 'local' || custodian !== this.opts.machineId()) return null;
    const file = this.db.prepare('SELECT fileName, indexedBytes FROM files WHERE canonicalKey = ?')
      .get(key) as { fileName: string; indexedBytes: number } | undefined;
    if (!file) return null;
    const filePath = path.join(this.dir, file.fileName);
    const journal = fs.statSync(filePath);
    if (journal.size !== file.indexedBytes) return null;
    const version = this.db.pragma('data_version', { simple: true });
    const writes = this.indexWriteCount() - this.indexedPlainMessageWrites;
    const proof = JSON.stringify([custodian, file.fileName, journal.dev, journal.ino, journal.size,
      journal.mtimeMs, journal.ctimeMs, version, writes]);
    return { custodian, filePath, journal, proof };
  }

  /** Prepare one custody proof off the interactive read path. A competing conversation can retry. */
  prepareRemovalHistory(conversationKey: string): Promise<boolean> {
    const key = canonicalConversationKey(conversationKey);
    if (this.removalHistoryPreparation) {
      return this.removalHistoryPreparation.key === key ? this.removalHistoryPreparation.result : Promise.resolve(false);
    }
    const result = this.scanRemovalHistory(conversationKey, key).finally(() => {
      this.removalHistoryPreparation = null;
    });
    this.removalHistoryPreparation = { key, result };
    return result;
  }

  private async scanRemovalHistory(conversationKey: string, key: string): Promise<boolean> {
    try {
      await nextTurn();
      const checkpoint = this.removalHistoryCheckpoint(conversationKey);
      if (!checkpoint) return false;
      if (this.removalHistoryProofs.get(key) === checkpoint.proof) return true;
      const scan = this.scanRemovalIndex(conversationKey, checkpoint.filePath, checkpoint.journal);
      try {
        for (;;) {
          if (this.removalHistoryCheckpoint(conversationKey)?.proof !== checkpoint.proof) return false;
          const step = scan.next();
          if (step.done) {
            if (!step.value || this.removalHistoryCheckpoint(conversationKey)?.proof !== checkpoint.proof) return false;
            this.rememberRemovalHistoryProof(key, checkpoint.proof);
            return true;
          }
          await nextTurn();
        }
      } finally {
        scan.return(false);
      }
    } catch {
      return false; // @silent-fallback-ok — an incomplete history proof never enables a read
    }
  }

  hasPreparedRemovalHistory(conversationKey: string, proof: string): boolean {
    return this.withRemovalHistory(conversationKey, (_custodian, current) => current === proof) === true;
  }

  private rememberRemovalHistoryProof(key: string, proof: string): void {
    this.removalHistoryProofs.delete(key);
    this.removalHistoryProofs.set(key, proof);
    if (this.removalHistoryProofs.size > MAX_REMOVAL_HISTORY_PROOFS) {
      const oldest = this.removalHistoryProofs.keys().next().value;
      if (oldest !== undefined) this.removalHistoryProofs.delete(oldest);
    }
  }

  private withRemovalHistory<T>(conversationKey: string, read: (custodian: string, proof: string) => T): T | null {
    const key = canonicalConversationKey(conversationKey);
    try {
      const version = this.db.pragma('data_version', { simple: true });
      const result = this.db.transaction(() => {
        const checkpoint = this.removalHistoryCheckpoint(conversationKey);
        if (!checkpoint || this.removalHistoryProofs.get(key) !== checkpoint.proof) return null;
        const page = read(checkpoint.custodian, checkpoint.proof);
        if (this.removalHistoryCheckpoint(conversationKey)?.proof !== checkpoint.proof) return null;
        this.rememberRemovalHistoryProof(key, checkpoint.proof);
        return page;
      })();
      return this.db.pragma('data_version', { simple: true }) === version ? result : null;
    } catch {
      return null; // @silent-fallback-ok — a removal-aware read has no unfiltered fallback
    }
  }

  private browseIndexedMessages(conversationKey: string, before: string | null | undefined, limit: number, excludeForwarded: boolean,
    removalCustodian?: string): { messages: BrowsedMessage[]; nextBefore: string | null } {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    let rows: Array<{ eventId: string; at: string; messageId: string }>;
    const eligible = (excludeForwarded ? ' AND forwarded = 0' : '') + (removalCustodian ? `
      AND NOT EXISTS (SELECT 1 FROM message_removals r WHERE r.canonicalKey = messages.canonicalKey
        AND r.targetEventId = messages.eventId AND r.targetMessageId = messages.messageId AND r.machineId = ?)
    ` : '');
    const scope = removalCustodian ? [canonicalKey, removalCustodian] : [canonicalKey];
    const b = typeof before === 'string' ? before.split(',') : null;
    if (b && b.length === 2 && b[0] && b[1]) {
      rows = this.db.prepare(`SELECT eventId, at, messageId FROM messages WHERE canonicalKey = ?${eligible} AND (at < ? OR (at = ? AND eventId < ?)) ORDER BY at DESC, eventId DESC LIMIT ?`).all(...scope, b[0], b[0], b[1], n + 1) as typeof rows;
    } else {
      rows = this.db.prepare(`SELECT eventId, at, messageId FROM messages WHERE canonicalKey = ?${eligible} ORDER BY at DESC, eventId DESC LIMIT ?`).all(...scope, n + 1) as typeof rows;
    }
    const more = rows.length > n;
    const page = rows.slice(0, n);
    const out: BrowsedMessage[] = [];
    for (const r of page) {
      if (removalCustodian) {
        const row = this.readIndexedMessage(canonicalKey, r);
        if (row.messageId !== r.messageId) throw new Error('indexed message identity unavailable');
        out.push(row);
        continue;
      }
      const loc = this.db.prepare('SELECT byteOffset, byteLength FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, r.eventId) as { byteOffset: number; byteLength: number } | undefined;
      const ev = loc ? this.readEventAt(canonicalKey, loc.byteOffset, loc.byteLength) : null;
      if (!ev || (ev.kind !== 'message' && ev.kind !== 'media-message')) continue;
      out.push(this.projectMessage(ev));
    }
    out.reverse();
    const oldest = page[page.length - 1];
    return { messages: out, nextBefore: more && oldest ? `${oldest.at},${oldest.eventId}` : null };
  }

  private verifyRemovalIndex(conversationKey: string, filePath: string): boolean {
    const scan = this.scanRemovalIndex(conversationKey, filePath);
    for (;;) {
      const step = scan.next();
      if (step.done) return step.value;
    }
  }

  private *scanRemovalIndex(conversationKey: string, filePath: string, expectedJournal?: fs.Stats): Generator<void, boolean> {
    const key = canonicalConversationKey(conversationKey);
    const event = this.db.prepare('SELECT kind, ingestSeq FROM events WHERE canonicalKey = ? AND eventId = ?');
    const message = expectedJournal
      ? this.db.prepare('SELECT eventId, at FROM messages WHERE canonicalKey = ? AND messageId = ?')
      : null;
    const removal = this.db.prepare('SELECT targetEventId, targetMessageId, machineId FROM message_removals WHERE canonicalKey = ? AND eventId = ?');
    const counts = this.db.prepare(`
      SELECT (SELECT COUNT(*) FROM events WHERE canonicalKey = ? AND kind = 'message-removed') AS journalIndex,
             (SELECT COUNT(*) FROM message_removals WHERE canonicalKey = ?) AS removalIndex
    `).get(key, key) as { journalIndex: number; removalIndex: number };
    const fd = fs.openSync(filePath, 'r');
    try {
      if (expectedJournal) {
        const actual = fs.fstatSync(fd);
        if (actual.dev !== expectedJournal.dev || actual.ino !== expectedJournal.ino
          || actual.size !== expectedJournal.size || actual.mtimeMs !== expectedJournal.mtimeMs
          || actual.ctimeMs !== expectedJournal.ctimeMs) return false;
      }
      const chunk = Buffer.alloc(64 * 1024);
      let carry = Buffer.alloc(0);
      const seen = new Set<string>();
      let lastSequence = 0;
      for (;;) {
        const length = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!length) return carry.length === 0 && seen.size === counts.journalIndex && seen.size === counts.removalIndex;
        const bytes = Buffer.concat([carry, chunk.subarray(0, length)]);
        let start = 0;
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
          const parsed = JSON.parse(bytes.subarray(start, end).toString('utf8')) as { ingestSeq?: number };
          const raw = validateAppEvent(parsed);
          if (!raw || canonicalConversationKey(raw.conversationKey) !== key) return false;
          const indexed = event.get(key, raw.eventId) as { kind: string; ingestSeq: number } | undefined;
          if (indexed?.kind !== raw.kind) return false;
          if (expectedJournal) {
            const sequence = parsed.ingestSeq;
            if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= lastSequence
              || indexed.ingestSeq !== sequence) return false;
            lastSequence = sequence;
          }
          if (message && (raw.kind === 'message' || raw.kind === 'media-message')) {
            const row = message.get(key, raw.messageId) as { eventId: string; at: string } | undefined;
            if (row?.eventId !== raw.eventId || row.at !== raw.at) return false;
          }
          if (raw.kind === 'message-removed') {
            seen.add(raw.eventId);
            const row = removal.get(key, raw.eventId) as { targetEventId: string; targetMessageId: string; machineId: string } | undefined;
            if (!row || row.targetEventId !== raw.targetEventId || row.targetMessageId !== raw.targetMessageId || row.machineId !== raw.machineId) return false;
          }
          start = end + 1;
        }
        carry = Buffer.from(bytes.subarray(start));
        if (carry.length > MAX_LINE_BYTES) return false;
        yield;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Matching durable removal, known absence, or null when local proof is incomplete. */
  messageRemoval(conversationKey: string, targetEventId: string, targetMessageId: string, removalEventId?: string): { eventId: string | null } | null {
    return this.readMessageRemoval(conversationKey, targetEventId, targetMessageId, removalEventId, true);
  }

  /** Exact positive evidence only. An unproven receipt does not need a journal scan. */
  hasConfirmedMessageRemoval(conversationKey: string, targetEventId: string, targetMessageId: string, removalEventId: string): boolean {
    return this.readMessageRemoval(conversationKey, targetEventId, targetMessageId, removalEventId, false)?.eventId === removalEventId;
  }

  private readMessageRemoval(conversationKey: string, targetEventId: string, targetMessageId: string,
    removalEventId: string | undefined, proveAbsence: boolean): { eventId: string | null } | null {
    const key = canonicalConversationKey(conversationKey);
    try {
      const version = this.db.pragma('data_version', { simple: true });
      const result = this.db.transaction(() => {
        const custodian = this.getCreationRecord(conversationKey)?.machineId;
        const file = this.db.prepare('SELECT fileName, indexedBytes FROM files WHERE canonicalKey = ?')
          .get(key) as { fileName: string; indexedBytes: number } | undefined;
        if (!custodian || !file) return null;
        const filePath = path.join(this.dir, file.fileName);
        const journal = fs.statSync(filePath);
        const stableResult = (eventId: string | null) => {
          const current = fs.statSync(filePath);
          return current.size === journal.size && current.mtimeMs === journal.mtimeMs && current.ctimeMs === journal.ctimeMs
            ? { eventId } : null;
        };
        if (journal.size !== file.indexedBytes) return null;
        type RemovalIndexRow = { eventId: string; targetEventId: string; targetMessageId: string; machineId: string };
        const matches = this.db.prepare(
          'SELECT eventId, targetEventId, targetMessageId, machineId FROM message_removals WHERE canonicalKey = ? AND eventId = ?',
        );
        const agreesWithJournal = (row: RemovalIndexRow) => {
          const fact = this.getEvent(conversationKey, row.eventId);
          return fact?.kind === 'message-removed' && fact.eventId === row.eventId
            && canonicalConversationKey(fact.conversationKey) === key && fact.machineId === row.machineId
            && fact.targetEventId === row.targetEventId && fact.targetMessageId === row.targetMessageId;
        };
        const exactReceipt = removalEventId !== undefined;
        const found = (exactReceipt
          ? matches.get(key, removalEventId)
          : this.db.prepare(
            'SELECT eventId, targetEventId, targetMessageId, machineId FROM message_removals WHERE canonicalKey = ? AND targetEventId = ? AND targetMessageId = ? AND machineId = ? ORDER BY eventId LIMIT 1',
          ).get(key, targetEventId, targetMessageId, custodian)) as RemovalIndexRow | undefined;
        const verifiedAbsence = () => {
          // Check negative evidence once per local journal/index checkpoint.
          const writes = this.db.prepare('SELECT total_changes() AS count').get();
          const proof = JSON.stringify([key, file.fileName, file.indexedBytes, journal.mtimeMs, journal.ctimeMs, version, writes]);
          if (this.removalIndexProof !== proof) {
            if (!this.verifyRemovalIndex(conversationKey, filePath)) return null;
            this.removalIndexProof = proof;
          }
          return stableResult(null);
        };
        if (!found) {
          if (!proveAbsence) return null;
          if (exactReceipt && this.db.prepare('SELECT 1 FROM events WHERE canonicalKey = ? AND eventId = ?').get(key, removalEventId)) return null;
          return verifiedAbsence();
        }
        if (found.targetEventId !== targetEventId || found.targetMessageId !== targetMessageId || found.machineId !== custodian
          || !agreesWithJournal(found)) return null;
        const target = this.getEvent(conversationKey, targetEventId);
        if (!target || target.eventId !== targetEventId || canonicalConversationKey(target.conversationKey) !== key) return null;
        if ((target.kind !== 'message' && target.kind !== 'media-message') || target.messageId !== targetMessageId) {
          return exactReceipt ? null : verifiedAbsence();
        }
        return stableResult(found.eventId);
      })();
      return this.db.pragma('data_version', { simple: true }) === version ? result : null;
    } catch {
      return null; // @silent-fallback-ok — callers must treat unreadable journal evidence as unknown
    }
  }

  /** A gap or competing fact makes the slot unfit for a comparable write. */
  ownReaction(conversationKey: string, target: string, actor: string): { emoji: AppReactionEmoji | null; revision: number } | null {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const file = this.db.prepare('SELECT fileName, indexedBytes FROM files WHERE canonicalKey = ?')
      .get(canonicalKey) as { fileName: string; indexedBytes: number } | undefined;
    const custodian = this.getCreationRecord(conversationKey)?.machineId;
    if (!custodian || !file || fs.statSync(path.join(this.dir, file.fileName)).size !== file.indexedBytes) return null;
    const scope = [canonicalKey, target, actor, custodian];
    const from = 'FROM reactions r JOIN events e ON r.canonicalKey = e.canonicalKey AND r.eventId = e.eventId WHERE r.canonicalKey = ? AND r.target = ? AND r.actor = ? AND e.machineId = ?';
    const summary = this.db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT r.revision) AS distinctCount, MAX(r.revision) AS revision ${from}`)
      .get(...scope) as { total: number; distinctCount: number; revision: number | null };
    if (summary.total === 0) return { emoji: null, revision: 0 };
    if (summary.total !== summary.distinctCount || summary.distinctCount !== summary.revision) return null;
    const row = this.db.prepare(`SELECT r.emoji, r.revision ${from} AND r.revision = ?`)
      .get(...scope, summary.revision) as { emoji: AppReactionEmoji | null; revision: number } | undefined;
    return row ?? null;
  }

  /** Resolve using the selected ID domain. Legacy ambiguity is decided by the caller's ACL. */
  exactMessageCandidates(conversationKey: string, target: string, kind: 'event' | 'message' | 'legacy'): BrowsedMessage[] {
    const key = canonicalConversationKey(conversationKey);
    type Hit = { eventId: string; at: string; domain: 'event' | 'message' };
    const rows = this.db.prepare(
      `SELECT eventId, at, 'event' AS domain FROM events WHERE canonicalKey = ? AND eventId = ? AND kind IN ('message', 'media-message')
       UNION ALL SELECT eventId, at, 'message' AS domain FROM messages WHERE canonicalKey = ? AND messageId = ?`,
    ).all(key, kind === 'message' ? null : target, key, kind === 'event' ? null : target) as Hit[];
    const candidates = new Map<string, BrowsedMessage>();
    for (const row of rows) {
      const message = this.readIndexedMessage(key, row);
      if (row.domain === 'message' && message.messageId !== target) throw new Error('indexed message identity unavailable');
      candidates.set(message.eventId, message);
    }
    return [...candidates.values()];
  }

  /** Descending physical chunk, anchored to a raw stored tuple independent of delimiter syntax. */
  exactMessageChunk(conversationKey: string, boundary: { at: string; eventId: string }, inclusive: boolean, limit: number, removalCustodian?: string): BrowsedMessage[] {
    const key = canonicalConversationKey(conversationKey);
    const comparison = inclusive ? '<=' : '<';
    const removalClause = removalCustodian ? `AND NOT EXISTS (
      SELECT 1 FROM message_removals r WHERE r.canonicalKey = messages.canonicalKey
      AND r.targetEventId = messages.eventId AND r.targetMessageId = messages.messageId AND r.machineId = ?
    )` : '';
    const scope = removalCustodian ? [key, removalCustodian] : [key];
    const rows = this.db.prepare(
      `SELECT eventId, at FROM messages WHERE canonicalKey = ? ${removalClause}
       AND (at, eventId) ${comparison} (?, ?) ORDER BY at DESC, eventId DESC LIMIT ?`,
    ).all(...scope, boundary.at, boundary.eventId, limit) as Array<{ eventId: string; at: string }>;
    return rows.map((row) => this.readIndexedMessage(key, row));
  }

  private readIndexedMessage(key: string, row: { eventId: string; at: string }): BrowsedMessage {
    const ev = this.getEvent(key, row.eventId);
    if (!ev || (ev.kind !== 'message' && ev.kind !== 'media-message') || ev.eventId !== row.eventId
      || ev.at !== row.at || canonicalConversationKey(ev.conversationKey) !== key) {
      throw new Error('indexed message unavailable');
    }
    return this.projectMessage(ev);
  }

  private projectMessage(ev: StoredAppEvent & (MessageEvent | MediaMessageEvent)): BrowsedMessage {
    return {
        eventId: ev.eventId, messageId: ev.messageId, role: ev.role, text: ev.text, at: ev.at, machineId: ev.machineId,
        deliveryState: ev.forwarded ? 'delivered' : this.deliveryState(ev.messageId) ?? 'pending',
        ...(ev.forwarded ? { forwarded: true as const } : {}),
        ...(ev.origin ? { origin: ev.origin } : {}), ...(ev.receivedAt ? { receivedAt: ev.receivedAt } : {}),
        ...(ev.receipt ? { receipt: ev.receipt } : {}),
        ...(ev.replyTo ? { replyTo: ev.replyTo } : {}),
        ...(ev.kind === 'media-message' ? { attachments: ev.attachments } : {}),
        ...(ev.senderName ? { senderName: ev.senderName } : {}), ...(ev.senderRole ? { senderRole: ev.senderRole } : {}),
        ...(ev.senderPerson ? { senderPerson: ev.senderPerson } : {}),
        ...(ev.agentOrigin ? { agentOrigin: ev.agentOrigin } : {}),
        ...((ev as MessageEvent).systemSource ? { systemSource: (ev as MessageEvent).systemSource } : {}),
        ...(ev.accessStamp ? { accessStamp: ev.accessStamp } : {}),
    };
  }

  /**
   * Unread (mobile-unread-messages §3.5): the stored time of one chat message by its event id, so a
   * read report names a message this machine holds; null when it is not here (or not a message).
   */
  eventAt(conversationKey: string, eventId: string): string | null {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const row = this.db.prepare('SELECT at, kind FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, eventId) as { at: string; kind: string } | undefined;
    return row && (row.kind === 'message' || row.kind === 'media-message') ? row.at : null;
  }

  /** Unread (§3.4): this machine's newest ingestSeq for a conversation, the local revision a count is cached on. */
  newestIngestSeq(conversationKey: string): number {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const row = this.db.prepare('SELECT MAX(ingestSeq) AS s FROM events WHERE canonicalKey = ?').get(canonicalKey) as { s: number | null } | undefined;
    return row?.s ?? 0;
  }

  /** Authenticated /health: total bytes and conversation count. */
  health(): { bytes: number; count: number } {
    let bytes = 0;
    for (const dir of [this.dir, this.deletedDir]) {
      try {
        for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl')) bytes += fs.statSync(path.join(dir, n)).size;
      } catch { /* @silent-fallback-ok — observability only */ }
    }
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%'").get() as { c: number }).c;
    return { bytes, count };
  }

  close(): void { try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ } }
}

function toSummary(r: Record<string, unknown>): ConversationSummary {
  return {
    conversationKey: String(r.conversationKey), canonicalKey: String(r.canonicalKey),
    title: (r.title as string | null) ?? null, createdAt: (r.createdAt as string | null) ?? null,
    lastActivity: (r.lastActivity as string | null) ?? null, lastPreview: (r.lastPreview as string | null) ?? null,
    tombstoned: r.tombstoned === 1,
    ownerPerson: typeof r.ownerMachine === 'string' && typeof r.ownerUser === 'string' ? { machineId: r.ownerMachine, userId: r.ownerUser } : null,
  };
}
