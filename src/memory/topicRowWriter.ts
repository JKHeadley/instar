/**
 * topicRowWriter — the channel-neutral TopicMemory row writer
 * (docs/specs/context-budget-layered-summaries.md §14, "U bodies and the
 * message-row source"; §8 for the row origin; §6.1 for the operator binding).
 *
 * Every channel that feeds a conversation writes its message rows through ONE
 * function, `writeRow(channel, …)`, which applies the KEY RULE every machine
 * derives identically, because layer references `(message id, hash, length)`
 * must match across machines:
 *
 *   - Telegram: the native message id;
 *   - Slack:    `ts × 1e6` (the `ts` string "1700000000.123456" read exactly,
 *               never through a float), so two messages in one channel are two
 *               rows under `UNIQUE(message_id, topic_id)` — the old writer cast
 *               every Slack id to 0 and collapsed a channel into one row;
 *   - app conversations and other channels: `physicalMs × 1000 + (logical mod 1000)`
 *               from the message's hybrid-logical stamp, which stays under 2^53
 *               until the year 2255.
 *
 * The channel's own id is kept verbatim in `channel_message_id` (Telegram the
 * native id, Slack the `ts`, an app conversation the event id). An integer key
 * already held by a DIFFERENT channel message is a COUNTED refusal (a counter
 * plus a DegradationReporter row), never a silent drop.
 *
 * App conversations: a stored app event carries no HLC of its own (the stamp
 * is applied by the replication emitter and is not part of the event, and a
 * single machine never emits one), so its stamp is derived from the event's
 * own immutable fields: `physical` is the accepting machine's `at`, and
 * `logical` a slot derived from the event id. Both travel unchanged with the
 * event to every machine, so every machine derives the same integer.
 *
 * Which channels are row sources is answered here too (`hasRowSource`), so the
 * fold precondition (`fold-skipped: no-row-source`) and the writers cannot
 * disagree.
 */
import crypto from 'node:crypto';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { TopicMemory, TopicMessage, TopicRowOrigin, KeyedInsertResult } from './TopicMemory.js';

export type RowChannel = 'telegram' | 'slack' | 'app';

/** A hybrid-logical stamp as the key rule reads it. */
export interface RowHlc { physicalMs: number; logical: number }

/** The channel-specific identity of one message. */
export type RowIdentity =
  | { channel: 'telegram'; nativeId: number }
  | { channel: 'slack'; ts: string }
  | { channel: 'app'; eventId: string; hlc: RowHlc };

/** The channel-neutral body of one row (everything but its key and topic). */
export interface RowBody {
  topicId: number;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  telegramUserId?: number;
  /** The UserManager profile id of the sender (the operator binding, §6.1), when resolved. */
  userId?: string;
  forwarded?: boolean;
  /** Set only for a row that reached this topic through another agent (§8). */
  origin?: TopicRowOrigin;
}

export type RowKey = { messageId: number; channelMessageId: string };

/** Slack's `ts`: seconds, a dot, up to six digits of microseconds. */
const SLACK_TS_RE = /^(\d{1,12})\.(\d{1,6})$/;

/**
 * The key rule (§14). Pure and deterministic: the same identity yields the
 * same key on every machine. Returns an error string for an identity that
 * cannot be keyed (never a guessed key).
 */
export function deriveRowKey(id: RowIdentity): RowKey | { error: string } {
  switch (id.channel) {
    case 'telegram': {
      if (!Number.isSafeInteger(id.nativeId) || id.nativeId <= 0) return { error: `telegram id is not a positive integer: ${String(id.nativeId)}` };
      return { messageId: id.nativeId, channelMessageId: String(id.nativeId) };
    }
    case 'slack': {
      const m = typeof id.ts === 'string' ? SLACK_TS_RE.exec(id.ts) : null;
      if (!m) return { error: `slack ts is not "<seconds>.<micros>": ${String(id.ts)}` };
      const messageId = Number(m[1]) * 1_000_000 + Number(m[2].padEnd(6, '0'));
      if (!Number.isSafeInteger(messageId)) return { error: `slack ts is out of range: ${id.ts}` };
      return { messageId, channelMessageId: id.ts };
    }
    case 'app': {
      const { physicalMs, logical } = id.hlc ?? ({} as RowHlc);
      if (typeof id.eventId !== 'string' || id.eventId.length === 0) return { error: 'app event has no event id' };
      if (!Number.isSafeInteger(physicalMs) || physicalMs <= 0) return { error: `app event stamp is not a time: ${String(physicalMs)}` };
      if (!Number.isSafeInteger(logical) || logical < 0) return { error: `app event logical counter is invalid: ${String(logical)}` };
      const messageId = physicalMs * 1000 + (logical % 1000);
      if (!Number.isSafeInteger(messageId)) return { error: `app event stamp is out of range: ${physicalMs}` };
      return { messageId, channelMessageId: id.eventId };
    }
    default:
      return { error: `unknown channel: ${String((id as { channel?: unknown }).channel)}` };
  }
}

/**
 * The stamp of a stored app event (see the header): the accepting machine's
 * `at` and a slot derived from the event id. Null when `at` is unreadable.
 */
export function appEventHlc(ev: { eventId: string; at: string }): RowHlc | null {
  const physicalMs = Date.parse(ev.at);
  if (!Number.isFinite(physicalMs)) return null;
  const logical = crypto.createHash('sha256').update(String(ev.eventId)).digest().readUInt32BE(0) % 1000;
  return { physicalMs, logical };
}

/**
 * Which channel a TopicMemory topic id belongs to, from the id spaces the
 * channels mint: Telegram topic ids are positive; Slack's synthetic ids are
 * `-(|int32 hash| + 1)` walked down at most 64 (`conversationIdentity.ts`), so
 * they sit in [-(2^31 + 65), -1]; app-conversation aliases are
 * `-(2^33 + h)` walked down (`ConversationRegistry.mintAppAlias`), so they sit
 * at or below -2^33. Anything else has no known channel.
 */
export function rowChannelForTopicId(topicId: number): RowChannel | null {
  if (!Number.isSafeInteger(topicId) || topicId === 0) return null;
  if (topicId > 0) return 'telegram';
  if (topicId >= -(2 ** 31 + 65)) return 'slack';
  if (topicId <= -(2 ** 33)) return 'app';
  return null;
}

export type RowRefusal = 'collision' | 'key-mismatch' | 'bad-key' | 'not-ready';

export type WriteRowResult =
  | { written: true; outcome: 'inserted' | 'adopted' | 'duplicate'; key: RowKey }
  | { written: false; refused: RowRefusal; detail: string; key?: RowKey }
  | { written: false; skipped: 'channel-off' };

export interface RowWriterCounts {
  inserted: number;
  adopted: number;
  duplicate: number;
  refused: Record<RowRefusal, number>;
}

export interface TopicRowWriterDeps {
  /** The live TopicMemory (read on every write: it may open after the writer is built). */
  topicMemory: () => TopicMemory | null | undefined;
  /**
   * Is new row writing on for this channel? Telegram and Slack are always on
   * (Slack's key is a correctness fix). App conversations are behind
   * `contextBudget.enabled`, read live by the caller. Absent ⇒ always on.
   */
  channelEnabled?: (channel: RowChannel) => boolean;
  /** Where a counted refusal is reported. Defaults to the DegradationReporter singleton. */
  reportRefusal?: (e: { channel: RowChannel; refused: RowRefusal; detail: string; topicId?: number }) => void;
}

const ALWAYS_ON: ReadonlySet<RowChannel> = new Set(['telegram', 'slack']);

export class TopicRowWriter {
  private readonly counts = new Map<RowChannel, RowWriterCounts>();

  constructor(private readonly deps: TopicRowWriterDeps) {}

  /** Is new row writing on for this channel right now? */
  channelOn(channel: RowChannel): boolean {
    if (ALWAYS_ON.has(channel)) return true;
    try {
      return this.deps.channelEnabled ? this.deps.channelEnabled(channel) === true : true;
    } catch {
      // @silent-fallback-ok — an unreadable switch reads as OFF (fail closed: no new rows, and the fold refuses no-row-source)
      return false;
    }
  }

  /**
   * Does a topic have a row source (§14)? True only when its channel has a
   * writer that is on. A topic on a channel without one refuses to fold
   * (`fold-skipped: no-row-source`).
   */
  hasRowSource(topicId: number): boolean {
    const channel = rowChannelForTopicId(topicId);
    return channel !== null && this.channelOn(channel);
  }

  /** Write one message row under the key rule. */
  writeRow(identity: RowIdentity, body: RowBody): WriteRowResult {
    const channel = identity.channel;
    if (!this.channelOn(channel)) return { written: false, skipped: 'channel-off' };
    const key = deriveRowKey(identity);
    if ('error' in key) return this.refuse(channel, 'bad-key', key.error, body.topicId);
    const tm = this.deps.topicMemory();
    if (!tm || !tm.isReady()) return this.refuse(channel, 'not-ready', 'TopicMemory is not open', body.topicId, key);
    const msg: TopicMessage & { channelMessageId: string } = {
      ...body,
      messageId: key.messageId,
      channelMessageId: key.channelMessageId,
    };
    const r: KeyedInsertResult = tm.insertKeyedMessage(msg);
    switch (r.outcome) {
      case 'inserted':
      case 'adopted':
      case 'duplicate':
        this.bucket(channel)[r.outcome]++;
        return { written: true, outcome: r.outcome, key };
      case 'collision':
        return this.refuse(channel, 'collision',
          `integer key ${key.messageId} in conversation ${body.topicId} is held by channel message ${r.existingChannelMessageId}; ${key.channelMessageId} was not stored`,
          body.topicId, key);
      case 'key-mismatch':
        return this.refuse(channel, 'key-mismatch',
          `channel message ${key.channelMessageId} is stored under key ${r.existingMessageId}, not ${key.messageId}`,
          body.topicId, key);
      case 'not-ready':
        return this.refuse(channel, 'not-ready', 'TopicMemory is not open', body.topicId, key);
    }
  }

  /** Count and report a message that could not be keyed before reaching the key rule. */
  refuseUnkeyed(channel: RowChannel, detail: string, topicId?: number): WriteRowResult {
    if (!this.channelOn(channel)) return { written: false, skipped: 'channel-off' };
    return this.refuse(channel, 'bad-key', detail, topicId);
  }

  /** Per-channel counts since boot (refusals included), for tests and health reads. */
  stats(): Record<RowChannel, RowWriterCounts> {
    const out = {} as Record<RowChannel, RowWriterCounts>;
    for (const ch of ['telegram', 'slack', 'app'] as const) out[ch] = structuredClone(this.bucket(ch));
    return out;
  }

  private bucket(channel: RowChannel): RowWriterCounts {
    let b = this.counts.get(channel);
    if (!b) {
      b = { inserted: 0, adopted: 0, duplicate: 0, refused: { collision: 0, 'key-mismatch': 0, 'bad-key': 0, 'not-ready': 0 } };
      this.counts.set(channel, b);
    }
    return b;
  }

  private refuse(channel: RowChannel, refused: RowRefusal, detail: string, topicId?: number, key?: RowKey): WriteRowResult {
    this.bucket(channel).refused[refused]++;
    try {
      if (this.deps.reportRefusal) this.deps.reportRefusal({ channel, refused, detail, ...(topicId !== undefined ? { topicId } : {}) });
      else {
        DegradationReporter.getInstance().report({
          feature: `TopicRowWriter.${channel}`,
          primary: 'Store every conversation message as its own TopicMemory row under the channel key rule',
          fallback: 'This message was not stored as a row (counted refusal); the conversation cannot fold past it until it is',
          reason: `${refused}: ${detail}`,
          impact: 'A message is missing from the conversation memory the context-budget layers are built from.',
        });
      }
    } catch {
      // @silent-fallback-ok — reporting must never throw into a message path; the refusal is still counted
    }
    return { written: false, refused, detail, ...(key ? { key } : {}) };
  }
}

/** The fields of a stored app message event the row writer reads. */
export interface AppMessageEventLike {
  eventId: string;
  kind: string;
  conversationKey: string;
  at: string;
  role: 'operator' | 'agent';
  text: string;
  senderName?: string;
  senderRole?: 'owner' | 'msp' | 'team';
  senderPerson?: { machineId: string; userId: string };
}

/**
 * Write one app-conversation message as a TopicMemory row (§14). The topic id
 * is this machine's alias for the conversation; an event whose conversation
 * has no alias here yet is a counted `bad-key` refusal (never a guessed id).
 * The operator binding (§6.1): an operator message from the owner's phone
 * carries the owner's user id, one from a team or MSP phone its own person;
 * agent rows carry none. App messages are typed in the app, never forwarded.
 */
export function writeAppConversationRow(
  writer: TopicRowWriter,
  ev: AppMessageEventLike,
  d: { aliasFor: (conversationKey: string) => number | null; ownerUserId: () => string | null },
): WriteRowResult {
  const alias = d.aliasFor(ev.conversationKey);
  const hlc = appEventHlc(ev);
  const fromUser = ev.role === 'operator';
  const userId = !fromUser ? undefined
    : ev.senderPerson?.userId ?? (ev.senderRole === undefined || ev.senderRole === 'owner' ? d.ownerUserId() ?? undefined : undefined);
  const body: RowBody = {
    topicId: alias ?? 0,
    text: ev.text,
    fromUser,
    timestamp: ev.at,
    sessionName: null,
    ...(ev.senderName ? { senderName: ev.senderName } : {}),
    ...(userId ? { userId } : {}),
    forwarded: false,
  };
  if (alias === null) {
    return writer.refuseUnkeyed('app', `conversation ${ev.conversationKey} has no alias on this machine; event ${ev.eventId} was not stored`);
  }
  if (!hlc) {
    return writer.refuseUnkeyed('app', `event ${ev.eventId} has an unreadable time "${ev.at}"`, alias);
  }
  return writer.writeRow({ channel: 'app', eventId: ev.eventId, hlc }, body);
}

/** The fields of a Slack message-log entry the row writer reads (`MessageLogger.LogEntry`). */
export interface SlackLogEntryLike {
  messageId: number | string;
  channelId: number | string | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  platformUserId?: number | string;
  forwarded?: boolean;
}

/**
 * Write one Slack message-log entry as a TopicMemory row (§14): keyed by its
 * `ts` (×1e6), filed under the channel's synthetic topic id, and — for a
 * person's message — bound to the UserManager person the Slack user resolves
 * to (§6.1). An unresolved sender stores no user id (never the raw Slack id,
 * which is not a person key). Returns null for an entry with no channel.
 */
export function writeSlackLogRow(
  writer: TopicRowWriter,
  entry: SlackLogEntryLike,
  d: { topicIdFor: (channelId: string) => number; resolveUserId: (slackUserId: string) => string | null | undefined },
): WriteRowResult | null {
  if (!entry.channelId) return null;
  const slackUser = entry.platformUserId != null ? String(entry.platformUserId) : '';
  const userId = entry.fromUser && slackUser ? d.resolveUserId(slackUser) ?? undefined : undefined;
  return writer.writeRow({ channel: 'slack', ts: String(entry.messageId) }, {
    topicId: d.topicIdFor(String(entry.channelId)),
    text: entry.text,
    fromUser: entry.fromUser,
    timestamp: entry.timestamp,
    sessionName: entry.sessionName,
    ...(entry.senderName ? { senderName: entry.senderName } : {}),
    ...(userId ? { userId } : {}),
    ...(entry.forwarded !== undefined ? { forwarded: entry.forwarded } : {}),
  });
}
