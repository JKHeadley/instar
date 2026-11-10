/**
 * topicRowCarrier — the relay-path row carrier (docs/specs/context-budget-layered-summaries.md
 * §14 "U bodies and the message-row source", §18).
 *
 * Rows are written on the machine whose adapter received the message. The
 * forward-to-owner path (`deliverMessage`) already carries every message to the
 * topic's owner at least once with a durable receipt, so it also carries the
 * message's TopicMemory row: the forwarding machine reads the row it stored
 * (S2's key rule: `channel_message_id`, `origin`, the resolved person) and the
 * owner lands it through the same `TopicRowWriter` before the receipt, keyed and
 * idempotent. Each carried row has a seq in the forwarder's stream, and the
 * owner's contiguous-ack watermark (`topicRowWatermark.ts`) says whether its
 * TopicMemory holds the topic's rows up to the last one.
 *
 * A gap (a seq that never arrived, or arrived without a row) is pulled from the
 * stream's machine over the signed `topic-row-pull` verb; a topic that moves to
 * a new owner pulls the previous owner's recent rows and stream heads. Pulls are
 * bounded; seqs older than the bound are recorded as the stream's floor, which
 * stays visible on the status. App conversations need no carrier: their rows are
 * written on every machine from the replicated store (S2).
 *
 * Older peers: a forwarder without the carrier sends no `row` field; an owner
 * without it ignores the field. The owner still records every accepted message
 * as expected, so a row nobody carried keeps the topic not clean.
 */
import { isSlackConversationKey } from '../core/SlackForwardBridge.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { TopicMemory, TopicMessage } from './TopicMemory.js';
import { coerceTopicRowOrigin } from './TopicMemory.js';
import { rowChannelForTopicId, type RowBody, type RowIdentity, type TopicRowWriter } from './topicRowWriter.js';
import { isStreamId, streamMachine, type StreamGap, type StreamState, type TopicRowWatermarkStore } from './topicRowWatermark.js';

/** Is the row carrier on? `contextBudget.enabled`, read live, resolved through the development-agent gate. */
export function rowCarrierEnabled(explicit: boolean | undefined, config: { developmentAgent?: boolean } | undefined): boolean {
  return resolveDevAgentGate(typeof explicit === 'boolean' ? explicit : undefined, config);
}

/** Bounds of one carried row and of one pull. */
export const CARRIED_TEXT_MAX = 64 * 1024;
export const ROW_PULL_MAX_ROWS = 500;
export const ROW_PULL_MAX_BYTES = 2 * 1024 * 1024;
export const ROW_PULL_TIMEOUT_MS = 15_000;

export type CarriedChannel = 'telegram' | 'slack';

/** The row fields carried on `deliverMessage` (everything but the topic id, which each machine derives). */
export interface CarriedRowBody {
  channel: CarriedChannel;
  channelMessageId: string;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  telegramUserId?: number;
  userId?: string;
  forwarded?: boolean;
  origin?: 'relay' | 'a2a';
}

export interface CarriedRow {
  v: 1;
  stream: string;
  seq: number;
  /** Null when the forwarder had no stored row for the message: the owner records a gap. */
  row: CarriedRowBody | null;
}

/** Where a message's row lives: channel, this machine's TopicMemory topic id and the channel's own id. */
export interface RowAddress { channel: CarriedChannel; topicId: number; channelMessageId: string }

/**
 * Address a routed message (Telegram: the topic and native id; Slack: the
 * channel's synthetic topic id and the `ts`). Null for anything else (app
 * conversations, dashboard starts), which carries no row.
 */
export function rowAddressFor(sessionKey: string, messageId: string, slackTopicId: (channelId: string) => number): RowAddress | null {
  if (typeof sessionKey !== 'string' || typeof messageId !== 'string') return null;
  if (/^\d+$/.test(sessionKey)) {
    const topicId = Number(sessionKey);
    // The router is handed the adapter's id (`tg-<n>`); a drained or older entry may carry the bare number.
    const native = messageId.startsWith('tg-') ? messageId.slice('tg-'.length) : messageId;
    if (!Number.isSafeInteger(topicId) || topicId <= 0 || !/^\d+$/.test(native)) return null;
    return { channel: 'telegram', topicId, channelMessageId: native };
  }
  if (isSlackConversationKey(sessionKey)) {
    const raw = sessionKey.startsWith('slack:') ? sessionKey.slice('slack:'.length) : sessionKey;
    const channelId = raw.split(':')[0];
    const ts = messageId.startsWith('slack-') ? messageId.slice('slack-'.length) : messageId;
    if (!ts) return null;
    return { channel: 'slack', topicId: slackTopicId(channelId), channelMessageId: ts };
  }
  return null;
}

/**
 * Slack's synthetic TopicMemory topic id for a channel: a pure hash of the channel
 * id, negated (the server's `slackChannelToSyntheticId` uses exactly this), so
 * every machine files a channel's rows under the same id.
 */
export function slackSyntheticTopicId(channelId: string): number {
  let hash = 0;
  for (let i = 0; i < channelId.length; i++) hash = ((hash << 5) - hash + channelId.charCodeAt(i)) | 0;
  return -(Math.abs(hash) + 1);
}

/** The topic key the watermark uses: this machine's TopicMemory topic id. */
export function watermarkKey(topicId: number): string { return String(topicId); }

function rowBodyFrom(m: TopicMessage, channel: CarriedChannel, channelMessageId: string): CarriedRowBody {
  return {
    channel,
    channelMessageId,
    text: m.text,
    fromUser: m.fromUser,
    timestamp: m.timestamp,
    sessionName: m.sessionName ?? null,
    ...(m.senderName ? { senderName: m.senderName } : {}),
    ...(m.senderUsername ? { senderUsername: m.senderUsername } : {}),
    ...(typeof m.telegramUserId === 'number' ? { telegramUserId: m.telegramUserId } : {}),
    ...(m.userId ? { userId: m.userId } : {}),
    ...(m.forwarded !== undefined ? { forwarded: m.forwarded } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
  };
}

const optStr = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Validate a carried row body from a peer. A signed peer is still re-validated: every field is typed and bounded. */
export function parseCarriedRowBody(raw: unknown): CarriedRowBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.channel !== 'telegram' && r.channel !== 'slack') return null;
  if (typeof r.channelMessageId !== 'string' || r.channelMessageId.length === 0 || r.channelMessageId.length > 256) return null;
  if (typeof r.text !== 'string' || r.text.length > CARRIED_TEXT_MAX) return null;
  if (typeof r.fromUser !== 'boolean' || typeof r.timestamp !== 'string' || r.timestamp.length > 64) return null;
  if (r.sessionName !== null && r.sessionName !== undefined && typeof r.sessionName !== 'string') return null;
  const telegramUserId = typeof r.telegramUserId === 'number' && Number.isSafeInteger(r.telegramUserId) ? r.telegramUserId : undefined;
  const origin = coerceTopicRowOrigin(r.origin);
  const senderName = optStr(r.senderName, 256);
  const senderUsername = optStr(r.senderUsername, 256);
  const userId = optStr(r.userId, 256);
  return {
    channel: r.channel,
    channelMessageId: r.channelMessageId,
    text: r.text,
    fromUser: r.fromUser,
    timestamp: r.timestamp,
    sessionName: typeof r.sessionName === 'string' ? r.sessionName.slice(0, 256) : null,
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
    ...(telegramUserId !== undefined ? { telegramUserId } : {}),
    ...(userId ? { userId } : {}),
    ...(typeof r.forwarded === 'boolean' ? { forwarded: r.forwarded } : {}),
    ...(origin ? { origin } : {}),
  };
}

export function parseCarriedRow(raw: unknown): CarriedRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !isStreamId(r.stream)) return null;
  if (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 1) return null;
  if (r.row === null) return { v: 1, stream: r.stream, seq: r.seq, row: null };
  const row = parseCarriedRowBody(r.row);
  return row ? { v: 1, stream: r.stream, seq: r.seq, row } : null;
}

function identityOf(row: CarriedRowBody): RowIdentity | null {
  if (row.channel === 'telegram') {
    const n = Number(row.channelMessageId);
    return /^\d+$/.test(row.channelMessageId) && Number.isSafeInteger(n) && n > 0 ? { channel: 'telegram', nativeId: n } : null;
  }
  return { channel: 'slack', ts: row.channelMessageId };
}

export type LandResult =
  | { landed: true; outcome: 'inserted' | 'adopted' | 'duplicate'; state: StreamState }
  | { landed: false; reason: 'off' | 'no-address' | 'malformed' | 'row-missing' | 'row-refused' | 'channel-mismatch'; state?: StreamState };

export interface TopicRowCarrierDeps {
  store: TopicRowWatermarkStore;
  topicMemory: () => TopicMemory | null | undefined;
  writer: TopicRowWriter;
  /** `contextBudget.enabled` resolved live through the development-agent gate. */
  enabled: () => boolean;
  /** Slack's synthetic topic id for a channel (deterministic: the same on every machine). */
  slackTopicId: (channelId: string) => number;
  /** A gap was seen: the pull coordinator fetches it. Fire-and-forget. */
  onGap?: (topicId: number, gap: StreamGap) => void;
  report?: (e: { what: string; detail: string }) => void;
}

/** The serve side of one `topic-row-pull` (bounded). */
export type TopicRowPullResponse =
  | { ok: true; mode: 'seq'; stream: string; head: number; rows: Array<{ seq: number; row: CarriedRowBody | null }> }
  | { ok: true; mode: 'ids'; rows: CarriedRowBody[] }
  | { ok: true; mode: 'recent'; rows: CarriedRowBody[]; streams: StreamState[]; own: { stream: string; head: number } }
  | { ok: false; reason: string };

export class TopicRowCarrier {
  constructor(private readonly d: TopicRowCarrierDeps) {}

  enabled(): boolean {
    try { return this.d.enabled() === true; } catch {
      // @silent-fallback-ok — an unreadable switch reads as OFF: no rows carried, and topicRowsPresent stays false
      return false;
    }
  }

  address(sessionKey: string, messageId: string): RowAddress | null {
    return rowAddressFor(sessionKey, messageId, this.d.slackTopicId);
  }

  /** This machine's TopicMemory topic id for a routing key (Telegram topic or Slack conversation), or null. */
  topicIdFor(sessionKey: string): number | null {
    return rowAddressFor(sessionKey, '1', this.d.slackTopicId)?.topicId ?? null;
  }

  streamId(): string { return this.d.store.streamId(); }

  /**
   * Sender side: the carried row for a message this machine forwards (null when
   * off or not a row channel). The seq is idempotent per message, so a retry or
   * a drain carries the same number.
   */
  carry(sessionKey: string, messageId: string): CarriedRow | null {
    if (!this.enabled()) return null;
    const addr = this.address(sessionKey, messageId);
    if (!addr) return null;
    try {
      const seq = this.d.store.assignSeq(watermarkKey(addr.topicId), addr.channelMessageId);
      return { v: 1, stream: this.d.store.streamId(), seq, row: this.readRow(addr) };
    } catch (err) { // @silent-fallback-ok — reported via this.report (DegradationReporter); the owner records the message as expected, so its precondition reads the row missing
      this.report('TopicRowCarrier.carry', `could not number the row for ${sessionKey}/${messageId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Owner side: land a forwarded message's row (before the receipt). Records
   * the message as expected, with the machine that sent it, even when no row was
   * carried (an older peer), so the precondition reads it and the sweep can fetch
   * it. A carried stream must belong to the signed sender. Never throws.
   */
  land(sessionKey: string, messageId: string, rawRow: unknown, sender?: string): LandResult {
    if (!this.enabled()) return { landed: false, reason: 'off' };
    const addr = this.address(sessionKey, messageId);
    if (!addr) return { landed: false, reason: 'no-address' };
    const key = watermarkKey(addr.topicId);
    try {
      this.d.store.expectRow(key, addr.channelMessageId, sender ?? null);
      if (rawRow === undefined || rawRow === null) return { landed: false, reason: 'row-missing' };
      const carried = parseCarriedRow(rawRow);
      if (!carried || (sender !== undefined && streamMachine(carried.stream) !== sender)) {
        this.report('TopicRowCarrier.land', `a carried row for ${sessionKey}/${messageId} failed validation`);
        return { landed: false, reason: 'malformed' };
      }
      if (carried.row && (carried.row.channel !== addr.channel || carried.row.channelMessageId !== addr.channelMessageId)) {
        this.report('TopicRowCarrier.land', `a carried row for ${sessionKey}/${messageId} names a different message`);
        return { landed: false, reason: 'channel-mismatch', state: this.recordSeq(addr.topicId, carried.stream, carried.seq, null) };
      }
      return this.landSeq(addr.topicId, carried.stream, carried.seq, carried.row);
    } catch (err) {
      this.report('TopicRowCarrier.land', `could not land the row for ${sessionKey}/${messageId}: ${err instanceof Error ? err.message : String(err)}`);
      return { landed: false, reason: 'row-refused' };
    }
  }

  /** Land one seq's row (from a carried message or a pull). */
  landSeq(topicId: number, stream: string, seq: number, row: CarriedRowBody | null): LandResult {
    if (!row) return { landed: false, reason: 'row-missing', state: this.recordSeq(topicId, stream, seq, null) };
    const w = this.writeRow(topicId, row);
    if (!w) return { landed: false, reason: 'row-refused', state: this.recordSeq(topicId, stream, seq, null) };
    return { landed: true, outcome: w.outcome, state: this.recordSeq(topicId, stream, seq, w.rowKey) };
  }

  /**
   * Mark seqs `from..to` of a stream unrecoverable (visible, counted): every seq
   * whose row is not in TopicMemory, including a landed row a rebuild lost. A seq
   * whose row is present is left as it is.
   */
  abandonSeqs(topicId: number, stream: string, from: number, to: number): StreamState {
    const key = watermarkKey(topicId);
    const tm = this.d.topicMemory();
    const landed = this.d.store.landedEntries(key).filter((l) => l.stream === stream && l.seq >= from && l.seq <= to);
    const present = tm && tm.isReady() ? tm.presentMessageKeys(topicId, landed.map((l) => l.rowKey)) : new Set<number>();
    const keep = new Set(landed.filter((l) => present.has(l.rowKey)).map((l) => l.seq));
    const seqs: number[] = [];
    for (let q = from; q <= to; q++) if (!keep.has(q)) seqs.push(q);
    return this.d.store.abandonSeqList(key, stream, seqs);
  }

  /** Land a row that has no seq (a by-id or recent pull). */
  landUnsequenced(topicId: number, row: CarriedRowBody): boolean {
    return this.writeRow(topicId, row) !== null;
  }

  /**
   * What a topic is missing on this machine (read-only; the sweep repairs it):
   * a pending move pull, stream gaps, landed seqs whose row is no longer in
   * TopicMemory (a rebuild), and accepted messages whose row is absent.
   */
  missing(topicId: number): {
    movePending: boolean;
    gaps: StreamGap[];
    lostLanded: Array<{ stream: string; seq: number }>;
    expectedAbsent: Array<{ channelMessageId: string; source: string | null; attempts: number }>;
  } {
    const key = watermarkKey(topicId);
    const tm = this.d.topicMemory();
    const out = { movePending: this.d.store.movePending(key) !== null, gaps: this.d.store.gaps(key), lostLanded: [] as Array<{ stream: string; seq: number }>, expectedAbsent: [] as Array<{ channelMessageId: string; source: string | null; attempts: number }> };
    if (!tm || !tm.isReady()) return out;
    const landed = this.d.store.landedEntries(key);
    const present = tm.presentMessageKeys(topicId, landed.map((l) => l.rowKey));
    for (const l of landed) if (!present.has(l.rowKey)) out.lostLanded.push({ stream: l.stream, seq: l.seq });
    const expected = this.d.store.expectedEntries(key).filter((e) => !e.abandoned);
    const presentIds = tm.presentChannelIds(topicId, expected.map((e) => e.channelMessageId));
    for (const e of expected) if (!presentIds.has(e.channelMessageId)) out.expectedAbsent.push({ channelMessageId: e.channelMessageId, source: e.source, attempts: e.attempts });
    return out;
  }

  /**
   * Fold precondition (§14): this machine's TopicMemory holds the topic's rows up
   * to its last message id. True only when the carrier is on, TopicMemory is
   * open and holds rows for the topic, no move pull is pending, every stream is
   * contiguous to its highest known seq, every retained landed row is really in
   * TopicMemory, and every accepted message's row is present.
   */
  rowsPresent(topicKey: string): boolean {
    if (!this.enabled() || !/^-?\d+$/.test(topicKey)) return false;
    const topicId = Number(topicKey);
    if (!Number.isSafeInteger(topicId) || topicId === 0) return false;
    try {
      const tm = this.d.topicMemory();
      if (!tm || !tm.isReady() || tm.getMessageCount(topicId) === 0) return false;
      const m = this.missing(topicId);
      return !m.movePending && m.gaps.length === 0 && m.lostLanded.length === 0 && m.expectedAbsent.length === 0;
    } catch {
      // @silent-fallback-ok — an unreadable store or TopicMemory reads as rows missing: the fold refuses rows-missing
      return false;
    }
  }

  /** The watermark state of a topic (for status reads and tests). */
  status(topicId: number): { streams: StreamState[]; gaps: StreamGap[]; floored: StreamState[]; abandoned: number; movePending: boolean } {
    const key = watermarkKey(topicId);
    const streams = this.d.store.streams(key);
    return { streams, gaps: this.d.store.gaps(key), floored: streams.filter((s) => s.floor > 0), abandoned: this.d.store.abandonedCount(key), movePending: this.d.store.movePending(key) !== null };
  }

  // ── Pull (serve side) ───────────────────────────────────────

  /**
   * Serve `topic-row-pull`. Seq mode: rows this machine carried in its own stream;
   * recent mode: its recent rows and stream heads (a topic move); ids mode: its
   * rows for named channel message ids (an accepted message nobody carried).
   */
  servePull(cmd: { topic?: unknown; mode?: unknown; stream?: unknown; fromSeq?: unknown; toSeq?: unknown; limit?: unknown; ids?: unknown }): TopicRowPullResponse {
    if (!this.enabled()) return { ok: false, reason: 'disabled' };
    const topicId = cmd.topic;
    if (typeof topicId !== 'number' || !Number.isSafeInteger(topicId)) return { ok: false, reason: 'malformed' };
    const ch = rowChannelForTopicId(topicId);
    if (ch !== 'telegram' && ch !== 'slack') return { ok: false, reason: 'not-a-row-channel' };
    const channel: CarriedChannel = ch;
    const tm = this.d.topicMemory();
    if (!tm || !tm.isReady()) return { ok: false, reason: 'no-topic-memory' };
    const key = watermarkKey(topicId);
    if (cmd.mode === 'seq') {
      if (cmd.stream !== this.d.store.streamId()) return { ok: false, reason: 'not-my-stream' };
      const from = typeof cmd.fromSeq === 'number' && Number.isSafeInteger(cmd.fromSeq) ? Math.max(1, cmd.fromSeq) : NaN;
      const to = typeof cmd.toSeq === 'number' && Number.isSafeInteger(cmd.toSeq) ? cmd.toSeq : NaN;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return { ok: false, reason: 'malformed' };
      const bounded = Math.min(to, from + ROW_PULL_MAX_ROWS - 1);
      const rows = takeWithinBytes(this.d.store.outboundSeqs(key, from, bounded).map(({ seq, messageId }) => {
        const m = tm.getMessageByChannelId(topicId, messageId);
        return { seq, row: m ? rowBodyFrom(m, channel, messageId) : null };
      }), 'front');
      return { ok: true, mode: 'seq', stream: this.d.store.streamId(), head: this.d.store.outboundHead(key), rows };
    }
    if (cmd.mode === 'recent') {
      const asked = typeof cmd.limit === 'number' && Number.isFinite(cmd.limit) ? Math.floor(cmd.limit) : ROW_PULL_MAX_ROWS;
      const limit = Math.max(1, Math.min(asked, ROW_PULL_MAX_ROWS));
      const rows = takeWithinBytes(tm.getRecentMessages(topicId, limit)
        .filter((m) => typeof m.channelMessageId === 'string' && m.channelMessageId.length > 0)
        .map((m) => rowBodyFrom(m, channel, m.channelMessageId as string)), 'back');
      return { ok: true, mode: 'recent', rows, streams: this.d.store.streams(key), own: { stream: this.d.store.streamId(), head: this.d.store.outboundHead(key) } };
    }
    if (cmd.mode === 'ids') {
      if (!Array.isArray(cmd.ids) || cmd.ids.length === 0) return { ok: false, reason: 'malformed' };
      const ids = cmd.ids.slice(0, ROW_PULL_MAX_ROWS).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256);
      const rows = takeWithinBytes(ids.map((id) => {
        const m = tm.getMessageByChannelId(topicId, id);
        return m ? rowBodyFrom(m, channel, id) : null;
      }).filter((r): r is CarriedRowBody => r !== null), 'front');
      return { ok: true, mode: 'ids', rows };
    }
    return { ok: false, reason: 'malformed' };
  }

  // ── Pull (apply side) ───────────────────────────────────────

  /**
   * Land a seq pull's rows. Returns the seqs it landed, and the asked seqs the
   * stream's machine answered with no row (or did not return at all).
   */
  applySeqPull(topicId: number, stream: string, res: unknown, asked?: { from: number; to: number }): { landed: number; rowless: number[] } {
    const r = res as { ok?: unknown; mode?: unknown; stream?: unknown; rows?: unknown };
    const out = { landed: 0, rowless: [] as number[] };
    if (!r || r.ok !== true || r.mode !== 'seq' || r.stream !== stream || !Array.isArray(r.rows)) return out;
    const answered = new Set<number>();
    let maxAnswered = 0;
    for (const e of r.rows.slice(0, ROW_PULL_MAX_ROWS)) {
      const seq = (e as { seq?: unknown })?.seq;
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) continue;
      const rawRow = (e as { row?: unknown }).row;
      const row = rawRow === null ? null : parseCarriedRowBody(rawRow);
      if (rawRow !== null && !row) continue;
      answered.add(seq);
      maxAnswered = Math.max(maxAnswered, seq);
      if (!row) { out.rowless.push(seq); continue; }
      if (this.landSeq(topicId, stream, seq, row).landed) out.landed++;
    }
    // Seqs inside the answered span the stream never assigned are rowless too (a byte-cut answer stops early, so only its span counts).
    if (asked) for (let q = asked.from; q <= Math.min(asked.to, maxAnswered); q++) if (!answered.has(q)) out.rowless.push(q);
    return out;
  }

  /**
   * Land a recent pull (topic move): the previous owner's rows, and its stream
   * heads as known seqs, so a stream it held that this machine has not seen is a
   * visible gap until it is pulled. This machine's own stream is skipped (its rows are local).
   */
  applyRecentPull(topicId: number, res: unknown): { ok: boolean; landed: number; streams: number } {
    const r = res as { ok?: unknown; mode?: unknown; rows?: unknown; streams?: unknown; own?: unknown };
    if (!r || r.ok !== true || r.mode !== 'recent' || !Array.isArray(r.rows)) return { ok: false, landed: 0, streams: 0 };
    let landed = 0;
    for (const raw of r.rows.slice(-ROW_PULL_MAX_ROWS)) {
      const row = parseCarriedRowBody(raw);
      if (row && this.writeRow(topicId, row)) landed++;
    }
    const key = watermarkKey(topicId);
    const mine = this.d.store.streamId();
    const heads: Array<{ stream: string; head: number }> = [];
    if (Array.isArray(r.streams)) {
      for (const s of r.streams.slice(0, 64)) {
        const st = s as { stream?: unknown; maxSeen?: unknown };
        if (isStreamId(st.stream) && typeof st.maxSeen === 'number' && Number.isSafeInteger(st.maxSeen) && st.maxSeen > 0) heads.push({ stream: st.stream, head: st.maxSeen });
      }
    }
    const own = r.own as { stream?: unknown; head?: unknown } | undefined;
    if (own && isStreamId(own.stream) && typeof own.head === 'number' && Number.isSafeInteger(own.head) && own.head > 0) heads.push({ stream: own.stream, head: own.head });
    let streams = 0;
    for (const h of heads) {
      if (h.stream === mine) continue;
      this.d.store.noteHead(key, h.stream, h.head);
      streams++;
    }
    for (const g of this.d.store.gaps(key)) this.fireGap(topicId, g);
    return { ok: true, landed, streams };
  }

  /** Land an ids pull. Returns the ids that landed. */
  applyIdsPull(topicId: number, res: unknown): Set<string> {
    const r = res as { ok?: unknown; mode?: unknown; rows?: unknown };
    const out = new Set<string>();
    if (!r || r.ok !== true || r.mode !== 'ids' || !Array.isArray(r.rows)) return out;
    for (const raw of r.rows.slice(0, ROW_PULL_MAX_ROWS)) {
      const row = parseCarriedRowBody(raw);
      if (row && this.writeRow(topicId, row)) out.add(row.channelMessageId);
    }
    return out;
  }

  // ── internals ───────────────────────────────────────────────

  private readRow(addr: RowAddress): CarriedRowBody | null {
    const tm = this.d.topicMemory();
    if (!tm || !tm.isReady()) return null;
    const m = tm.getMessageByChannelId(addr.topicId, addr.channelMessageId);
    if (!m) return null;
    const body = rowBodyFrom(m, addr.channel, addr.channelMessageId);
    // Bounded on the wire: a row over the cap is carried as missing (a visible gap), never truncated.
    return body.text.length > CARRIED_TEXT_MAX ? null : body;
  }

  private writeRow(topicId: number, row: CarriedRowBody): { outcome: 'inserted' | 'adopted' | 'duplicate'; rowKey: number } | null {
    if (rowChannelForTopicId(topicId) !== row.channel) return null;
    const identity = identityOf(row);
    if (!identity) return null;
    const { channel: _c, channelMessageId: _id, ...rest } = row;
    const body: RowBody = { topicId, ...rest, sessionName: rest.sessionName ?? null };
    const r = this.d.writer.writeRow(identity, body);
    return r.written ? { outcome: r.outcome, rowKey: r.key.messageId } : null;
  }

  private recordSeq(topicId: number, stream: string, seq: number, rowKey: number | null): StreamState {
    const key = watermarkKey(topicId);
    const st = this.d.store.recordInbound(key, stream, seq, rowKey);
    if (st.maxSeen > st.contiguous) this.fireGap(topicId, { stream, from: st.contiguous + 1, to: st.maxSeen });
    return st;
  }

  private fireGap(topicId: number, gap: StreamGap): void {
    try { this.d.onGap?.(topicId, gap); } catch {
      // @silent-fallback-ok — the gap stays on the watermark (the precondition reads it); the sweep retries the pull
    }
  }

  report(what: string, detail: string): void {
    try {
      if (this.d.report) { this.d.report({ what, detail }); return; }
      DegradationReporter.getInstance().report({
        feature: what,
        primary: "Carry each forwarded message's TopicMemory row to the conversation's owner",
        fallback: 'The row is missing on the owner; its watermark holds and the conversation does not fold until the row is pulled or marked unrecoverable',
        reason: detail,
        impact: 'A message is missing from the owner\'s conversation memory.',
      });
    } catch {
      // @silent-fallback-ok — reporting never throws into a delivery path
    }
  }
}

/** Keep rows within the response byte cap, measuring each row once. `front` keeps the first rows, `back` the last. */
function takeWithinBytes<T>(rows: T[], keep: 'front' | 'back'): T[] {
  const ordered = keep === 'front' ? rows : [...rows].reverse();
  const out: T[] = [];
  let bytes = 2;
  for (const r of ordered) {
    const n = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (bytes + n > ROW_PULL_MAX_BYTES) break;
    bytes += n;
    out.push(r);
  }
  return keep === 'front' ? out : out.reverse();
}

/** One signed pull to a peer. Null = unreachable, or the verb is unknown there. */
export type SendRowPull = (machineId: string, cmd: { type: 'topic-row-pull'; topic: number; mode: 'seq' | 'recent' | 'ids'; stream?: string; fromSeq?: number; toSeq?: number; limit?: number; ids?: string[] }) => Promise<unknown | null>;

/** How many pulls a missing row or a pending move gets before it is marked unrecoverable (visibly). */
export const ROW_PULL_MAX_ATTEMPTS = 5;

/**
 * Pull coordinator: fills gaps from the stream's machine, pulls a moved topic's
 * rows from its previous owner, fetches accepted rows nobody carried from the
 * machine that sent them, and repairs rows a TopicMemory rebuild lost. One pull in
 * flight per (topic, stream), with a cooldown; `sweep()` retries everything open
 * on a timer, so nothing waits for the next message. A gap wider than one pull is
 * cut at a visible floor; a seq or id no machine can supply after
 * `ROW_PULL_MAX_ATTEMPTS` (or a stream its machine no longer holds) is marked
 * abandoned, counted and reported, so a topic never stays stuck without a state.
 */
export class TopicRowPullCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly lastTry = new Map<string, number>();
  private readonly rowlessAttempts = new Map<string, number>();
  private readonly accepted = new Set<string>();
  private sweepCursor = 0;

  constructor(private readonly d: {
    carrier: TopicRowCarrier;
    store: TopicRowWatermarkStore;
    selfMachineId: string;
    send: SendRowPull;
    maxRows?: number;
    cooldownMs?: number;
    now?: () => number;
    log?: (line: string) => void;
    reportFloor?: (e: { topicId: number; stream: string; floor: number }) => void;
    /** The topic's previous owner, when an acquire seam could not name it (e.g. from the placement journal). */
    prevOwnerOf?: (topicId: number) => string | null;
  }) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /**
   * A forwarded message for this topic was accepted here at this ownership epoch.
   * The first one per (topic, epoch) is the topic's arrival: mark the move pending
   * (durably) and pull the previous owner's rows.
   */
  onTopicAccepted(topicId: number, epoch: number = 0, prevOwner?: string | null): void {
    const k = `${topicId}\u0000${epoch}`;
    if (this.accepted.has(k)) return;
    this.accepted.add(k);
    let prev: string | null = prevOwner ?? null;
    if (!prev) { try { prev = this.d.prevOwnerOf?.(topicId) ?? null; } catch { /* @silent-fallback-ok — no previous owner known: a new topic, or journal lag; gap and id pulls still run */ } }
    void this.onTopicAcquired(topicId, prev, epoch);
  }

  /** A topic moved here (any acquire seam): pull the previous owner's rows, then fill every gap. */
  async onTopicAcquired(topicId: number, prevOwner: string | null, epoch: number = 0): Promise<{ landed: number; gapsFilled: number }> {
    this.accepted.add(`${topicId}\u0000${epoch}`);
    const key = watermarkKey(topicId);
    if (prevOwner && prevOwner !== this.d.selfMachineId) this.d.store.markMovePending(key, prevOwner, epoch);
    const landed = await this.runMovePull(topicId);
    let gapsFilled = 0;
    for (const g of this.d.store.gaps(key)) gapsFilled += await this.onGap(topicId, g);
    return { landed, gapsFilled };
  }

  /** Run (or retry) a pending move pull. Clears the marker only on a real answer; gives up visibly after the attempt budget. */
  async runMovePull(topicId: number): Promise<number> {
    const key = watermarkKey(topicId);
    const p = this.d.store.movePending(key);
    if (!p || p.nextAt > this.now()) return 0;
    const k = `move\u0000${topicId}`;
    if (this.inFlight.has(k)) return 0;
    this.inFlight.add(k);
    try {
      let res: unknown | null = null;
      try {
        res = await this.d.send(p.prevOwner, { type: 'topic-row-pull', topic: topicId, mode: 'recent', limit: this.d.maxRows ?? ROW_PULL_MAX_ROWS });
      } catch (err) { // @silent-fallback-ok — logged; the move stays pending (the precondition holds) and the sweep retries, then gives up with a report
        this.d.log?.(`[row-carrier] move pull for topic ${topicId} from ${p.prevOwner} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const applied = res !== null ? this.d.carrier.applyRecentPull(topicId, res) : { ok: false, landed: 0 };
      if (applied.ok) { this.d.store.clearMovePending(key); return applied.landed; }
      const attempts = this.d.store.noteMoveAttempt(key, this.now() + Math.min(30 * 60_000, 30_000 * 2 ** p.attempts));
      if (attempts >= ROW_PULL_MAX_ATTEMPTS) {
        this.d.store.clearMovePending(key);
        this.d.carrier.report('TopicRowCarrier.movePull', `conversation ${topicId}: the previous owner ${p.prevOwner} never answered the row pull (${attempts} tries); its rows that no stream carried may be missing here`);
      }
      return 0;
    } finally {
      this.inFlight.delete(k);
    }
  }

  /** Fill a gap (or re-fetch lost seqs). Loops while a byte-cut answer makes progress. */
  async onGap(topicId: number, gap: StreamGap): Promise<number> {
    const machine = streamMachine(gap.stream);
    if (!machine || machine === this.d.selfMachineId) return 0;
    const k = `${topicId}\u0000${gap.stream}`;
    const now = this.now();
    if (this.inFlight.has(k) || now - (this.lastTry.get(k) ?? -Infinity) < (this.d.cooldownMs ?? 30_000)) return 0;
    this.inFlight.add(k);
    this.lastTry.set(k, now);
    const key = watermarkKey(topicId);
    let total = 0;
    try {
      const max = Math.max(1, this.d.maxRows ?? ROW_PULL_MAX_ROWS);
      let from = gap.from;
      if (gap.to - from + 1 > max) {
        from = gap.to - max + 1;
        this.d.store.setFloor(key, gap.stream, from - 1);
        try { this.d.reportFloor?.({ topicId, stream: gap.stream, floor: from - 1 }); } catch { /* @silent-fallback-ok — the floor is on the watermark state */ }
      }
      for (let round = 0; round < 8 && from <= gap.to; round++) {
        const res = await this.d.send(machine, { type: 'topic-row-pull', topic: topicId, mode: 'seq', stream: gap.stream, fromSeq: from, toSeq: gap.to });
        if (res === null) { this.d.log?.(`[row-carrier] gap pull for topic ${topicId} from ${machine} got no answer`); break; }
        const reason = (res as { ok?: unknown; reason?: unknown }).ok === false ? (res as { reason?: unknown }).reason : null;
        if (reason === 'not-my-stream') {
          // The machine no longer holds that stream (its carrier database was replaced): those seqs are unrecoverable.
          this.d.carrier.abandonSeqs(topicId, gap.stream, from, gap.to);
          this.d.carrier.report('TopicRowCarrier.pull', `conversation ${topicId}: ${machine} no longer holds stream ${gap.stream}; seqs ${from}..${gap.to} are marked unrecoverable`);
          break;
        }
        const applied = this.d.carrier.applySeqPull(topicId, gap.stream, res, { from, to: gap.to });
        total += applied.landed;
        for (const seq of applied.rowless) this.noteRowless(topicId, gap.stream, seq);
        const st = this.d.store.streams(key).find((s) => s.stream === gap.stream);
        const answeredTo = Math.max(0, ...((res as { rows?: Array<{ seq?: number }> }).rows ?? []).map((e) => (typeof e?.seq === 'number' ? e.seq : 0)));
        if (!st || st.contiguous >= gap.to || answeredTo < from) break;
        from = answeredTo + 1;
      }
      return total;
    } catch (err) {
      this.d.log?.(`[row-carrier] gap pull for topic ${topicId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return total;
    } finally {
      this.inFlight.delete(k);
    }
  }

  private noteRowless(topicId: number, stream: string, seq: number): void {
    const k = `${topicId}\u0000${stream}\u0000${seq}`;
    const n = (this.rowlessAttempts.get(k) ?? 0) + 1;
    this.rowlessAttempts.set(k, n);
    if (n >= ROW_PULL_MAX_ATTEMPTS) {
      this.rowlessAttempts.delete(k);
      this.d.carrier.abandonSeqs(topicId, stream, seq, seq);
      this.d.carrier.report('TopicRowCarrier.pull', `conversation ${topicId}: ${streamMachine(stream)} has no row for seq ${seq} after ${n} pulls; marked unrecoverable`);
    }
  }

  /** Fetch accepted rows nobody carried (an older forwarder) from the machine that sent each one. */
  async pullMissingIds(topicId: number, entries: Array<{ channelMessageId: string; source: string | null }>): Promise<number> {
    const key = watermarkKey(topicId);
    const bySource = new Map<string, string[]>();
    for (const e of entries) {
      if (!e.source || e.source === this.d.selfMachineId) {
        // No machine to ask: count the try, and abandon visibly once the budget is spent.
        if (this.d.store.bumpExpectedAttempt(key, e.channelMessageId) >= ROW_PULL_MAX_ATTEMPTS) this.abandonId(topicId, e.channelMessageId, 'no machine to ask');
        continue;
      }
      const list = bySource.get(e.source) ?? [];
      list.push(e.channelMessageId);
      bySource.set(e.source, list);
    }
    let landed = 0;
    for (const [source, ids] of bySource) {
      const k = `ids\u0000${topicId}\u0000${source}`;
      const now = this.now();
      if (this.inFlight.has(k) || now - (this.lastTry.get(k) ?? -Infinity) < (this.d.cooldownMs ?? 30_000)) continue;
      this.inFlight.add(k);
      this.lastTry.set(k, now);
      try {
        const batch = ids.slice(0, ROW_PULL_MAX_ROWS);
        let got = new Set<string>();
        try {
          const res = await this.d.send(source, { type: 'topic-row-pull', topic: topicId, mode: 'ids', ids: batch });
          if (res !== null) got = this.d.carrier.applyIdsPull(topicId, res);
        } catch (err) {
          this.d.log?.(`[row-carrier] id pull for topic ${topicId} from ${source} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        landed += got.size;
        for (const id of batch) {
          if (got.has(id)) continue;
          if (this.d.store.bumpExpectedAttempt(key, id) >= ROW_PULL_MAX_ATTEMPTS) this.abandonId(topicId, id, `${source} has no row for it`);
        }
      } finally {
        this.inFlight.delete(k);
      }
    }
    return landed;
  }

  private abandonId(topicId: number, channelMessageId: string, why: string): void {
    this.d.store.abandonExpected(watermarkKey(topicId), channelMessageId);
    this.d.carrier.report('TopicRowCarrier.pull', `conversation ${topicId}: accepted message ${channelMessageId} has no recoverable row (${why}); marked unrecoverable`);
  }

  /**
   * The repair sweep (on a timer): a bounded batch of topics per pass, rotating.
   * Retries pending moves, open gaps, rows a rebuild lost, and accepted rows
   * nobody carried. Never throws.
   */
  async sweep(maxTopics: number = 25): Promise<{ topics: number; landed: number }> {
    let landed = 0;
    let keys: string[] = [];
    try {
      keys = this.d.store.topicsNeedingCheck(maxTopics, this.sweepCursor);
      this.sweepCursor = keys.length < maxTopics ? 0 : this.sweepCursor + keys.length;
    } catch { /* @silent-fallback-ok — an unreadable store skips this pass; the next pass retries */ return { topics: 0, landed: 0 }; }
    for (const key of keys) {
      const topicId = Number(key);
      if (!Number.isSafeInteger(topicId) || topicId === 0) continue;
      try {
        const m = this.d.carrier.missing(topicId);
        if (m.movePending) landed += await this.runMovePull(topicId);
        for (const g of m.gaps) landed += await this.onGap(topicId, g);
        // Rows a TopicMemory rebuild lost: re-fetch those seqs from their streams (contiguity already counts them).
        const byStream = new Map<string, number[]>();
        for (const l of m.lostLanded) { const a = byStream.get(l.stream) ?? []; a.push(l.seq); byStream.set(l.stream, a); }
        for (const [stream, seqs] of byStream) landed += await this.onGap(topicId, { stream, from: Math.min(...seqs), to: Math.max(...seqs) });
        if (m.expectedAbsent.length > 0) landed += await this.pullMissingIds(topicId, m.expectedAbsent);
      } catch (err) {
        this.d.log?.(`[row-carrier] sweep of conversation ${topicId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { topics: keys.length, landed };
  }
}
