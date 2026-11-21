/**
 * Telegram rows for the app's conversation list (docs/specs/main-loop-freeze-conversation-list.md).
 *
 * The list used to call `getTopicHistory(topicId, 1)` once per topic. For a topic
 * without a live session that is a synchronous read of the whole Telegram message
 * log, so a list of a few hundred topics froze the server for 20-30 s at a time
 * (Echo Studio, 2026-11-21). This producer never reads the log: it takes every
 * topic's newest entry from the adapter's in-memory index in one call, and fills
 * any topic it has no entry for (index warming up, or the topic's lines rotated out)
 * from the indexed TopicMemory store (one indexed lookup per such topic), or leaves
 * the preview empty when that store is not open.
 */

export interface TelegramListEntry {
  timestamp?: string;
  text?: unknown;
}

export interface TelegramListRowsDeps {
  mappings: () => Array<{ topicId: number; topicName: string | null }>;
  /** The adapter's non-blocking newest-entry read. */
  lastEntries: (topicIds: number[]) => { entries: Map<number, TelegramListEntry>; complete: boolean };
  /** The indexed store's newest row for a topic; null when it is not open. */
  indexedLast?: (() => ((topicId: number) => TelegramListEntry | undefined) | null) | null;
  displayName: (topicId: number, topicName: string | null) => string | null;
  previewText: (text: string) => string;
}

export interface TelegramListRow {
  topicId: number;
  topicName: string | null;
  lastActivity: string | null;
  lastPreview: string | null;
}

export function buildTelegramListRows(deps: TelegramListRowsDeps): TelegramListRow[] {
  const mappings = deps.mappings();
  const { entries } = deps.lastEntries(mappings.map((m) => m.topicId));
  // A topic the adapter has no entry for — the index still warming up, or every line of it
  // rotated out of the log — is filled from the indexed store, so its preview never flips
  // between warm-up and steady state. One index seek per missing topic.
  const missing = mappings.some((m) => !entries.has(m.topicId));
  const indexed = missing ? (deps.indexedLast?.() ?? null) : null;
  return mappings.map((m) => {
    let last = entries.get(m.topicId);
    if (!last && indexed) {
      try { last = indexed(m.topicId); } catch { /* @silent-fallback-ok — an unreadable store row only leaves this preview empty */ }
    }
    return {
      topicId: m.topicId,
      topicName: deps.displayName(m.topicId, m.topicName),
      lastActivity: typeof last?.timestamp === 'string' ? last.timestamp : null,
      lastPreview: typeof last?.text === 'string' ? deps.previewText(last.text).slice(0, 140) : null,
    };
  });
}

/** The adapter surface the unread source needs (a real TelegramAdapter satisfies it). */
export interface TelegramTailReader<Row> {
  getCachedTopicHistory(topicId: number, limit: number): Row[] | null;
  warmTopicTails(topicIds: Iterable<number>): Promise<void>;
}

/**
 * The unread counter's Telegram history read for the conversation list: the in-memory tail only.
 * A topic whose tail is not loaded answers null (count unknown for this request) and is queued for
 * one background streamed load, so the next list has its count. The old wiring called
 * getTopicHistory, which reads the whole log synchronously for an unloaded topic — the same freeze
 * as the list's previews, on the unread pass.
 */
export function cachedTelegramHistory<Row>(telegram: TelegramTailReader<Row>): (topicId: number, limit: number) => Row[] | null {
  return (topicId, limit) => {
    const rows = telegram.getCachedTopicHistory(topicId, limit);
    if (rows === null) void telegram.warmTopicTails([topicId]);
    return rows;
  };
}
