import path from 'node:path';
import type { TopicMemory, TopicMessage } from '../memory/TopicMemory.js';
import { readJsonlTailLinesStrict } from '../utils/jsonl-tail.js';
import { coerceMessageProvenance, type MessageProvenance } from './shared/MessageProvenance.js';

type HistoryRow = Pick<TopicMessage, 'messageId' | 'topicId' | 'text' | 'fromUser' | 'timestamp'> & {
  provenance?: MessageProvenance;
};

/** Read one local cross-topic window. The live log supplies provenance on overlapping SQLite rows. */
export function readRecentTelegramHistory(
  stateDir: string,
  memory: TopicMemory | undefined | null,
  limit: number,
  marks?: Record<number, number>,
): HistoryRow[] {
  let lines: string[];
  try {
    lines = readJsonlTailLinesStrict(path.join(stateDir, 'telegram-messages.jsonl')).lines;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (!memory) throw new Error('Telegram history unavailable: message log missing and TopicMemory unavailable');
    return memory.getRecentTelegramMessages(limit, marks);
  }
  // A job reads the latest window. The sentinel historically caps NEW rows
  // across the bounded tail after applying its independent per-topic marks.
  const start = marks ? 0 : Math.max(0, lines.length - limit);
  const rows: HistoryRow[] = [];
  for (let i = lines.length - 1; i >= start && rows.length < limit; i--) {
    try {
      const row = JSON.parse(lines[i]);
      const topicId = row.topicId ?? row.channelId;
      if (!Number.isSafeInteger(row.messageId) || row.messageId <= 0 || typeof row.text !== 'string' || !row.text) continue;
      if (!Number.isSafeInteger(topicId) || topicId <= 0) continue;
      if (marks && row.messageId <= (marks[topicId] ?? 0)) continue;
      rows.push({
        messageId: row.messageId, topicId, text: row.text, fromUser: row.fromUser === true,
        timestamp: row.timestamp, provenance: coerceMessageProvenance(row.provenance),
      });
    } catch {
      // @silent-fallback-ok — skip malformed legacy lines independently.
    }
  }
  rows.reverse();
  if (!memory?.isReady()) return rows;

  // The local store also receives carried rows. A failed dual write can leave
  // a row only in the log. Use the same composite identity as TopicMemory.
  const byId = new Map<string, HistoryRow>();
  for (const row of [...memory.getRecentTelegramMessages(limit, marks), ...rows]) {
    const key = `${row.topicId}/${row.messageId}`;
    byId.set(key, { ...row, provenance: row.provenance ?? byId.get(key)?.provenance });
  }
  return [...byId.values()].sort((a, b) => a.messageId - b.messageId).slice(-limit);
}
