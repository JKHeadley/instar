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
