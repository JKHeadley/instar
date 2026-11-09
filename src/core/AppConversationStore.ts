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
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from './SqliteRegistry.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { canonicalConversationKey, cleanConversationTitle, derivedEventId } from './appConversationText.js';
import { type AppAttachment, validateAttachments, MAX_PURGE_BATCH, mediaPreview } from './appMediaTypes.js';
import { validConversationOwner, type ConversationOwner } from './MobilePeople.js';
import type { AccessStamp } from './TeamAccessMerge.js';

export type AppEventKind = 'created' | 'label' | 'tombstone' | 'message' | 'delivery' | 'media-message' | 'purge' | 'platform-media' | 'transcript';
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
export interface MachineReceipt { machineId: string; signerKeyHash: string; sig: string; v?: 2; conversationKey?: string }

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
export interface CreatedEvent extends AppEventBase { kind: 'created'; title: string; ownerPerson?: ConversationOwner }
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
export type AppEvent = CreatedEvent | LabelEvent | TombstoneEvent | MessageEvent | DeliveryEvent | MediaMessageEvent | PurgeEvent | PlatformMediaEvent | TranscriptEvent;

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
  attachments?: AppAttachment[];
  senderName?: string;
  senderRole?: 'owner' | 'msp' | 'team';
  /** Unread (mobile-unread-messages §3.4): the sender's registry person, so a count can tell a reader's own rows. */
  senderPerson?: ConversationOwner;
  agentOrigin?: MessageOriginEvidence;
  accessStamp?: AccessStamp;
}

/** One attachment reference as the index holds it. */
export interface MediaRef {
  attachmentId: string; sha256: string; size: number; canonicalKey: string; messageId: string; idx: number; purged: boolean; tombstoned: boolean;
}

export const MAX_STORED_TEXT = 16_000;
const PREVIEW_CHARS = 140;
const MAX_LINE_BYTES = 256 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (canonicalKey TEXT PRIMARY KEY, fileName TEXT NOT NULL, indexedBytes INTEGER NOT NULL, nextIngestSeq INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS events (canonicalKey TEXT NOT NULL, ingestSeq INTEGER NOT NULL, eventId TEXT NOT NULL, messageId TEXT, kind TEXT NOT NULL, at TEXT NOT NULL, machineId TEXT NOT NULL, byteOffset INTEGER NOT NULL, byteLength INTEGER NOT NULL, PRIMARY KEY (canonicalKey, eventId))`,
  `CREATE INDEX IF NOT EXISTS events_seq ON events(canonicalKey, ingestSeq)`,
  `CREATE INDEX IF NOT EXISTS events_at ON events(canonicalKey, at, eventId)`,
  `CREATE TABLE IF NOT EXISTS messages (messageId TEXT PRIMARY KEY, canonicalKey TEXT NOT NULL, eventId TEXT NOT NULL, at TEXT NOT NULL, deliveryState TEXT NOT NULL, lastPreview TEXT)`,
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
      return { ...base, kind: 'created', title, ...(ownerPerson ? { ownerPerson } : {}) };
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
  return { machineId, signerKeyHash, sig };
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

export class AppConversationStore {
  readonly dir: string;
  private readonly deletedDir: string;
  private db: BetterSqliteDatabase;
  private readonly now: () => number;
  private readonly reported = new Set<string>();
  private onLocalAppend: ((event: AppEvent) => void) | undefined;
  private stamps: AccessStamps | null = null;

  constructor(private readonly opts: AppConversationStoreOptions) {
    this.dir = path.join(opts.stateDir, 'app-conversations');
    this.deletedDir = path.join(this.dir, 'deleted');
    this.now = opts.now ?? Date.now;
    this.onLocalAppend = opts.onLocalAppend;
    fs.mkdirSync(this.deletedDir, { recursive: true, mode: 0o700 });
    this.db = this.openIndex();
    registerSqliteHandle(() => { try { this.db.close(); } catch { /* @silent-fallback-ok — already closed */ } });
    this.catchUp();
  }

  setReplicationHook(hook: ((event: AppEvent) => void) | undefined): void { this.onLocalAppend = hook; }

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
    this.db.exec('DELETE FROM files; DELETE FROM events; DELETE FROM messages; DELETE FROM deliveries; DELETE FROM conversations; DELETE FROM media_refs; DELETE FROM media_blobs; DELETE FROM media_purged; DELETE FROM media_totals; DELETE FROM transcripts;');
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
      this.db.prepare('DELETE FROM events WHERE canonicalKey = ?').run(row.canonicalKey);
      from = 0;
    }
    if (from >= size) return;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
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

  /** Append a locally-created event (dedup by eventId). The replication hook fires on a new commit. */
  append(input: AppEvent): { appended: boolean; ingestSeq: number } {
    const stamp = (input.kind === 'message' || input.kind === 'media-message') && !input.accessStamp ? this.stamps?.stamp(input) ?? null : null;
    const event = stamp ? { ...input, accessStamp: stamp } as AppEvent : input;
    const r = this.write(event);
    if (r.appended) { try { this.onLocalAppend?.(event); } catch { /* @silent-fallback-ok — replication emit is best-effort, the local commit already landed */ } }
    return r;
  }

  /** Ingest an event received by replication: validated, de-duplicated, never re-emitted. */
  ingestReplicated(raw: unknown): { appended: boolean; ingestSeq: number } | null {
    const ev = validateAppEvent(raw);
    if (!ev) return null;
    const r = this.write(ev);
    if (r.appended && (ev.kind === 'message' || ev.kind === 'media-message') && ev.accessStamp) this.stamps?.saw(ev.accessStamp);
    return r;
  }

  /** Team access stamps messages once it knows there is something to protect. */
  useAccessStamps(stamps: AccessStamps): void { this.stamps = stamps; }

  private write(event: AppEvent): { appended: boolean; ingestSeq: number } {
    const canonicalKey = canonicalConversationKey(event.conversationKey);
    const existing = this.db.prepare('SELECT ingestSeq FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, event.eventId) as { ingestSeq: number } | undefined;
    if (existing) return { appended: false, ingestSeq: existing.ingestSeq };
    const file = this.db.prepare('SELECT fileName, nextIngestSeq FROM files WHERE canonicalKey = ?').get(canonicalKey) as { fileName: string; nextIngestSeq: number } | undefined;
    const fileName = file?.fileName ?? this.fileNameFor(canonicalKey);
    const ingestSeq = file?.nextIngestSeq ?? 1;
    const line = `${JSON.stringify({ ...event, ingestSeq })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_LINE_BYTES) throw new Error('app conversation event too large');
    const filePath = path.join(this.dir, fileName);
    const created = !fs.existsSync(filePath);
    const fd = fs.openSync(filePath, 'a', 0o600); /* state-registry: app-conversations */
    let offset: number;
    try {
      offset = fs.fstatSync(fd).size;
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
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
      this.db.transaction(() => {
        if (!file) this.db.prepare('INSERT OR REPLACE INTO files (canonicalKey, fileName, indexedBytes, nextIngestSeq) VALUES (?, ?, ?, ?)').run(canonicalKey, fileName, 0, 1);
        this.indexEvent({ ...event, ingestSeq }, fileName, offset, bytes - 1);
        this.db.prepare('UPDATE files SET indexedBytes = ? WHERE canonicalKey = ?').run(offset + bytes, canonicalKey);
      })();
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
    const canonicalKey = canonicalConversationKey(ev.conversationKey);
    // The file's current location is the one being indexed (a moved-to-deleted file re-points it).
    this.db.prepare('INSERT INTO files (canonicalKey, fileName, indexedBytes, nextIngestSeq) VALUES (?, ?, 0, 1) ON CONFLICT(canonicalKey) DO UPDATE SET fileName = excluded.fileName')
      .run(canonicalKey, fileName);
    const ins = this.db.prepare('INSERT OR IGNORE INTO events (canonicalKey, ingestSeq, eventId, messageId, kind, at, machineId, byteOffset, byteLength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(canonicalKey, ev.ingestSeq, ev.eventId, 'messageId' in ev ? ev.messageId : null, ev.kind, ev.at, ev.machineId, byteOffset, byteLength);
    this.db.prepare('UPDATE files SET nextIngestSeq = MAX(nextIngestSeq, ?) WHERE canonicalKey = ?').run(ev.ingestSeq + 1, canonicalKey);
    if (ins.changes === 0) return;
    this.db.prepare('INSERT OR IGNORE INTO conversations (canonicalKey, conversationKey) VALUES (?, ?)').run(canonicalKey, ev.conversationKey);
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
        return;
      }
      case 'tombstone':
        this.tombstoneMediaRefs(canonicalKey);
        this.db.prepare('UPDATE conversations SET tombstoned = 1 WHERE canonicalKey = ?').run(canonicalKey);
        return;
      case 'purge':
        for (const id of ev.attachmentIds) this.purgeMediaRef(id);
        return;
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
        this.db.prepare('INSERT OR IGNORE INTO messages (messageId, canonicalKey, eventId, at, deliveryState, lastPreview) VALUES (?, ?, ?, ?, ?, ?)')
          .run(ev.messageId, canonicalKey, ev.eventId, ev.at, state, preview);
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
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    let rows: Array<Record<string, unknown>>;
    const act = `COALESCE(lastActivity, createdAt, '')`;
    if (opts.cursor && opts.cursor.includes('|')) {
      const i = opts.cursor.lastIndexOf('|');
      const ca = opts.cursor.slice(0, i);
      const ck = opts.cursor.slice(i + 1);
      rows = this.db.prepare(`SELECT * FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%' AND (${act} < ? OR (${act} = ? AND canonicalKey < ?)) ORDER BY ${act} DESC, canonicalKey DESC LIMIT ?`).all(ca, ca, ck, limit + 1) as Array<Record<string, unknown>>;
    } else {
      rows = this.db.prepare(`SELECT * FROM conversations WHERE tombstoned = 0 AND canonicalKey LIKE 'app:%' ORDER BY ${act} DESC, canonicalKey DESC LIMIT ?`).all(limit + 1) as Array<Record<string, unknown>>;
    }
    const more = rows.length > limit;
    const page = rows.slice(0, limit).map(toSummary);
    const last = page[page.length - 1];
    return { conversations: page, nextCursor: more && last ? `${last.lastActivity ?? last.createdAt ?? ''}|${last.canonicalKey}` : null };
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
    const canonicalKey = canonicalConversationKey(conversationKey);
    const self = this.opts.machineId();
    let after = 0;
    if (cursor) {
      try {
        const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { m?: unknown; s?: unknown };
        if (c.m === self && typeof c.s === 'number' && c.s >= 0) after = c.s;
      } catch { /* @silent-fallback-ok — an unreadable cursor restarts from the beginning (the client de-duplicates) */ }
    }
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare('SELECT ingestSeq, byteOffset, byteLength FROM events WHERE canonicalKey = ? AND ingestSeq > ? ORDER BY ingestSeq ASC LIMIT ?').all(canonicalKey, after, n) as Array<{ ingestSeq: number; byteOffset: number; byteLength: number }>;
    const events: StoredAppEvent[] = [];
    let last = after;
    for (const r of rows) {
      last = r.ingestSeq;
      const ev = this.readEventAt(canonicalKey, r.byteOffset, r.byteLength);
      if (ev) events.push(ev);
    }
    return { events, cursor: Buffer.from(JSON.stringify({ m: self, s: last })).toString('base64url') };
  }

  /**
   * BROWSE read (§4.5): messages paged BACKWARDS in `(at, eventId)` order, each with its reduced
   * delivery state. `before` is `<at>,<eventId>` (exclusive). The page is returned oldest-first,
   * with `nextBefore` naming the oldest row when older messages remain.
   */
  browseMessages(conversationKey: string, before: string | null | undefined, limit = 100): { messages: BrowsedMessage[]; nextBefore: string | null } {
    const canonicalKey = canonicalConversationKey(conversationKey);
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    let rows: Array<{ eventId: string; at: string }>;
    const b = typeof before === 'string' ? before.split(',') : null;
    if (b && b.length === 2 && b[0] && b[1]) {
      rows = this.db.prepare('SELECT eventId, at FROM messages WHERE canonicalKey = ? AND (at < ? OR (at = ? AND eventId < ?)) ORDER BY at DESC, eventId DESC LIMIT ?').all(canonicalKey, b[0], b[0], b[1], n + 1) as typeof rows;
    } else {
      rows = this.db.prepare('SELECT eventId, at FROM messages WHERE canonicalKey = ? ORDER BY at DESC, eventId DESC LIMIT ?').all(canonicalKey, n + 1) as typeof rows;
    }
    const more = rows.length > n;
    const page = rows.slice(0, n);
    const out: BrowsedMessage[] = [];
    for (const r of page) {
      const loc = this.db.prepare('SELECT byteOffset, byteLength FROM events WHERE canonicalKey = ? AND eventId = ?').get(canonicalKey, r.eventId) as { byteOffset: number; byteLength: number } | undefined;
      const ev = loc ? this.readEventAt(canonicalKey, loc.byteOffset, loc.byteLength) : null;
      if (!ev || (ev.kind !== 'message' && ev.kind !== 'media-message')) continue;
      out.push({
        eventId: ev.eventId, messageId: ev.messageId, role: ev.role, text: ev.text, at: ev.at, machineId: ev.machineId,
        deliveryState: this.deliveryState(ev.messageId) ?? 'pending',
        ...(ev.origin ? { origin: ev.origin } : {}), ...(ev.receivedAt ? { receivedAt: ev.receivedAt } : {}),
        ...(ev.receipt ? { receipt: ev.receipt } : {}),
        ...(ev.kind === 'media-message' ? { attachments: ev.attachments } : {}),
        ...(ev.senderName ? { senderName: ev.senderName } : {}), ...(ev.senderRole ? { senderRole: ev.senderRole } : {}),
        ...(ev.senderPerson ? { senderPerson: ev.senderPerson } : {}),
        ...(ev.agentOrigin ? { agentOrigin: ev.agentOrigin } : {}),
        ...(ev.accessStamp ? { accessStamp: ev.accessStamp } : {}),
      });
    }
    out.reverse();
    const oldest = page[page.length - 1];
    return { messages: out, nextBefore: more && oldest ? `${oldest.at},${oldest.eventId}` : null };
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
