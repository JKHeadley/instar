/**
 * ForwardedTopicContext — build the prior-conversation context block for a session
 * that has just been MOVED to this machine by the multi-machine session pool (§L4).
 *
 * Why this exists (bug #2): when a topic is moved to a standby, the standby spawns the
 * session locally but its OWN message ledger for that topic is EMPTY (it never polled
 * the topic) and its TopicMemory has no rows — so `spawnSessionForTopic` builds an
 * empty context and the moved conversation starts with amnesia. The router (which DID
 * hold the conversation) is the source of truth; the receiver fetches the recent
 * history from it and formats it here into the same "Thread History" block the
 * single-machine JSONL path produces, so the moved session continues the conversation
 * instead of starting blank.
 *
 * Pure + caller-agnostic so it is unit-testable without a live two-machine setup.
 */

/** One historical message, matching TelegramAdapter.getTopicHistory()'s shape. */
export interface ForwardedHistoryMessage {
  fromUser: boolean;
  text?: string;
  senderName?: string;
  timestamp?: string | number;
}

/**
 * Format fetched router-side history into a Thread History context block, or '' when
 * there is nothing to inject. Mirrors the single-machine JSONL formatting in
 * spawnSessionForTopic so a moved session reads identically to a local one.
 */
export function formatForwardedTopicContext(
  messages: ForwardedHistoryMessage[] | null | undefined,
  topicName?: string,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const lines: string[] = [];
  lines.push(`--- Thread History (last ${messages.length} messages, relayed from the previous machine) ---`);
  lines.push(`IMPORTANT: Read this history carefully before taking any action.`);
  lines.push(`Your task is to continue THIS conversation, not start something new.`);
  if (topicName) lines.push(`Topic: ${topicName}`);
  lines.push('');
  for (const m of messages) {
    const sender = m.fromUser ? (m.senderName || 'User') : 'Agent';
    let ts = '??:??';
    if (m.timestamp != null) {
      const d = new Date(m.timestamp);
      if (!Number.isNaN(d.getTime())) ts = d.toISOString().slice(11, 19);
    }
    const text = (m.text || '').slice(0, 2000);
    lines.push(`[${ts}] ${sender}: ${text}`);
  }
  lines.push('');
  lines.push('--- End Thread History ---');
  return lines.join('\n');
}
