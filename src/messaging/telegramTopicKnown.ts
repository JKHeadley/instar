/**
 * Whether this machine knows a Telegram topic well enough to act on it from the app.
 *
 * A topic is known when this machine has named it, bound it to a session, or holds
 * history for it in its message log. The app's history read serves any topic with
 * local history, so every write path (text send, file upload, pin, read marks,
 * "open session") uses this same rule. Before, the write paths checked only names
 * and sessions: a job topic named on another machine (the laptop) showed its full
 * history on the serving machine but every send into it was refused as
 * "This conversation no longer exists on the agent."
 */
export interface TelegramTopicSource {
  getAllTopicMappings(): Array<{ topicId: number }>;
  getTopicHistory?(topicId: number, limit?: number): unknown[];
}

export function telegramTopicKnown(tg: TelegramTopicSource, topicId: number): boolean {
  if (!Number.isSafeInteger(topicId) || topicId <= 0) return false;
  if (tg.getAllTopicMappings().some((m) => m.topicId === topicId)) return true;
  try {
    return (tg.getTopicHistory?.(topicId, 1) ?? []).length > 0;
  } catch {
    // @silent-fallback-ok — an unreadable log leaves the old rule (names and sessions only)
    return false;
  }
}
