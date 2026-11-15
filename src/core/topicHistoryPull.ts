/**
 * Moved-conversation history over the signed mesh (default-on step 2).
 *
 * A session moved to this machine has no local history, so it asks the lease holder
 * for the recent messages. That ask used to send this machine's own bearer token,
 * which a holder refuses when the agent's machines were joined with different tokens;
 * the session then started blank. The signed `topic-history-pull` verb needs no shared
 * token. The bearer call stays as the fallback for a holder that does not know the verb.
 */

import type { ForwardedHistoryMessage } from './ForwardedTopicContext.js';
import { cutUtf8, newestWithinCap, ROW_ENVELOPE_BYTES } from './oversizedRow.js';

/** The most messages one pull returns, matching what the moved session's context uses. */
export const TOPIC_HISTORY_PULL_MAX_MESSAGES = 50;
/** Per-message text cap. The context block keeps no more than this. */
export const TOPIC_HISTORY_PULL_MAX_TEXT = 2000;
/** Whole-response cap. The oldest messages go first when a page would exceed it. */
export const TOPIC_HISTORY_PULL_MAX_BYTES = 256 * 1024;
export const TOPIC_HISTORY_PULL_TIMEOUT_MS = 5000;

export type TopicHistoryPullResponse =
  | { ok: true; messages: ForwardedHistoryMessage[] }
  | { ok: false; reason: string };

/** Keep only the fields the context block reads, so a peer gets nothing else from a log row. */
function shapeMessage(raw: unknown): ForwardedHistoryMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.fromUser !== 'boolean') return null;
  const out: ForwardedHistoryMessage = { fromUser: m.fromUser };
  if (typeof m.text === 'string') out.text = m.text.slice(0, TOPIC_HISTORY_PULL_MAX_TEXT);
  if (typeof m.senderName === 'string') out.senderName = m.senderName;
  if (typeof m.timestamp === 'string' || typeof m.timestamp === 'number') out.timestamp = m.timestamp;
  if (typeof m.authorship === 'string') out.authorship = m.authorship;
  if (typeof m.authorshipAgentId === 'string' || m.authorshipAgentId === null) out.authorshipAgentId = m.authorshipAgentId;
  return out;
}

function shapeMessages(raw: unknown): ForwardedHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-TOPIC_HISTORY_PULL_MAX_MESSAGES)
    .map(shapeMessage)
    .filter((m): m is ForwardedHistoryMessage => m !== null);
}

/** Serve side of the verb: this machine's own recent history for one topic. */
export function createTopicHistoryPullHandler(deps: {
  readHistory: ((topic: number, limit: number) => unknown[]) | null;
}): (cmd: { topic?: unknown; limit?: unknown }) => TopicHistoryPullResponse {
  return (cmd) => {
    if (!deps.readHistory) return { ok: false, reason: 'no-telegram' };
    const topic = cmd.topic;
    if (typeof topic !== 'number' || !Number.isSafeInteger(topic)) return { ok: false, reason: 'malformed' };
    const asked = typeof cmd.limit === 'number' && Number.isFinite(cmd.limit) ? Math.floor(cmd.limit) : TOPIC_HISTORY_PULL_MAX_MESSAGES;
    const limit = Math.max(1, Math.min(asked, TOPIC_HISTORY_PULL_MAX_MESSAGES));
    const messages = shapeMessages(deps.readHistory(topic, limit));
    while (messages.length > 0 && Buffer.byteLength(JSON.stringify({ ok: true, messages })) > TOPIC_HISTORY_PULL_MAX_BYTES) messages.shift();
    return { ok: true, messages };
  };
}

export interface MovedTopicHistoryDeps {
  /** Signed pull from the lease holder. Null when this machine is the holder or none is known. */
  signedPull: ((topic: number) => Promise<{ ok: boolean; result?: unknown } | null>) | null;
  /** The older bearer call, for a holder that does not know the verb. */
  bearerFetch: ((topic: number) => Promise<unknown[] | null>) | null;
  log?: (message: string) => void;
}

/**
 * Fetch a moved topic's history. Never throws: a move without history still starts,
 * and the log says so, because a blank start is the failure this exists to prevent.
 */
export async function pullMovedTopicHistory(
  deps: MovedTopicHistoryDeps,
  topic: number,
): Promise<{ messages: ForwardedHistoryMessage[]; via: 'signed' | 'bearer' | 'none' }> {
  try {
    const signed = await deps.signedPull?.(topic);
    const body = signed?.ok ? (signed.result as TopicHistoryPullResponse | undefined) : undefined;
    if (body?.ok === true && Array.isArray(body.messages)) return { messages: shapeMessages(body.messages), via: 'signed' };
  } catch (err) {
    deps.log?.(`signed history pull for topic ${topic} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const rows = await deps.bearerFetch?.(topic);
    if (rows) return { messages: shapeMessages(rows), via: 'bearer' };
  } catch (err) {
    deps.log?.(`bearer history fetch for topic ${topic} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (deps.signedPull || deps.bearerFetch) deps.log?.(`no history reached topic ${topic}; the moved session starts without it`);
  return { messages: [], via: 'none' };
}

// ── shape: 'pool' (native-conversation-any-machine-access §3d item 4) ──────────────────────────
//
// The pool History read of a topic used to ask each machine with this machine's own API token. The
// pool shape carries what that read carried, so it can replace it: whole rows (no text clip) with
// `messageId`, `eventId`, `provenance` and the origin join, pages of up to 100 rows, a 512 KiB answer
// cap, and the `before` / `beforeMessageId` cursor. The answer echoes `shape: 'pool'`, which is how
// an asking machine tells it from an older machine's default-shape answer.

/** The page of the bearer pool read this replaces. */
export const TOPIC_HISTORY_POOL_MAX_MESSAGES = 100;
/** The size at which the pool fan-out already rejects a peer's answer. */
export const TOPIC_HISTORY_POOL_MAX_BYTES = 512 * 1024;
export const TOPIC_HISTORY_POOL_TIMEOUT_MS = 5000;

export interface PoolHistoryQuery { topic: number; limit: number; before?: number; beforeMessageId?: number }

export interface PoolRowTruncated { row: string | number; totalBytes: number; from: number; to: number }

export type TopicHistoryPoolResponse =
  | {
      ok: true;
      shape: 'pool';
      messages: Array<Record<string, unknown>>;
      historyCursorVersion: 2;
      truncated?: true;
      /** With `truncated`: the oldest row returned, as the cursor for the next older page. */
      oldest?: { before: number; beforeMessageId?: number };
      rowTruncated?: PoolRowTruncated;
    }
  | { ok: false; reason: string; shape: 'pool' };

/** A history row's identity for a continuation: its event id, else its Telegram message id. */
export function poolRowId(m: Record<string, unknown>): string | number | null {
  if (typeof m.eventId === 'string' && m.eventId) return m.eventId;
  if (typeof m.messageId === 'number' && Number.isSafeInteger(m.messageId)) return m.messageId;
  return null;
}

function cursorOf(m: Record<string, unknown>): { before: number; beforeMessageId?: number } | undefined {
  const at = Date.parse(String(m.timestamp));
  if (!Number.isFinite(at)) return undefined;
  return { before: at, ...(typeof m.messageId === 'number' && Number.isSafeInteger(m.messageId) && m.messageId > 0 ? { beforeMessageId: m.messageId } : {}) };
}

export function createTopicHistoryPoolHandler(deps: {
  /** This machine's own rows for one topic page, oldest first (the plain local read with its origin join). */
  readPool: ((q: PoolHistoryQuery) => Promise<unknown[] | null>) | null;
  /** Removes this machine's own API token and PIN from a text, before anything is cut. */
  clean: (text: string) => string;
  maxBytes?: number;
}): (cmd: { topic?: unknown; limit?: unknown; before?: unknown; beforeMessageId?: unknown; row?: unknown; byteFrom?: unknown }) => Promise<TopicHistoryPoolResponse> {
  const maxBytes = deps.maxBytes ?? TOPIC_HISTORY_POOL_MAX_BYTES;
  return async (cmd) => {
    if (!deps.readPool) return { ok: false, reason: 'no-telegram', shape: 'pool' };
    const topic = cmd.topic;
    if (typeof topic !== 'number' || !Number.isSafeInteger(topic)) return { ok: false, reason: 'malformed', shape: 'pool' };
    const asked = typeof cmd.limit === 'number' && Number.isFinite(cmd.limit) ? Math.floor(cmd.limit) : TOPIC_HISTORY_POOL_MAX_MESSAGES;
    const limit = Math.max(1, Math.min(asked, TOPIC_HISTORY_POOL_MAX_MESSAGES));
    const q: PoolHistoryQuery = { topic, limit };
    if (cmd.before !== undefined) {
      if (typeof cmd.before !== 'number' || !Number.isSafeInteger(cmd.before) || cmd.before < 0) return { ok: false, reason: 'malformed', shape: 'pool' };
      q.before = cmd.before;
    }
    if (cmd.beforeMessageId !== undefined) {
      if (q.before === undefined || typeof cmd.beforeMessageId !== 'number' || !Number.isSafeInteger(cmd.beforeMessageId) || cmd.beforeMessageId <= 0) return { ok: false, reason: 'malformed', shape: 'pool' };
      q.beforeMessageId = cmd.beforeMessageId;
    }
    const raw = await deps.readPool(q);
    if (!raw) return { ok: false, reason: 'read-failed', shape: 'pool' };
    // Whole rows, redacted before anything is cut.
    const rows = raw.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map((m) => (typeof m.text === 'string' ? { ...m, text: deps.clean(m.text) } : { ...m }));
    const budget = Math.max(64, maxBytes - ROW_ENVELOPE_BYTES);
    if (cmd.row !== undefined) {
      // A continuation: the same page request plus the row and the byte to read from.
      if (typeof cmd.row !== 'string' && typeof cmd.row !== 'number') return { ok: false, reason: 'malformed', shape: 'pool' };
      const from = cmd.byteFrom === undefined ? 0 : cmd.byteFrom;
      if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) return { ok: false, reason: 'malformed', shape: 'pool' };
      // An id travels through a query string, so an all-digit event id and a message id compare as text.
      const row = rows.find((m) => { const id = poolRowId(m); return id !== null && String(id) === String(cmd.row); });
      if (!row || typeof row.text !== 'string') return { ok: false, reason: 'row-gone', shape: 'pool' };
      const cut = cutUtf8(row.text, from, budget);
      if (!cut) return { ok: false, reason: 'bad-byte-range', shape: 'pool' };
      const c = cursorOf(row);
      return { ok: true, shape: 'pool', messages: [{ ...row, text: cut.piece }], historyCursorVersion: 2, ...(c ? { oldest: c } : {}),
        rowTruncated: { row: poolRowId(row) ?? cmd.row, totalBytes: cut.totalBytes, from: cut.from, to: cut.to } };
    }
    const base = Buffer.byteLength(JSON.stringify({ ok: true, shape: 'pool', historyCursorVersion: 2, truncated: true, oldest: { before: 0, beforeMessageId: 0 } })) + 512;
    const { kept, dropped } = newestWithinCap(rows, maxBytes, base);
    if (kept.length === 0 && rows.length > 0) {
      // The newest row is alone larger than the cap: return it cut, with the way to read on.
      const newest = rows[rows.length - 1];
      const id = poolRowId(newest);
      const c = cursorOf(newest);
      if (id === null || typeof newest.text !== 'string') return { ok: false, reason: 'row-too-large', shape: 'pool' };
      const cut = cutUtf8(newest.text, 0, budget)!;
      return { ok: true, shape: 'pool', messages: [{ ...newest, text: cut.piece }], historyCursorVersion: 2, truncated: true, ...(c ? { oldest: c } : {}),
        rowTruncated: { row: id, totalBytes: cut.totalBytes, from: cut.from, to: cut.to } };
    }
    if (dropped > 0) {
      const c = cursorOf(kept[0]);
      return { ok: true, shape: 'pool', messages: kept, historyCursorVersion: 2, truncated: true, ...(c ? { oldest: c } : {}) };
    }
    return { ok: true, shape: 'pool', messages: rows, historyCursorVersion: 2 };
  };
}
